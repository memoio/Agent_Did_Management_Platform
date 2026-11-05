// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IAgentDIDRegistryV1 {
    enum Status {
        None,
        Active,
        Suspended,
        Revoked,
        Superseded
    }

    function statusOf(address identity) external view returns (Status);
}

contract AgentManagementRegistryV1 is EIP712 {
    uint64 public constant MAX_RELATIONSHIP_TERM = 365 days;
    enum RelationshipStatus {
        None,
        Active,
        Ended
    }

    struct Relationship {
        bytes32 relationshipIdHash;
        address manager;
        bytes32 scopesHash;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 revision;
        bool discoverable;
        RelationshipStatus status;
    }

    bytes32 public constant ACTIVATE_RELATIONSHIP_TYPEHASH = keccak256(
        "ActivateRelationship(address agent,address manager,bytes32 relationshipIdHash,bytes32 scopesHash,uint64 issuedAt,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant RENEW_RELATIONSHIP_TYPEHASH = keccak256(
        "RenewRelationship(address agent,address manager,bytes32 relationshipIdHash,bytes32 scopesHash,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant END_RELATIONSHIP_TYPEHASH = keccak256(
        "EndRelationship(address agent,address manager,bytes32 relationshipIdHash,address actor,bytes32 reasonHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant TRANSFER_RELATIONSHIP_TYPEHASH = keccak256(
        "TransferRelationship(address agent,address oldManager,address newManager,bytes32 oldRelationshipIdHash,bytes32 newRelationshipIdHash,bytes32 scopesHash,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );

    IAgentDIDRegistryV1 public immutable didRegistry;
    mapping(address agent => Relationship) private _relationships;
    mapping(address agent => uint256 nonce) public nonces;

    error InvalidAgent();
    error InvalidManager();
    error InvalidSignature(address signer);
    error InvalidNonce(uint256 expected, uint256 received);
    error InvalidRevision(uint64 expected, uint64 received);
    error DeadlineExpired(uint64 deadline, uint64 currentTime);
    error InvalidTerm();
    error AgentNotActive(address agent);
    error LiveRelationshipExists(address agent);
    error RelationshipNotLive(address agent);
    error RelationshipMismatch();

    event RelationshipActivated(
        address indexed agent,
        address indexed manager,
        bytes32 indexed relationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        uint64 revision,
        uint256 nonce,
        bool discoverable,
        bytes32 actionDigest
    );
    event RelationshipRenewed(
        address indexed agent,
        address indexed manager,
        bytes32 indexed relationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        uint64 revision,
        uint256 nonce,
        bool discoverable,
        bytes32 actionDigest
    );
    event RelationshipEnded(
        address indexed agent,
        address indexed manager,
        bytes32 indexed relationshipIdHash,
        address actor,
        bytes32 reasonHash,
        uint64 revision,
        uint256 nonce,
        bytes32 actionDigest
    );
    event RelationshipTransferred(
        address indexed agent,
        address indexed oldManager,
        address indexed newManager,
        bytes32 oldRelationshipIdHash,
        bytes32 newRelationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        uint64 revision,
        uint256 nonce,
        bool discoverable,
        bytes32 actionDigest
    );

    constructor(address didRegistryAddress) EIP712("MEMO Agent DID Management", "1") {
        if (didRegistryAddress == address(0)) revert InvalidAgent();
        didRegistry = IAgentDIDRegistryV1(didRegistryAddress);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function relationshipOf(address agent) external view returns (Relationship memory relationship, bool live) {
        relationship = _relationships[agent];
        live = _isLive(relationship);
    }

    function activateRelationship(
        address agent,
        address manager,
        bytes32 relationshipIdHash,
        bytes32 scopesHash,
        uint64 issuedAt,
        uint64 expiresAt,
        bool discoverable,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata managerSignature,
        bytes calldata agentSignature
    ) external {
        _requireActiveAgent(agent);
        if (manager == address(0)) revert InvalidManager();
        Relationship storage current = _relationships[agent];
        if (_isLive(current)) revert LiveRelationshipExists(agent);
        _checkCommon(agent, current.revision, expectedRevision, nonce, deadline);
        if (relationshipIdHash == bytes32(0) || scopesHash == bytes32(0) || issuedAt > block.timestamp
            || expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_RELATIONSHIP_TERM) {
            revert InvalidTerm();
        }
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ACTIVATE_RELATIONSHIP_TYPEHASH,
                    agent,
                    manager,
                    relationshipIdHash,
                    scopesHash,
                    issuedAt,
                    expiresAt,
                    discoverable,
                    expectedRevision,
                    nonce,
                    deadline
                )
            )
        );
        _checkManagerSignature(manager, digest, managerSignature);
        _checkAgentSignature(agent, digest, agentSignature);
        uint64 nextRevision = expectedRevision + 1;
        _relationships[agent] = Relationship({
            relationshipIdHash: relationshipIdHash,
            manager: manager,
            scopesHash: scopesHash,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            revision: nextRevision,
            discoverable: discoverable,
            status: RelationshipStatus.Active
        });
        nonces[agent] = nonce + 1;
        emit RelationshipActivated(agent, manager, relationshipIdHash, scopesHash, expiresAt, nextRevision, nonce, discoverable, digest);
    }

    function renewRelationship(
        address agent,
        address manager,
        bytes32 relationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        bool discoverable,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata managerSignature,
        bytes calldata agentSignature
    ) external {
        _requireActiveAgent(agent);
        Relationship storage current = _live(agent);
        if (current.manager != manager || current.relationshipIdHash != relationshipIdHash) revert RelationshipMismatch();
        _checkCommon(agent, current.revision, expectedRevision, nonce, deadline);
        if (scopesHash == bytes32(0) || expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_RELATIONSHIP_TERM) {
            revert InvalidTerm();
        }
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RENEW_RELATIONSHIP_TYPEHASH,
                    agent,
                    manager,
                    relationshipIdHash,
                    scopesHash,
                    expiresAt,
                    discoverable,
                    expectedRevision,
                    nonce,
                    deadline
                )
            )
        );
        _checkManagerSignature(manager, digest, managerSignature);
        _checkAgentSignature(agent, digest, agentSignature);
        current.scopesHash = scopesHash;
        current.expiresAt = expiresAt;
        current.discoverable = discoverable;
        current.revision += 1;
        nonces[agent] = nonce + 1;
        emit RelationshipRenewed(
            agent, manager, relationshipIdHash, scopesHash, expiresAt, current.revision, nonce, discoverable, digest
        );
    }

    function endRelationship(
        address agent,
        address manager,
        bytes32 relationshipIdHash,
        address actor,
        bytes32 reasonHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata actorSignature
    ) external {
        Relationship storage current = _live(agent);
        if (current.manager != manager || current.relationshipIdHash != relationshipIdHash) revert RelationshipMismatch();
        if (actor != agent && actor != manager) revert InvalidSignature(actor);
        _checkCommon(agent, current.revision, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    END_RELATIONSHIP_TYPEHASH,
                    agent,
                    manager,
                    relationshipIdHash,
                    actor,
                    reasonHash,
                    expectedRevision,
                    nonce,
                    deadline
                )
            )
        );
        if (actor == agent) _checkAgentSignature(agent, digest, actorSignature);
        else _checkManagerSignature(manager, digest, actorSignature);
        current.status = RelationshipStatus.Ended;
        current.revision += 1;
        nonces[agent] = nonce + 1;
        emit RelationshipEnded(
            agent, manager, relationshipIdHash, actor, reasonHash, current.revision, nonce, digest
        );
    }

    function transferRelationship(
        address agent,
        address oldManager,
        address newManager,
        bytes32 oldRelationshipIdHash,
        bytes32 newRelationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        bool discoverable,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata oldManagerSignature,
        bytes calldata newManagerSignature,
        bytes calldata agentSignature
    ) external {
        _requireActiveAgent(agent);
        Relationship storage current = _live(agent);
        if (newManager == address(0) || newManager == oldManager) revert InvalidManager();
        if (current.manager != oldManager || current.relationshipIdHash != oldRelationshipIdHash) revert RelationshipMismatch();
        _checkCommon(agent, current.revision, expectedRevision, nonce, deadline);
        if (newRelationshipIdHash == bytes32(0) || scopesHash == bytes32(0) || expiresAt <= block.timestamp
            || expiresAt > block.timestamp + MAX_RELATIONSHIP_TERM) revert InvalidTerm();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_RELATIONSHIP_TYPEHASH,
                    agent,
                    oldManager,
                    newManager,
                    oldRelationshipIdHash,
                    newRelationshipIdHash,
                    scopesHash,
                    expiresAt,
                    discoverable,
                    expectedRevision,
                    nonce,
                    deadline
                )
            )
        );
        _checkManagerSignature(oldManager, digest, oldManagerSignature);
        _checkManagerSignature(newManager, digest, newManagerSignature);
        _checkAgentSignature(agent, digest, agentSignature);
        current.relationshipIdHash = newRelationshipIdHash;
        current.manager = newManager;
        current.scopesHash = scopesHash;
        current.issuedAt = uint64(block.timestamp);
        current.expiresAt = expiresAt;
        current.discoverable = discoverable;
        current.revision += 1;
        nonces[agent] = nonce + 1;
        emit RelationshipTransferred(
            agent,
            oldManager,
            newManager,
            oldRelationshipIdHash,
            newRelationshipIdHash,
            scopesHash,
            expiresAt,
            current.revision,
            nonce,
            discoverable,
            digest
        );
    }

    function _requireActiveAgent(address agent) private view {
        if (agent == address(0)) revert InvalidAgent();
        if (didRegistry.statusOf(agent) != IAgentDIDRegistryV1.Status.Active) revert AgentNotActive(agent);
    }

    function _live(address agent) private view returns (Relationship storage current) {
        current = _relationships[agent];
        if (!_isLive(current)) revert RelationshipNotLive(agent);
    }

    function _isLive(Relationship memory current) private view returns (bool) {
        return current.status == RelationshipStatus.Active && current.expiresAt > block.timestamp;
    }

    function _checkCommon(address agent, uint64 currentRevision, uint64 expectedRevision, uint256 nonce, uint64 deadline)
        private
        view
    {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, uint64(block.timestamp));
        uint256 expectedNonce = nonces[agent];
        if (nonce != expectedNonce) revert InvalidNonce(expectedNonce, nonce);
        if (expectedRevision != currentRevision) revert InvalidRevision(currentRevision, expectedRevision);
    }

    function _checkAgentSignature(address agent, bytes32 digest, bytes calldata signature) private pure {
        if (ECDSA.recover(digest, signature) != agent) revert InvalidSignature(agent);
    }

    function _checkManagerSignature(address manager, bytes32 digest, bytes calldata signature) private view {
        if (!SignatureChecker.isValidSignatureNow(manager, digest, signature)) revert InvalidSignature(manager);
    }
}
