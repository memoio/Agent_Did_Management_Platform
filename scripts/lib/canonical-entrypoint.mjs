import { keccak256 } from "ethers";

export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const ENTRY_POINT_V07_RUNTIME_CODE_HASH = "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58";
export const SENDER_CREATOR_V07 = "0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C";
export const SENDER_CREATOR_V07_RUNTIME_CODE_HASH = "0x283c9d14378f5f4c4e24045b87d621d48443fa5b4af7dd7180a599b3756a7689";
export const SENDER_CREATOR_V07_RUNTIME = "0x6080600436101561000f57600080fd5b6000803560e01c63570e1a361461002557600080fd5b3461018a5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018a576004359167ffffffffffffffff9081841161018657366023850112156101865783600401358281116101825736602482870101116101825780601411610182577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec810192808411610155577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0603f81600b8501160116830190838210908211176101555792846024819482600c60209a968b9960405286845289840196603889018837830101525193013560601c5af1908051911561014d575b5073ffffffffffffffffffffffffffffffffffffffff60405191168152f35b90503861012e565b6024857f4e487b710000000000000000000000000000000000000000000000000000000081526041600452fd5b8380fd5b8280fd5b80fdfea26469706673582212207adef8895ad3393b02fab10a111d85ea80ff35366aa43995f4ea20e67f29200664736f6c63430008170033";

const IMMUTABLE_OFFSETS = [3374, 12887];

export function buildCanonicalEntryPointRuntime(entryPointArtifact) {
  const source = typeof entryPointArtifact.deployedBytecode === "string"
    ? entryPointArtifact.deployedBytecode
    : entryPointArtifact.deployedBytecode?.object;
  if (typeof source !== "string" || !/^0x[0-9a-fA-F]+$/.test(source)) {
    throw new Error("ENTRYPOINT_ARTIFACT_DEPLOYED_BYTECODE_MISSING");
  }
  const bytes = Buffer.from(source.slice(2), "hex");
  const sender = Buffer.from(SENDER_CREATOR_V07.slice(2), "hex");
  for (const offset of IMMUTABLE_OFFSETS) {
    const slot = bytes.subarray(offset, offset + sender.length);
    if (slot.length !== 20 || slot.some((value) => value !== 0)) {
      throw new Error("ENTRYPOINT_ARTIFACT_IMMUTABLE_LAYOUT_CHANGED");
    }
    sender.copy(bytes, offset);
  }
  const runtime = "0x" + bytes.toString("hex");
  if (keccak256(runtime).toLowerCase() !== ENTRY_POINT_V07_RUNTIME_CODE_HASH) {
    throw new Error("ENTRYPOINT_CANONICAL_RUNTIME_BUILD_FAILED");
  }
  if (keccak256(SENDER_CREATOR_V07_RUNTIME).toLowerCase() !== SENDER_CREATOR_V07_RUNTIME_CODE_HASH) {
    throw new Error("SENDER_CREATOR_CANONICAL_RUNTIME_INVALID");
  }
  return runtime;
}
