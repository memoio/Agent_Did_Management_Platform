import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import {
  CHAIN_ID,
  DID_ACTION_TYPES,
  ENTRY_POINT_V07,
  ENTRY_POINT_V07_RUNTIME_CODE_HASH,
  actionTypes,
  assertOperationTransition,
  didDomain,
  didForAddress,
  digestTypedAction,
  recoverTypedActionSigner,
} from "../../packages/protocol/src/index.js";

describe("chain-985 protocol freeze", () => {
  it("freezes chain, EntryPoint v0.7, and exact RegisterAgent fields", async () => {
    expect(CHAIN_ID).toBe(985);
    expect(ENTRY_POINT_V07).toBe("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
    expect(ENTRY_POINT_V07_RUNTIME_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/);
    const wallet = Wallet.createRandom();
    const domain = didDomain("0x1000000000000000000000000000000000000001");
    const message = {
      identityAccount: wallet.address,
      identityPublicKeyHash: "0x" + "11".repeat(32),
      documentHash: "0x" + "22".repeat(32),
      profileHash: "0x" + "33".repeat(32),
      expectedRevision: "0",
      nonce: "0",
      deadline: "2000000000",
    };
    const digest = digestTypedAction(domain, "RegisterAgent", message);
    const signature = await wallet.signTypedData(domain, actionTypes("RegisterAgent"), message);
    expect(recoverTypedActionSigner(domain, "RegisterAgent", message, signature)).toBe(wallet.address);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(DID_ACTION_TYPES.RegisterAgent.map((field) => field.name)).toEqual(Object.keys(message));
    expect(didForAddress(wallet.address)).toBe(`did:memo:agent:985:${wallet.address.toLowerCase()}`);
  });

  it("rejects unknown signed fields, wrong domains, and invalid operation transitions", () => {
    const domain = didDomain("0x1000000000000000000000000000000000000001");
    const message = {
      identityAccount: "0x2000000000000000000000000000000000000002",
      expectedRevision: "1",
      nonce: "1",
      deadline: "2000000000",
      arbitraryDigest: "0x" + "00".repeat(32),
    };
    expect(() => digestTypedAction(domain, "SuspendAgent", message)).toThrow(/UNKNOWN_OR_MISSING_SIGNED_FIELD/);
    expect(() => digestTypedAction({ ...domain, chainId: 31337 } as never, "SuspendAgent", {
      identityAccount: message.identityAccount,
      expectedRevision: "1",
      nonce: "1",
      deadline: "2000000000",
    })).toThrow(/INVALID_EIP712_DOMAIN/);
    expect(() => assertOperationTransition("CONFIRMED", "SUBMITTED")).toThrow(/INVALID_OPERATION_TRANSITION/);
    expect(() => assertOperationTransition("INCLUDED", "CONFIRMED")).not.toThrow();
  });
});
