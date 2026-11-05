import { Interface, JsonRpcProvider, getAddress, keccak256 } from "ethers";

const chainId = 985;
const entryPointAddress = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const expectedEntryPointHash = process.env.MEMO_ENTRYPOINT_CODE_HASH
  || "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58";
const primaryUrl = required("MEMO_PRIMARY_RPC_URL");
const secondaryUrl = required("MEMO_SECONDARY_RPC_URL");
const bundlerUrl = required("MEMO_BUNDLER_URL");
if (!primaryUrl.startsWith("https://") || !secondaryUrl.startsWith("https://") || !bundlerUrl.startsWith("https://")) {
  throw new Error("MAINNET_PREFLIGHT_REQUIRES_HTTPS_ENDPOINTS");
}
if (primaryUrl === secondaryUrl) throw new Error("SECONDARY_RPC_MUST_BE_INDEPENDENT");

const primary = new JsonRpcProvider(primaryUrl, chainId, { staticNetwork: true });
const secondary = new JsonRpcProvider(secondaryUrl, chainId, { staticNetwork: true });
const [primaryNetwork, secondaryNetwork, primaryHead, secondaryHead] = await Promise.all([
  primary.getNetwork(), secondary.getNetwork(), primary.getBlockNumber(), secondary.getBlockNumber(),
]);
if (Number(primaryNetwork.chainId) !== chainId || Number(secondaryNetwork.chainId) !== chainId) throw new Error("CHAIN_ID_MISMATCH");
if (Math.abs(primaryHead - secondaryHead) > 3) throw new Error("RPC_HEAD_DIVERGENCE");
const compareAt = Math.min(primaryHead, secondaryHead);
const [primaryBlock, secondaryBlock] = await Promise.all([primary.getBlock(compareAt), secondary.getBlock(compareAt)]);
if (!primaryBlock?.hash || primaryBlock.hash !== secondaryBlock?.hash) throw new Error("RPC_CANONICAL_HEAD_MISMATCH");

const entryPointCode = await primary.getCode(entryPointAddress);
if (entryPointCode === "0x") throw new Error("ENTRYPOINT_V07_NOT_DEPLOYED");
if (keccak256(entryPointCode).toLowerCase() !== expectedEntryPointHash.toLowerCase()) throw new Error("ENTRYPOINT_CODE_HASH_MISMATCH");
const entryPoint = new Interface(["function balanceOf(address account) view returns (uint256)"]);
const traceCall = {
  to: entryPointAddress,
  data: entryPoint.encodeFunctionData("balanceOf", ["0x0000000000000000000000000000000000000000"]),
};
await primary.send("debug_traceCall", [traceCall, "latest", {}]);
await primary.send("eth_getTransactionReceipt", ["0x" + "00".repeat(32)]);
const fee = await primary.getFeeData();
if (!fee.gasPrice && !fee.maxFeePerGas) throw new Error("FEE_DATA_UNAVAILABLE");

let finalized = false;
try {
  finalized = Boolean(await primary.getBlock("finalized"));
} catch {
  finalized = false;
}
const supported = await bundlerRequest("eth_supportedEntryPoints", []);
if (!Array.isArray(supported) || !supported.some((value) => getAddress(value) === getAddress(entryPointAddress))) {
  throw new Error("BUNDLER_ENTRYPOINT_UNSUPPORTED");
}

process.stdout.write(JSON.stringify({
  valid: true,
  chainId,
  primaryHead,
  secondaryHead,
  canonicalHeadHash: primaryBlock.hash,
  entryPoint: entryPointAddress,
  entryPointCodeHash: expectedEntryPointHash,
  capabilities: { debugTraceCall: true, feeData: true, receipt: true, finalizedTag: finalized, bundlerV07: true },
}) + "\n");

async function bundlerRequest(method, params) {
  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("BUNDLER_HTTP_" + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error("BUNDLER_RPC:" + payload.error.message);
  return payload.result;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("MISSING_CONFIG:" + name);
  return value;
}
