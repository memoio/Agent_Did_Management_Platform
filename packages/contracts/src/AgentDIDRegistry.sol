// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Non-upgradeable v1 registry. A relayer pays gas; only the Agent authorizes actions.
contract AgentDIDRegistry is EIP712 {
    enum Status {
        NONE,
        ACTIVE,
        SUSPENDED,
        REVOKED
    }
    struct Identity {
        Status status;
        uint64 revision;
        uint256 nonce;
        bytes32 identityPublicKeyHash;
        bytes32 documentHash;
        bytes32 profileHash;
    }
    mapping(address => Identity) public identities;
    mapping(address => mapping(bytes32 => bool)) public revokedCredentials;

    error InvalidAction();
    error InvalidSignature();
    error NonceConflict();
    error ActionExpired();
    event AgentRegistered(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        bytes32 identityPublicKeyHash,
        bytes32 documentHash,
        bytes32 profileHash
    );
    event ProfileUpdated(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        bytes32 profileHash
    );
    event DocumentUpdated(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        bytes32 documentHash
    );
    event AgentStatusChanged(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        Status status
    );
    event InstanceCredentialRevoked(
        address indexed agent,
        bytes32 actionDigest,
        uint64 revision,
        uint256 nonce,
        bytes32 credentialIdHash
    );

    constructor() EIP712("MEMO Agent DID Registry", "1") {}

    function _authorize(
        address agent,
        uint64 revision,
        uint256 nonce,
        uint64 deadline,
        bytes32 digest,
        bytes calldata signature
    ) private view {
        if (deadline == 0 || block.timestamp > deadline) revert ActionExpired();
        if (agent == address(0) || agent.code.length != 0)
            revert InvalidAction();
        Identity storage identity = identities[agent];
        if (identity.revision != revision || identity.nonce != nonce)
            revert NonceConflict();
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            digest,
            signature
        );
        if (err != ECDSA.RecoverError.NoError || signer != agent)
            revert InvalidSignature();
    }

    function _advance(address agent) private returns (uint64) {
        identities[agent].nonce++;
        return ++identities[agent].revision;
    }

    function _registered(address agent) private view {
        Status status = identities[agent].status;
        if (status != Status.ACTIVE && status != Status.SUSPENDED)
            revert InvalidAction();
    }

    struct RegisterAgent {
        address identityAccount;
        bytes32 identityPublicKeyHash;
        bytes32 documentHash;
        bytes32 profileHash;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function registerAgent(
        RegisterAgent calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "RegisterAgent(address identityAccount,bytes32 identityPublicKeyHash,bytes32 documentHash,bytes32 profileHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        if (
            identities[a.identityAccount].status != Status.NONE ||
            a.identityPublicKeyHash == 0 ||
            address(uint160(uint256(a.identityPublicKeyHash))) !=
            a.identityAccount ||
            a.documentHash == 0 ||
            a.profileHash == 0
        ) revert InvalidAction();
        Identity storage identity = identities[a.identityAccount];
        identity.status = Status.ACTIVE;
        identity.identityPublicKeyHash = a.identityPublicKeyHash;
        identity.documentHash = a.documentHash;
        identity.profileHash = a.profileHash;
        emit AgentRegistered(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            a.identityPublicKeyHash,
            a.documentHash,
            a.profileHash
        );
    }

    struct UpdateProfile {
        address identityAccount;
        bytes32 profileHash;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function updateProfile(
        UpdateProfile calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "UpdateProfile(address identityAccount,bytes32 profileHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        _registered(a.identityAccount);
        if (a.profileHash == 0) revert InvalidAction();
        identities[a.identityAccount].profileHash = a.profileHash;
        emit ProfileUpdated(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            a.profileHash
        );
    }

    struct UpdateDocument {
        address identityAccount;
        bytes32 documentHash;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function updateDocument(
        UpdateDocument calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "UpdateDocument(address identityAccount,bytes32 documentHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        _registered(a.identityAccount);
        if (a.documentHash == 0) revert InvalidAction();
        identities[a.identityAccount].documentHash = a.documentHash;
        emit DocumentUpdated(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            a.documentHash
        );
    }

    struct SuspendAgent {
        address identityAccount;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function suspendAgent(
        SuspendAgent calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "SuspendAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        if (identities[a.identityAccount].status != Status.ACTIVE)
            revert InvalidAction();
        identities[a.identityAccount].status = Status.SUSPENDED;
        emit AgentStatusChanged(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            Status.SUSPENDED
        );
    }

    struct ResumeAgent {
        address identityAccount;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function resumeAgent(
        ResumeAgent calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "ResumeAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        if (identities[a.identityAccount].status != Status.SUSPENDED)
            revert InvalidAction();
        identities[a.identityAccount].status = Status.ACTIVE;
        emit AgentStatusChanged(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            Status.ACTIVE
        );
    }

    struct RevokeAgent {
        address identityAccount;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function revokeAgent(
        RevokeAgent calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "RevokeAgent(address identityAccount,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        _registered(a.identityAccount);
        identities[a.identityAccount].status = Status.REVOKED;
        emit AgentStatusChanged(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            Status.REVOKED
        );
    }

    struct RevokeInstanceCredential {
        address identityAccount;
        bytes32 credentialIdHash;
        uint64 expectedRevision;
        uint256 nonce;
        uint64 deadline;
    }
    function revokeInstanceCredential(
        RevokeInstanceCredential calldata a,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "RevokeInstanceCredential(address identityAccount,bytes32 credentialIdHash,uint64 expectedRevision,uint256 nonce,uint64 deadline)"
                    ),
                    a
                )
            )
        );
        _authorize(
            a.identityAccount,
            a.expectedRevision,
            a.nonce,
            a.deadline,
            digest,
            signature
        );
        _registered(a.identityAccount);
        if (
            a.credentialIdHash == 0 ||
            revokedCredentials[a.identityAccount][a.credentialIdHash]
        ) revert InvalidAction();
        revokedCredentials[a.identityAccount][a.credentialIdHash] = true;
        emit InstanceCredentialRevoked(
            a.identityAccount,
            digest,
            _advance(a.identityAccount),
            a.nonce,
            a.credentialIdHash
        );
    }
}
