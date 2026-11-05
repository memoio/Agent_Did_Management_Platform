// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract AgentDIDRegistryV1 is EIP712 {
    enum Status {
        None,
        Active,
        Suspended,
        Revoked,
        Superseded
    }

    struct AgentRecord {
        address identityAccount;
        bytes32 identityPublicKeyHash;
        bytes32 documentHash;
        bytes32 profileHash;
        uint64 revision;
        Status status;
        bytes32 successorDidHash;
    }

    bytes32 public constant REGISTER_AGENT_TYPEHASH = keccak256(
        "RegisterAgent(address identityAccount,bytes32 identityPublicKeyHash,bytes32 documentHash,bytes32 profileHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant UPDATE_PROFILE_TYPEHASH = keccak256(
        "UpdateProfile(address identityAccount,bytes32 profileHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant UPDATE_DOCUMENT_TYPEHASH = keccak256(
        "UpdateDocument(address identityAccount,bytes32 documentHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant SUSPEND_AGENT_TYPEHASH = keccak256(
        "SuspendAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant RESUME_AGENT_TYPEHASH = keccak256(
        "ResumeAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant REVOKE_AGENT_TYPEHASH = keccak256(
        "RevokeAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant DECLARE_SUCCESSOR_TYPEHASH = keccak256(
        "DeclareSuccessor(address identityAccount,bytes32 successorDidHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant REVOKE_INSTANCE_TYPEHASH = keccak256(
        "RevokeInstanceCredential(address identityAccount,bytes32 credentialIdHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
    );

    mapping(address identity => AgentRecord) private _records;
    mapping(address identity => uint256 nonce) public nonces;
    mapping(address identity => mapping(bytes32 credentialIdHash => bool revoked)) public revokedCredentials;

    error InvalidIdentity();
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 received);
    error InvalidRevision(uint64 expected, uint64 received);
    error DeadlineExpired(uint64 deadline, uint64 currentTime);
    error InvalidStatus(Status expected, Status actual);
    error IdentityAlreadyExists(address identity);
    error IdentityNotFound(address identity);
    error CredentialAlreadyRevoked(bytes32 credentialIdHash);
    error EmptyHash();

    event AgentRegistered(
        address indexed identityAccount,
        uint64 revision,
        uint256 nonce,
        bytes32 identityPublicKeyHash,
        bytes32 documentHash,
        bytes32 profileHash,
        bytes32 actionDigest
    );
    event ProfileUpdated(address indexed identityAccount, uint64 revision, uint256 nonce, bytes32 profileHash, bytes32 actionDigest);
    event DocumentUpdated(address indexed identityAccount, uint64 revision, uint256 nonce, bytes32 documentHash, bytes32 actionDigest);
    event AgentStatusChanged(address indexed identityAccount, Status status, uint64 revision, uint256 nonce, bytes32 actionDigest);
    event SuccessorDeclared(address indexed identityAccount, bytes32 successorDidHash, uint64 revision, uint256 nonce, bytes32 actionDigest);
    event InstanceCredentialRevoked(
        address indexed identityAccount, bytes32 indexed credentialIdHash, uint64 revision, uint256 nonce, bytes32 actionDigest
    );

    constructor() EIP712("MEMO Agent DID Registry", "1") {}

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function recordOf(address identity) external view returns (AgentRecord memory) {
        return _records[identity];
    }

    function statusOf(address identity) external view returns (Status) {
        return _records[identity].status;
    }

    function isActive(address identity) external view returns (bool) {
        return _records[identity].status == Status.Active;
    }

    function registerAgent(
        address identityAccount,
        bytes32 identityPublicKeyHash,
        bytes32 documentHash,
        bytes32 profileHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (identityAccount == address(0)) revert InvalidIdentity();
        if (identityPublicKeyHash == bytes32(0) || documentHash == bytes32(0) || profileHash == bytes32(0)) revert EmptyHash();
        if (_records[identityAccount].status != Status.None) revert IdentityAlreadyExists(identityAccount);
        _checkDeadline(deadline);
        _checkNonce(identityAccount, nonce);
        if (expectedRevision != 0) revert InvalidRevision(0, expectedRevision);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REGISTER_AGENT_TYPEHASH,
                    identityAccount,
                    identityPublicKeyHash,
                    documentHash,
                    profileHash,
                    expectedRevision,
                    nonce,
                    deadline
                )
            )
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        nonces[identityAccount] = nonce + 1;
        _records[identityAccount] = AgentRecord({
            identityAccount: identityAccount,
            identityPublicKeyHash: identityPublicKeyHash,
            documentHash: documentHash,
            profileHash: profileHash,
            revision: 1,
            status: Status.Active,
            successorDidHash: bytes32(0)
        });
        emit AgentRegistered(identityAccount, 1, nonce, identityPublicKeyHash, documentHash, profileHash, digest);
    }

    function updateProfile(
        address identityAccount,
        bytes32 profileHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (profileHash == bytes32(0)) revert EmptyHash();
        AgentRecord storage record = _prepare(identityAccount, Status.Active, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(UPDATE_PROFILE_TYPEHASH, identityAccount, profileHash, expectedRevision, nonce, deadline))
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        record.profileHash = profileHash;
        _commit(record, identityAccount, nonce);
        emit ProfileUpdated(identityAccount, record.revision, nonce, profileHash, digest);
    }

    function updateDocument(
        address identityAccount,
        bytes32 documentHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (documentHash == bytes32(0)) revert EmptyHash();
        AgentRecord storage record = _prepare(identityAccount, Status.Active, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(UPDATE_DOCUMENT_TYPEHASH, identityAccount, documentHash, expectedRevision, nonce, deadline))
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        record.documentHash = documentHash;
        _commit(record, identityAccount, nonce);
        emit DocumentUpdated(identityAccount, record.revision, nonce, documentHash, digest);
    }

    function suspendAgent(
        address identityAccount,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        _changeStatus(identityAccount, Status.Active, Status.Suspended, SUSPEND_AGENT_TYPEHASH, expectedRevision, nonce, deadline, signature);
    }

    function resumeAgent(
        address identityAccount,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        _changeStatus(identityAccount, Status.Suspended, Status.Active, RESUME_AGENT_TYPEHASH, expectedRevision, nonce, deadline, signature);
    }

    function revokeAgent(
        address identityAccount,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        AgentRecord storage record = _record(identityAccount);
        if (record.status != Status.Active && record.status != Status.Suspended) revert InvalidStatus(Status.Active, record.status);
        _checkWrite(record, identityAccount, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(REVOKE_AGENT_TYPEHASH, identityAccount, expectedRevision, nonce, deadline))
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        record.status = Status.Revoked;
        _commit(record, identityAccount, nonce);
        emit AgentStatusChanged(identityAccount, Status.Revoked, record.revision, nonce, digest);
    }

    function declareSuccessor(
        address identityAccount,
        bytes32 successorDidHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (successorDidHash == bytes32(0)) revert EmptyHash();
        AgentRecord storage record = _prepare(identityAccount, Status.Active, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(DECLARE_SUCCESSOR_TYPEHASH, identityAccount, successorDidHash, expectedRevision, nonce, deadline))
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        record.successorDidHash = successorDidHash;
        record.status = Status.Superseded;
        _commit(record, identityAccount, nonce);
        emit SuccessorDeclared(identityAccount, successorDidHash, record.revision, nonce, digest);
    }

    function revokeInstanceCredential(
        address identityAccount,
        bytes32 credentialIdHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (credentialIdHash == bytes32(0)) revert EmptyHash();
        AgentRecord storage record = _record(identityAccount);
        if (record.status != Status.Active && record.status != Status.Suspended) revert InvalidStatus(Status.Active, record.status);
        if (revokedCredentials[identityAccount][credentialIdHash]) revert CredentialAlreadyRevoked(credentialIdHash);
        _checkWrite(record, identityAccount, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(REVOKE_INSTANCE_TYPEHASH, identityAccount, credentialIdHash, expectedRevision, nonce, deadline))
        );
        _checkIdentitySignature(identityAccount, digest, signature);
        revokedCredentials[identityAccount][credentialIdHash] = true;
        _commit(record, identityAccount, nonce);
        emit InstanceCredentialRevoked(identityAccount, credentialIdHash, record.revision, nonce, digest);
    }

    function _changeStatus(
        address identityAccount,
        Status expectedStatus,
        Status nextStatus,
        bytes32 typeHash,
        uint64 expectedRevision,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) private {
        AgentRecord storage record = _prepare(identityAccount, expectedStatus, expectedRevision, nonce, deadline);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(typeHash, identityAccount, expectedRevision, nonce, deadline)));
        _checkIdentitySignature(identityAccount, digest, signature);
        record.status = nextStatus;
        _commit(record, identityAccount, nonce);
        emit AgentStatusChanged(identityAccount, nextStatus, record.revision, nonce, digest);
    }

    function _record(address identityAccount) private view returns (AgentRecord storage record) {
        record = _records[identityAccount];
        if (record.status == Status.None) revert IdentityNotFound(identityAccount);
    }

    function _prepare(address identityAccount, Status status, uint64 expectedRevision, uint256 nonce, uint64 deadline)
        private
        view
        returns (AgentRecord storage record)
    {
        record = _record(identityAccount);
        if (record.status != status) revert InvalidStatus(status, record.status);
        _checkWrite(record, identityAccount, expectedRevision, nonce, deadline);
    }

    function _checkWrite(AgentRecord storage record, address identityAccount, uint64 expectedRevision, uint256 nonce, uint64 deadline)
        private
        view
    {
        _checkDeadline(deadline);
        _checkNonce(identityAccount, nonce);
        if (record.revision != expectedRevision) revert InvalidRevision(record.revision, expectedRevision);
    }

    function _checkNonce(address identityAccount, uint256 nonce) private view {
        uint256 expected = nonces[identityAccount];
        if (expected != nonce) revert InvalidNonce(expected, nonce);
    }

    function _checkDeadline(uint64 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, uint64(block.timestamp));
    }

    function _checkIdentitySignature(address identityAccount, bytes32 digest, bytes calldata signature) private pure {
        if (ECDSA.recover(digest, signature) != identityAccount) revert InvalidSignature();
    }

    function _commit(AgentRecord storage record, address identityAccount, uint256 nonce) private {
        record.revision += 1;
        nonces[identityAccount] = nonce + 1;
    }
}
