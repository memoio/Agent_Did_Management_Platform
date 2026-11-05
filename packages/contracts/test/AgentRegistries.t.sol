// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { AgentDIDRegistryV1 } from "../src/AgentDIDRegistryV1.sol";
import { AgentManagementRegistryV1 } from "../src/AgentManagementRegistryV1.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function prank(address sender) external;
    function chainId(uint256 newChainId) external;
}

contract Mock1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
contract AgentRegistriesTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant AGENT_KEY = 0xA11CE;
    uint256 private constant MANAGER_KEY = 0xB0B;
    uint256 private constant NEW_MANAGER_KEY = 0xCAFE;
    uint256 private constant RELAYER_KEY = 0xD00D;

    AgentDIDRegistryV1 private didRegistry;
    AgentManagementRegistryV1 private managementRegistry;
    address private agent;
    address private manager;
    address private newManager;

    function setUp() public {
        vm.chainId(985);
        didRegistry = new AgentDIDRegistryV1();
        managementRegistry = new AgentManagementRegistryV1(address(didRegistry));
        agent = vm.addr(AGENT_KEY);
        manager = vm.addr(MANAGER_KEY);
        newManager = vm.addr(NEW_MANAGER_KEY);
        _registerAgent();
    }

    function testIdentityLifecycleAndInstanceRevocation() public {
        _updateProfile(keccak256("profile-2"), 1, 1);
        _changeStatus("SuspendAgent", 2, 2);
        _revokeInstance(keccak256("credential-1"), 3, 3);
        _changeStatus("ResumeAgent", 4, 4);
        _updateDocument(keccak256("document-2"), 5, 5);
        _changeStatus("RevokeAgent", 6, 6);

        AgentDIDRegistryV1.AgentRecord memory record = didRegistry.recordOf(agent);
        _assertEq(uint256(record.revision), 7, "revision");
        _assertEq(uint256(record.status), uint256(AgentDIDRegistryV1.Status.Revoked), "status");
        _assertEq(didRegistry.nonces(agent), 7, "nonce");
        _assertTrue(didRegistry.revokedCredentials(agent, keccak256("credential-1")), "credential revoke");

        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(abi.encode(didRegistry.RESUME_AGENT_TYPEHASH(), agent, uint64(7), uint256(7), deadline))
        );
        bytes memory signature = _sign(AGENT_KEY, digest);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentDIDRegistryV1.InvalidStatus.selector,
                AgentDIDRegistryV1.Status.Suspended,
                AgentDIDRegistryV1.Status.Revoked
            )
        );
        didRegistry.resumeAgent(agent, 7, 7, deadline, signature);
    }

    function testRejectsDuplicateNonceStaleRevisionAndDeadline() public {
        bytes32 profileHash = keccak256("profile-once");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(
                abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, profileHash, uint64(1), uint256(1), deadline)
            )
        );
        bytes memory signature = _sign(AGENT_KEY, digest);
        didRegistry.updateProfile(agent, profileHash, 1, 1, deadline, signature);

        vm.expectRevert(abi.encodeWithSelector(AgentDIDRegistryV1.InvalidNonce.selector, 2, 1));
        didRegistry.updateProfile(agent, profileHash, 1, 1, deadline, signature);

        uint64 currentDeadline = uint64(block.timestamp + 600);
        bytes32 staleDigest = _didDigest(
            keccak256(
                abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, keccak256("stale"), uint64(1), uint256(2), currentDeadline)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(AgentDIDRegistryV1.InvalidRevision.selector, 2, 1));
        didRegistry.updateProfile(agent, keccak256("stale"), 1, 2, currentDeadline, _sign(AGENT_KEY, staleDigest));

        uint64 expired = uint64(block.timestamp + 1);
        bytes32 expiredDigest = _didDigest(
            keccak256(
                abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, keccak256("expired"), uint64(2), uint256(2), expired)
            )
        );
        vm.warp(block.timestamp + 2);
        bytes memory expiredSignature = _sign(AGENT_KEY, expiredDigest);
        vm.expectRevert(
            abi.encodeWithSelector(AgentDIDRegistryV1.DeadlineExpired.selector, expired, uint64(block.timestamp))
        );
        didRegistry.updateProfile(agent, keccak256("expired"), 2, 2, expired, expiredSignature);
    }

    function testRejectsWrongSignerChainAndVerifyingContract() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 profileHash = keccak256("domain-check");
        bytes32 structHash = keccak256(
            abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, profileHash, uint64(1), uint256(1), deadline)
        );

        bytes memory wrongSignerSignature = _sign(MANAGER_KEY, _didDigest(structHash));
        vm.expectRevert(AgentDIDRegistryV1.InvalidSignature.selector);
        didRegistry.updateProfile(agent, profileHash, 1, 1, deadline, wrongSignerSignature);

        AgentDIDRegistryV1 anotherRegistry = new AgentDIDRegistryV1();
        bytes32 otherContractDigest = keccak256(
            abi.encodePacked("\x19\x01", anotherRegistry.domainSeparator(), structHash)
        );
        bytes memory wrongContractSignature = _sign(AGENT_KEY, otherContractDigest);
        vm.expectRevert(AgentDIDRegistryV1.InvalidSignature.selector);
        didRegistry.updateProfile(agent, profileHash, 1, 1, deadline, wrongContractSignature);

        bytes32 wrongChainDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MEMO Agent DID Registry"),
                keccak256("1"),
                uint256(31337),
                address(didRegistry)
            )
        );
        bytes32 wrongChainDigest = keccak256(abi.encodePacked("\x19\x01", wrongChainDomain, structHash));
        bytes memory wrongChainSignature = _sign(AGENT_KEY, wrongChainDigest);
        vm.expectRevert(AgentDIDRegistryV1.InvalidSignature.selector);
        didRegistry.updateProfile(agent, profileHash, 1, 1, deadline, wrongChainSignature);
    }

    function testDuplicateInstanceRevocationReverts() public {
        bytes32 credential = keccak256("duplicate-credential");
        _revokeInstance(credential, 1, 1);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(
                abi.encode(didRegistry.REVOKE_INSTANCE_TYPEHASH(), agent, credential, uint64(2), uint256(2), deadline)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(AgentDIDRegistryV1.CredentialAlreadyRevoked.selector, credential));
        didRegistry.revokeInstanceCredential(agent, credential, 2, 2, deadline, _sign(AGENT_KEY, digest));
    }

    function testManagementLifecycle() public {
        bytes32 relationshipId = keccak256("relationship-1");
        bytes32 scopes = keccak256("profile.update,instance.manage");
        uint64 issuedAt = uint64(block.timestamp);
        uint64 expiresAt = uint64(block.timestamp + 30 days);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 activateDigest = _managementDigest(
            keccak256(
                abi.encode(
                    managementRegistry.ACTIVATE_RELATIONSHIP_TYPEHASH(),
                    agent,
                    manager,
                    relationshipId,
                    scopes,
                    issuedAt,
                    expiresAt,
                    false,
                    uint64(0),
                    uint256(0),
                    deadline
                )
            )
        );
        vm.prank(vm.addr(RELAYER_KEY));
        managementRegistry.activateRelationship(
            agent,
            manager,
            relationshipId,
            scopes,
            issuedAt,
            expiresAt,
            false,
            0,
            0,
            deadline,
            _sign(MANAGER_KEY, activateDigest),
            _sign(AGENT_KEY, activateDigest)
        );

        vm.expectRevert(abi.encodeWithSelector(AgentManagementRegistryV1.LiveRelationshipExists.selector, agent));
        managementRegistry.activateRelationship(
            agent,
            newManager,
            keccak256("other"),
            scopes,
            issuedAt,
            expiresAt,
            true,
            1,
            1,
            deadline,
            "",
            ""
        );

        bytes32 renewedScopes = keccak256("profile.update");
        uint64 renewedExpiry = uint64(block.timestamp + 60 days);
        bytes32 renewDigest = _managementDigest(
            keccak256(
                abi.encode(
                    managementRegistry.RENEW_RELATIONSHIP_TYPEHASH(),
                    agent,
                    manager,
                    relationshipId,
                    renewedScopes,
                    renewedExpiry,
                    true,
                    uint64(1),
                    uint256(1),
                    deadline
                )
            )
        );
        managementRegistry.renewRelationship(
            agent,
            manager,
            relationshipId,
            renewedScopes,
            renewedExpiry,
            true,
            1,
            1,
            deadline,
            _sign(MANAGER_KEY, renewDigest),
            _sign(AGENT_KEY, renewDigest)
        );

        bytes32 nextRelationshipId = keccak256("relationship-2");
        bytes32 transferDigest = _managementDigest(
            keccak256(
                abi.encode(
                    managementRegistry.TRANSFER_RELATIONSHIP_TYPEHASH(),
                    agent,
                    manager,
                    newManager,
                    relationshipId,
                    nextRelationshipId,
                    renewedScopes,
                    renewedExpiry,
                    true,
                    uint64(2),
                    uint256(2),
                    deadline
                )
            )
        );
        managementRegistry.transferRelationship(
            agent,
            manager,
            newManager,
            relationshipId,
            nextRelationshipId,
            renewedScopes,
            renewedExpiry,
            true,
            2,
            2,
            deadline,
            _sign(MANAGER_KEY, transferDigest),
            _sign(NEW_MANAGER_KEY, transferDigest),
            _sign(AGENT_KEY, transferDigest)
        );

        bytes32 reasonHash = keccak256("retired");
        bytes32 endDigest = _managementDigest(
            keccak256(
                abi.encode(
                    managementRegistry.END_RELATIONSHIP_TYPEHASH(),
                    agent,
                    newManager,
                    nextRelationshipId,
                    newManager,
                    reasonHash,
                    uint64(3),
                    uint256(3),
                    deadline
                )
            )
        );
        managementRegistry.endRelationship(
            agent,
            newManager,
            nextRelationshipId,
            newManager,
            reasonHash,
            3,
            3,
            deadline,
            _sign(NEW_MANAGER_KEY, endDigest)
        );

        (AgentManagementRegistryV1.Relationship memory relationship, bool live) = managementRegistry.relationshipOf(agent);
        _assertTrue(!live, "ended relationship");
        _assertEq(relationship.manager, newManager, "new manager");
        _assertEq(uint256(relationship.revision), 4, "relationship revision");
        _assertEq(managementRegistry.nonces(agent), 4, "management nonce");
    }

    function testERC1271ManagerActivation() public {
        Mock1271Wallet contractManager = new Mock1271Wallet(manager);
        bytes32 relationshipId = keccak256("contract-manager");
        bytes32 scopes = keccak256("profile.update");
        uint64 issuedAt = uint64(block.timestamp);
        uint64 expiresAt = uint64(block.timestamp + 30 days);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _managementDigest(
            keccak256(
                abi.encode(
                    managementRegistry.ACTIVATE_RELATIONSHIP_TYPEHASH(),
                    agent,
                    address(contractManager),
                    relationshipId,
                    scopes,
                    issuedAt,
                    expiresAt,
                    true,
                    uint64(0),
                    uint256(0),
                    deadline
                )
            )
        );
        managementRegistry.activateRelationship(
            agent,
            address(contractManager),
            relationshipId,
            scopes,
            issuedAt,
            expiresAt,
            true,
            0,
            0,
            deadline,
            _sign(MANAGER_KEY, digest),
            _sign(AGENT_KEY, digest)
        );
        (AgentManagementRegistryV1.Relationship memory relationship, bool live) = managementRegistry.relationshipOf(agent);
        _assertTrue(live, "1271 live");
        _assertEq(relationship.manager, address(contractManager), "1271 manager");
    }

    function testFuzzWrongNonce(uint256 wrongNonce) public {
        if (wrongNonce == 1) wrongNonce = 2;
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 profileHash = keccak256("fuzz");
        bytes32 digest = _didDigest(
            keccak256(
                abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, profileHash, uint64(1), wrongNonce, deadline)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(AgentDIDRegistryV1.InvalidNonce.selector, 1, wrongNonce));
        didRegistry.updateProfile(agent, profileHash, 1, wrongNonce, deadline, _sign(AGENT_KEY, digest));
    }

    function testRegisteredRevisionIsNeverZero() public view {
        AgentDIDRegistryV1.AgentRecord memory record = didRegistry.recordOf(agent);
        _assertTrue(record.revision > 0, "registered revision");
    }

    function invariant_RegisteredIdentityCountersRemainMonotonic() public view {
        AgentDIDRegistryV1.AgentRecord memory record = didRegistry.recordOf(agent);
        _assertTrue(record.revision > 0, "revision must remain nonzero");
        _assertTrue(didRegistry.nonces(agent) >= record.revision, "nonce cannot trail revision");
        if (record.status == AgentDIDRegistryV1.Status.Revoked) {
            _assertTrue(!didRegistry.isActive(agent), "revoked identity cannot be active");
        }
    }

    function testRelayerHasNoUnsignedWriteAuthorityAndTermIsBounded() public {
        vm.prank(vm.addr(RELAYER_KEY));
        vm.expectRevert();
        didRegistry.updateProfile(agent, keccak256("unsigned"), 1, 1, uint64(block.timestamp + 600), "");

        vm.expectRevert(AgentManagementRegistryV1.InvalidTerm.selector);
        managementRegistry.activateRelationship(
            agent,
            manager,
            keccak256("too-long"),
            keccak256("scope"),
            uint64(block.timestamp),
            uint64(block.timestamp + 366 days),
            false,
            0,
            0,
            uint64(block.timestamp + 600),
            "",
            ""
        );
    }

    function _registerAgent() private {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 publicKeyHash = keccak256("agent-public-key");
        bytes32 documentHash = keccak256("document-1");
        bytes32 profileHash = keccak256("profile-1");
        bytes32 digest = _didDigest(
            keccak256(
                abi.encode(
                    didRegistry.REGISTER_AGENT_TYPEHASH(),
                    agent,
                    publicKeyHash,
                    documentHash,
                    profileHash,
                    uint64(0),
                    uint256(0),
                    deadline
                )
            )
        );
        vm.prank(vm.addr(RELAYER_KEY));
        didRegistry.registerAgent(agent, publicKeyHash, documentHash, profileHash, 0, 0, deadline, _sign(AGENT_KEY, digest));
    }

    function _updateProfile(bytes32 profileHash, uint64 revision, uint256 nonce) private {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(abi.encode(didRegistry.UPDATE_PROFILE_TYPEHASH(), agent, profileHash, revision, nonce, deadline))
        );
        didRegistry.updateProfile(agent, profileHash, revision, nonce, deadline, _sign(AGENT_KEY, digest));
    }

    function _updateDocument(bytes32 documentHash, uint64 revision, uint256 nonce) private {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(abi.encode(didRegistry.UPDATE_DOCUMENT_TYPEHASH(), agent, documentHash, revision, nonce, deadline))
        );
        didRegistry.updateDocument(agent, documentHash, revision, nonce, deadline, _sign(AGENT_KEY, digest));
    }

    function _revokeInstance(bytes32 credentialIdHash, uint64 revision, uint256 nonce) private {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = _didDigest(
            keccak256(
                abi.encode(didRegistry.REVOKE_INSTANCE_TYPEHASH(), agent, credentialIdHash, revision, nonce, deadline)
            )
        );
        didRegistry.revokeInstanceCredential(
            agent, credentialIdHash, revision, nonce, deadline, _sign(AGENT_KEY, digest)
        );
    }

    function _changeStatus(string memory action, uint64 revision, uint256 nonce) private {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 typeHash;
        if (keccak256(bytes(action)) == keccak256("SuspendAgent")) typeHash = didRegistry.SUSPEND_AGENT_TYPEHASH();
        else if (keccak256(bytes(action)) == keccak256("ResumeAgent")) typeHash = didRegistry.RESUME_AGENT_TYPEHASH();
        else typeHash = didRegistry.REVOKE_AGENT_TYPEHASH();
        bytes32 digest = _didDigest(keccak256(abi.encode(typeHash, agent, revision, nonce, deadline)));
        if (keccak256(bytes(action)) == keccak256("SuspendAgent")) {
            didRegistry.suspendAgent(agent, revision, nonce, deadline, _sign(AGENT_KEY, digest));
        } else if (keccak256(bytes(action)) == keccak256("ResumeAgent")) {
            didRegistry.resumeAgent(agent, revision, nonce, deadline, _sign(AGENT_KEY, digest));
        } else {
            didRegistry.revokeAgent(agent, revision, nonce, deadline, _sign(AGENT_KEY, digest));
        }
    }

    function _didDigest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", didRegistry.domainSeparator(), structHash));
    }

    function _managementDigest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", managementRegistry.domainSeparator(), structHash));
    }

    function _sign(uint256 privateKey, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertTrue(bool value, string memory message) private pure {
        require(value, message);
    }

    function _assertEq(uint256 left, uint256 right, string memory message) private pure {
        require(left == right, message);
    }

    function _assertEq(address left, address right, string memory message) private pure {
        require(left == right, message);
    }
}
