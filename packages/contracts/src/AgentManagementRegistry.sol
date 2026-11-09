// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AgentDIDRegistry} from "./AgentDIDRegistry.sol";

/// @notice One current relationship per Agent; history is retained in events.
contract AgentManagementRegistry is EIP712 {
    struct Relationship {
        address manager;
        bytes32 relationshipIdHash;
        bytes32 scopesHash;
        uint64 expiresAt;
        bool discoverable;
        bool ended;
        uint64 revision;
        uint256 nonce;
    }
    AgentDIDRegistry public immutable didRegistry;
    mapping(address => Relationship) public relationships;

    error InvalidAction();
    error InvalidSignature();
    error NonceConflict();
    error ActionExpired();
    event RelationshipActivated(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        address manager,
        bytes32 relationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        bool discoverable
    );
    event RelationshipRenewed(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        address manager,
        bytes32 relationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        bool discoverable
    );
    event RelationshipEnded(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        address manager,
        bytes32 relationshipIdHash,
        address actor,
        bytes32 reasonHash
    );
    event RelationshipTransferred(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        address oldManager,
        address newManager,
        bytes32 oldRelationshipIdHash,
        bytes32 newRelationshipIdHash,
        bytes32 scopesHash,
        uint64 expiresAt,
        bool discoverable
    );

    constructor(address registry) EIP712("MEMO Agent DID Management", "1") {
        if (registry.code.length == 0) revert InvalidAction();
        didRegistry = AgentDIDRegistry(registry);
    }

    function _check(
        address agent,
        uint64 revision,
        uint256 nonce,
        uint64 deadline
    ) private view {
        if (deadline == 0 || block.timestamp > deadline) revert ActionExpired();
        if (agent == address(0) || agent.code.length != 0)
            revert InvalidAction();
        Relationship storage relationship = relationships[agent];
        if (relationship.revision != revision || relationship.nonce != nonce)
            revert NonceConflict();
    }

    function _active(address agent) private view {
        (AgentDIDRegistry.Status status, , , , , ) = didRegistry.identities(
            agent
        );
        if (status != AgentDIDRegistry.Status.ACTIVE) revert InvalidAction();
    }

    function _signature(
        address signer,
        bytes32 digest,
        bytes calldata signature
    ) private view {
        if (
            signer == address(0) ||
            !SignatureChecker.isValidSignatureNow(signer, digest, signature)
        ) revert InvalidSignature();
    }

    function _current(address agent, address manager, bytes32 id) private view {
        Relationship storage relationship = relationships[agent];
        if (
            relationship.manager == address(0) ||
            relationship.manager != manager ||
            relationship.relationshipIdHash != id ||
            relationship.ended
        ) revert InvalidAction();
    }

    function _advance(address agent) private returns (uint64) {
        relationships[agent].nonce++;
        return ++relationships[agent].revision;
    }

    function _newTerms(
        address manager,
        bytes32 id,
        bytes32 scopes,
        uint64 expiresAt
    ) private view {
        if (
            manager == address(0) ||
            id == 0 ||
            scopes == 0 ||
            expiresAt <= block.timestamp
        ) revert InvalidAction();
    }

    struct ActivateRelationship {
        address agent;
        address manager;
        bytes32 relationshipIdHash;
        bytes32 scopesHash;
        uint64 issuedAt;
        uint64 expiresAt;
        bool discoverable;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function activateRelationship(
        ActivateRelationship calldata a,
        bytes calldata agentSignature,
        bytes calldata managerSignature
    ) external {
        _check(a.agent, a.expectedRevision, a.nonce, a.deadline);
        _active(a.agent);
        Relationship storage r = relationships[a.agent];
        if (
            (!r.ended && r.expiresAt > block.timestamp) ||
            a.issuedAt == 0 ||
            a.issuedAt > block.timestamp ||
            a.expiresAt <= a.issuedAt
        ) revert InvalidAction();
        _newTerms(a.manager, a.relationshipIdHash, a.scopesHash, a.expiresAt);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "ActivateRelationship(address agent,address manager,bytes32 relationshipIdHash,bytes32 scopesHash,uint64 issuedAt,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _signature(a.agent, digest, agentSignature);
        _signature(a.manager, digest, managerSignature);
        r.manager = a.manager;
        r.relationshipIdHash = a.relationshipIdHash;
        r.scopesHash = a.scopesHash;
        r.expiresAt = a.expiresAt;
        r.discoverable = a.discoverable;
        r.ended = false;
        emit RelationshipActivated(
            a.agent,
            digest,
            _advance(a.agent),
            a.nonce,
            a.manager,
            a.relationshipIdHash,
            a.scopesHash,
            a.expiresAt,
            a.discoverable
        );
    }

    struct RenewRelationship {
        address agent;
        address manager;
        bytes32 relationshipIdHash;
        bytes32 scopesHash;
        uint64 expiresAt;
        bool discoverable;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function renewRelationship(
        RenewRelationship calldata a,
        bytes calldata agentSignature,
        bytes calldata managerSignature
    ) external {
        _check(a.agent, a.expectedRevision, a.nonce, a.deadline);
        _active(a.agent);
        _current(a.agent, a.manager, a.relationshipIdHash);
        if (a.scopesHash == 0 || a.expiresAt <= block.timestamp)
            revert InvalidAction();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "RenewRelationship(address agent,address manager,bytes32 relationshipIdHash,bytes32 scopesHash,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _signature(a.agent, digest, agentSignature);
        _signature(a.manager, digest, managerSignature);
        Relationship storage r = relationships[a.agent];
        r.scopesHash = a.scopesHash;
        r.expiresAt = a.expiresAt;
        r.discoverable = a.discoverable;
        emit RelationshipRenewed(
            a.agent,
            digest,
            _advance(a.agent),
            a.nonce,
            a.manager,
            a.relationshipIdHash,
            a.scopesHash,
            a.expiresAt,
            a.discoverable
        );
    }

    struct EndRelationship {
        address agent;
        address manager;
        bytes32 relationshipIdHash;
        address actor;
        bytes32 reasonHash;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function endRelationship(
        EndRelationship calldata a,
        bytes calldata signature
    ) external {
        _check(a.agent, a.expectedRevision, a.nonce, a.deadline);
        _current(a.agent, a.manager, a.relationshipIdHash);
        if (a.actor != a.agent && a.actor != a.manager) revert InvalidAction();
        if (
            a.reasonHash != keccak256("AGENT_ENDED") &&
            a.reasonHash != keccak256("MANAGER_ENDED") &&
            a.reasonHash != keccak256("SECURITY_REVOCATION")
        ) revert InvalidAction();
        if (
            (a.reasonHash == keccak256("AGENT_ENDED") && a.actor != a.agent) ||
            (a.reasonHash == keccak256("MANAGER_ENDED") && a.actor != a.manager)
        ) revert InvalidAction();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "EndRelationship(address agent,address manager,bytes32 relationshipIdHash,address actor,bytes32 reasonHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _signature(a.actor, digest, signature);
        relationships[a.agent].ended = true;
        emit RelationshipEnded(
            a.agent,
            digest,
            _advance(a.agent),
            a.nonce,
            a.manager,
            a.relationshipIdHash,
            a.actor,
            a.reasonHash
        );
    }

    struct TransferRelationship {
        address agent;
        address oldManager;
        address newManager;
        bytes32 oldRelationshipIdHash;
        bytes32 newRelationshipIdHash;
        bytes32 scopesHash;
        uint64 expiresAt;
        bool discoverable;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function transferRelationship(
        TransferRelationship calldata a,
        bytes calldata agentSignature,
        bytes calldata oldManagerSignature,
        bytes calldata newManagerSignature
    ) external {
        _check(a.agent, a.expectedRevision, a.nonce, a.deadline);
        _active(a.agent);
        _current(a.agent, a.oldManager, a.oldRelationshipIdHash);
        if (
            a.oldManager == a.newManager ||
            relationships[a.agent].expiresAt <= block.timestamp
        ) revert InvalidAction();
        _newTerms(
            a.newManager,
            a.newRelationshipIdHash,
            a.scopesHash,
            a.expiresAt
        );
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "TransferRelationship(address agent,address oldManager,address newManager,bytes32 oldRelationshipIdHash,bytes32 newRelationshipIdHash,bytes32 scopesHash,uint64 expiresAt,bool discoverable,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _signature(a.agent, digest, agentSignature);
        _signature(a.oldManager, digest, oldManagerSignature);
        _signature(a.newManager, digest, newManagerSignature);
        Relationship storage r = relationships[a.agent];
        r.manager = a.newManager;
        r.relationshipIdHash = a.newRelationshipIdHash;
        r.scopesHash = a.scopesHash;
        r.expiresAt = a.expiresAt;
        r.discoverable = a.discoverable;
        emit RelationshipTransferred(
            a.agent,
            digest,
            _advance(a.agent),
            a.nonce,
            a.oldManager,
            a.newManager,
            a.oldRelationshipIdHash,
            a.newRelationshipIdHash,
            a.scopesHash,
            a.expiresAt,
            a.discoverable
        );
    }
}
