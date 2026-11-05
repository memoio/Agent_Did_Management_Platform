import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { encodeRegistryCall } from "../../apps/chain-worker/src/worker.js";

describe("Relayer calldata boundary", () => {
  it("encodes the original Agent signature into RegisterAgent without changing its semantics", () => {
    const signature = "0x" + "12".repeat(65);
    const message = {
      identityAccount: "0x2000000000000000000000000000000000000002",
      identityPublicKeyHash: "0x" + "11".repeat(32),
      documentHash: "0x" + "22".repeat(32),
      profileHash: "0x" + "33".repeat(32),
      expectedRevision: "0",
      nonce: "0",
      deadline: "2000000000",
    };
    const encoded = encodeRegistryCall("RegisterAgent", message, { agentSignature: signature });
    const registry = new Interface(["function registerAgent(address,bytes32,bytes32,bytes32,uint64,uint256,uint64,bytes)"]);
    const decoded = registry.decodeFunctionData("registerAgent", encoded);
    expect(decoded[0]).toBe("0x2000000000000000000000000000000000000002");
    expect(decoded[7]).toBe(signature);
  });

  it("requires all three signatures for a management transfer", () => {
    const message = {
      agent: "0x2000000000000000000000000000000000000002",
      oldManager: "0x3000000000000000000000000000000000000003",
      newManager: "0x4000000000000000000000000000000000000004",
      oldRelationshipIdHash: "0x" + "11".repeat(32),
      newRelationshipIdHash: "0x" + "22".repeat(32),
      scopesHash: "0x" + "33".repeat(32),
      expiresAt: "2000000000",
      discoverable: false,
      expectedRevision: "2",
      nonce: "3",
      deadline: "1900000000",
    };
    expect(() => encodeRegistryCall("TransferRelationship", message, { agentSignature: "0x01", oldManagerSignature: "0x02" }))
      .toThrow(/MISSING_REQUIRED_SIGNATURE/);
    expect(encodeRegistryCall("TransferRelationship", message, {
      agentSignature: "0x01", oldManagerSignature: "0x02", newManagerSignature: "0x03",
    })).toMatch(/^0x[0-9a-f]+$/);
  });
});
