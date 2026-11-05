import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Interface, JsonRpcProvider, getAddress, keccak256 } from "ethers";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ENTRY_POINT_CODE_HASH = "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58";
const path = resolve(process.argv[2] || process.env.MEMO_DEPLOYMENT_MANIFEST || "deploy/local/985.json");
const manifest = JSON.parse(await readFile(path, "utf8"));
if (manifest.schema !== "memo.agent-did-deployment/1") fail("INVALID_SCHEMA");
if (manifest.chainId !== 985) fail("INVALID_CHAIN_ID");
if (!["local", "preprod", "production"].includes(manifest.environment)) fail("INVALID_ENVIRONMENT");
if (getAddress(manifest.entryPoint.address) !== getAddress(ENTRY_POINT) || manifest.entryPoint.version !== "0.7") {
  fail("INVALID_ENTRYPOINT");
}
for (const section of ["entryPoint", "simpleAccountFactory", "didRegistry", "managementRegistry"]) {
  getAddress(manifest[section].address);
  if (!/^0x[0-9a-fA-F]{64}$/.test(manifest[section].runtimeCodeHash)) fail("INVALID_CODE_HASH:" + section);
}
getAddress(manifest.relayerSmartAccount.address);
getAddress(manifest.relayerSmartAccount.ownerAddress);
if (!/^0x[0-9a-fA-F]{64}$/.test(manifest.relayerSmartAccount.runtimeCodeHash)) fail("INVALID_CODE_HASH:relayerSmartAccount");
if (manifest.entryPoint.runtimeCodeHash.toLowerCase() !== ENTRY_POINT_CODE_HASH) fail("ENTRYPOINT_CODE_HASH_MISMATCH");
if (manifest.environment !== "local") {
  if (!manifest.publicRpcUrl.startsWith("https://") || !manifest.publicWssUrl?.startsWith("wss://")) {
    fail("INCOMPLETE_PRODUCTION_NETWORK_ENDPOINTS");
  }
  if (!new Set(["kms", "hsm"]).has(manifest.relayerSmartAccount.ownerProvider)) {
    fail("PRODUCTION_RELAYER_REQUIRES_KMS_OR_HSM");
  }
}
if (!manifest.publicRpcUrl || !manifest.nativeCurrency?.name || !manifest.nativeCurrency?.symbol) fail("INCOMPLETE_PUBLIC_NETWORK");
if (process.argv.includes("--online")) {
  const rpc = process.env.MEMO_PRIMARY_RPC_URL;
  if (!rpc) fail("MEMO_PRIMARY_RPC_URL_REQUIRED");
  const provider = new JsonRpcProvider(rpc, 985, { staticNetwork: true });
  if (Number((await provider.getNetwork()).chainId) !== 985) fail("RPC_CHAIN_ID_MISMATCH");
  for (const section of ["entryPoint", "simpleAccountFactory", "didRegistry", "managementRegistry"]) {
    const code = await provider.getCode(manifest[section].address);
    if (code === "0x" || keccak256(code).toLowerCase() !== manifest[section].runtimeCodeHash.toLowerCase()) {
      fail("ONCHAIN_CODE_HASH_MISMATCH:" + section);
    }
  }
  const smartAccountCode = await provider.getCode(manifest.relayerSmartAccount.address);
  if (smartAccountCode === "0x" || keccak256(smartAccountCode).toLowerCase() !== manifest.relayerSmartAccount.runtimeCodeHash.toLowerCase()) {
    fail("RELAYER_SMART_ACCOUNT_CODE_HASH_MISMATCH");
  }
  const account = new Interface(["function owner() view returns (address)"]);
  const ownerData = await provider.call({
    to: manifest.relayerSmartAccount.address,
    data: account.encodeFunctionData("owner"),
  });
  const owner = getAddress(account.decodeFunctionResult("owner", ownerData)[0]);
  if (owner !== getAddress(manifest.relayerSmartAccount.ownerAddress)) fail("RELAYER_SMART_ACCOUNT_OWNER_MISMATCH");
  const entryPoint = new Interface(["function balanceOf(address) view returns (uint256)"]);
  const depositResult = await provider.call({
    to: ENTRY_POINT,
    data: entryPoint.encodeFunctionData("balanceOf", [manifest.relayerSmartAccount.address]),
  });
  const deposit = entryPoint.decodeFunctionResult("balanceOf", depositResult)[0];
  if (deposit <= 0n) fail("RELAYER_ENTRYPOINT_DEPOSIT_EMPTY");
}
process.stdout.write(JSON.stringify({ valid: true, path, environment: manifest.environment, chainId: manifest.chainId }) + "\n");

function fail(code) {
  throw new Error(code);
}
