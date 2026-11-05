import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  ENTRY_POINT_V07 as ENTRY_POINT,
  ENTRY_POINT_V07_RUNTIME_CODE_HASH as OFFICIAL_ENTRY_POINT_HASH,
  SENDER_CREATOR_V07 as SENDER_CREATOR,
  SENDER_CREATOR_V07_RUNTIME_CODE_HASH as OFFICIAL_SENDER_CREATOR_HASH,
  SENDER_CREATOR_V07_RUNTIME as OFFICIAL_SENDER_CREATOR_RUNTIME,
  buildCanonicalEntryPointRuntime,
} from "./lib/canonical-entrypoint.mjs";

const LOCAL_MNEMONIC = "test test test test test test test test test test test junk";
const environment = process.argv[2] || process.env.MEMO_ENVIRONMENT || "local";
if (!["local", "preprod", "production"].includes(environment)) fail("INVALID_DEPLOYMENT_ENVIRONMENT");

const rpcUrl = process.env.MEMO_PRIMARY_RPC_URL || (environment === "local" ? "http://127.0.0.1:9545" : "");
if (!rpcUrl) fail("MEMO_PRIMARY_RPC_URL_REQUIRED");
if (environment !== "local" && !rpcUrl.startsWith("https://")) fail("MAINNET_DEPLOYMENT_REQUIRES_HTTPS_RPC");
validateDeploymentSettings();
const provider = new JsonRpcProvider(rpcUrl, 985, { staticNetwork: true });
const network = await provider.getNetwork();
if (Number(network.chainId) !== 985) fail("CHAIN_ID_MISMATCH");

if (environment === "production" && process.env.MEMO_PRODUCTION_DEPLOYMENT_ACK !== "DEPLOY_NEW_EMPTY_PRODUCTION") {
  fail("PRODUCTION_DEPLOYMENT_ACK_REQUIRED");
}

const deployer = new NonceManager(new Wallet(deployerPrivateKey(), provider));
const ownerAddress = relayerOwnerAddress();
const manifestPath = resolve(process.env.MEMO_DEPLOYMENT_MANIFEST || "deploy/" + environment + "/985.json");
const entryPointCodeHash = await ensureEntryPoint();
if (await exists(manifestPath) && process.env.MEMO_FORCE_NEW_DEPLOYMENT !== "true") {
  let existing = JSON.parse(await readFile(manifestPath, "utf8"));
  if (environment === "local") existing = await upgradeLocalManifest(existing, entryPointCodeHash);
  if (await deploymentMatchesChain(existing)) {
    process.stdout.write(JSON.stringify({ reused: true, manifestPath }) + "\n");
    process.exit(0);
  }
  if (environment !== "local") fail("EXISTING_MANIFEST_ONCHAIN_MISMATCH");
  const backupPath = `${manifestPath}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await rename(manifestPath, backupPath);
  process.stderr.write(JSON.stringify({ staleManifestBackedUp: backupPath }) + "\n");
}

const didArtifact = await artifact("packages/contracts/out/AgentDIDRegistryV1.sol/AgentDIDRegistryV1.json");
const managementArtifact = await artifact("packages/contracts/out/AgentManagementRegistryV1.sol/AgentManagementRegistryV1.json");
const factoryArtifact = await artifact("node_modules/@account-abstraction/contracts/artifacts/SimpleAccountFactory.json");

const did = await deploy(didArtifact, []);
const didReceipt = await did.deploymentTransaction().wait();
const management = await deploy(managementArtifact, [await did.getAddress()]);
const managementReceipt = await management.deploymentTransaction().wait();
const accountFactory = await deploy(factoryArtifact, [ENTRY_POINT]);
const factoryReceipt = await accountFactory.deploymentTransaction().wait();

const simpleFactory = new Contract(
  await accountFactory.getAddress(),
  [
    "function getAddress(address owner,uint256 salt) view returns (address)",
    "function createAccount(address owner,uint256 salt) returns (address)",
  ],
  deployer,
);
const smartAccount = getAddress(await simpleFactory.getFunction("getAddress").staticCall(ownerAddress, 0));
if (await provider.getCode(smartAccount) === "0x") {
  await (await simpleFactory.getFunction("createAccount").send(ownerAddress, 0)).wait();
}

const entryPoint = new Contract(
  ENTRY_POINT,
  [
    "function balanceOf(address account) view returns (uint256)",
    "function depositTo(address account) payable",
  ],
  deployer,
);
const targetDeposit = BigInt(process.env.MEMO_INITIAL_ENTRYPOINT_DEPOSIT_WEI || "1000000000000000000");
const currentDeposit = await entryPoint.balanceOf(smartAccount);
if (currentDeposit < targetDeposit) {
  await (await entryPoint.depositTo(smartAccount, { value: targetDeposit - currentDeposit })).wait();
}

const [didAddress, managementAddress, factoryAddress] = await Promise.all([
  did.getAddress(),
  management.getAddress(),
  accountFactory.getAddress(),
]);
const [didCode, managementCode, factoryCode, smartAccountCode] = await Promise.all([
  provider.getCode(didAddress),
  provider.getCode(managementAddress),
  provider.getCode(factoryAddress),
  provider.getCode(smartAccount),
]);
const smartAccountOwner = getAddress(await new Contract(
  smartAccount,
  ["function owner() view returns (address)"],
  provider,
).owner());
if (smartAccountOwner !== getAddress(ownerAddress)) fail("RELAYER_SMART_ACCOUNT_OWNER_MISMATCH");
const manifest = {
  schema: "memo.agent-did-deployment/1",
  environment,
  networkName: process.env.MEMO_NETWORK_NAME || (environment === "local" ? "MEMO Mainnet Local" : "MEMO Mainnet"),
  chainId: 985,
  publicRpcUrl: process.env.MEMO_PUBLIC_RPC_URL || (environment === "local" ? rpcUrl : ""),
  ...(process.env.MEMO_PUBLIC_WSS_URL ? { publicWssUrl: process.env.MEMO_PUBLIC_WSS_URL } : {}),
  nativeCurrency: {
    name: requiredSetting("MEMO_NATIVE_CURRENCY_NAME", environment === "local" ? "MEMO" : undefined),
    symbol: requiredSetting("MEMO_NATIVE_CURRENCY_SYMBOL", environment === "local" ? "MEMO" : undefined),
    decimals: Number(process.env.MEMO_NATIVE_CURRENCY_DECIMALS || 18),
  },
  entryPoint: { address: ENTRY_POINT, version: "0.7", runtimeCodeHash: entryPointCodeHash },
  simpleAccountFactory: {
    address: factoryAddress,
    deploymentBlock: Number(factoryReceipt.blockNumber),
    runtimeCodeHash: keccak256(factoryCode),
  },
  relayerSmartAccount: {
    address: smartAccount,
    ownerAddress: smartAccountOwner,
    ownerProvider: process.env.MEMO_RELAYER_OWNER_PROVIDER || (environment === "local" ? "dev-private-key" : "kms"),
    runtimeCodeHash: keccak256(smartAccountCode),
  },
  didRegistry: {
    address: didAddress,
    deploymentBlock: Number(didReceipt.blockNumber),
    runtimeCodeHash: keccak256(didCode),
    abiHash: abiHash(didArtifact.abi),
  },
  managementRegistry: {
    address: managementAddress,
    deploymentBlock: Number(managementReceipt.blockNumber),
    runtimeCodeHash: keccak256(managementCode),
    abiHash: abiHash(managementArtifact.abi),
  },
  finality: {
    preferFinalizedTag: environment !== "local",
    fallbackConfirmations: Number(process.env.MEMO_REQUIRED_CONFIRMATIONS || (environment === "local" ? 2 : 12)),
  },
  generatedAt: new Date().toISOString(),
};
await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644, flag: "wx" });
process.stdout.write(JSON.stringify({
  deployed: true,
  environment,
  manifestPath,
  didRegistry: didAddress,
  managementRegistry: managementAddress,
  simpleAccountFactory: factoryAddress,
  relayerSmartAccount: smartAccount,
}) + "\n");

async function ensureEntryPoint() {
  let code = await provider.send("eth_getCode", [ENTRY_POINT, "latest"]);
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(rpcUrl);
  const isolatedDockerNetwork = rpcUrl === "http://anvil:8545" && process.env.MEMO_DOCKER_LOCAL_NETWORK === "true";
  const isIsolatedLocal = environment === "local" && (loopback || isolatedDockerNetwork);
  if (code === "0x" || keccak256(code).toLowerCase() !== OFFICIAL_ENTRY_POINT_HASH) {
    if (!isIsolatedLocal) fail(code === "0x" ? "ENTRYPOINT_V07_NOT_DEPLOYED" : "ENTRYPOINT_CODE_HASH_MISMATCH");
    const entryArtifact = await artifact("node_modules/@account-abstraction/contracts/artifacts/EntryPoint.json");
    await provider.send("anvil_setCode", [ENTRY_POINT, buildCanonicalEntryPointRuntime(entryArtifact)]);
    await provider.send("anvil_setCode", [SENDER_CREATOR, OFFICIAL_SENDER_CREATOR_RUNTIME]);
    code = await provider.send("eth_getCode", [ENTRY_POINT, "latest"]);
  }
  const hash = keccak256(code);
  const expected = process.env.MEMO_ENTRYPOINT_CODE_HASH || OFFICIAL_ENTRY_POINT_HASH;
  if (hash.toLowerCase() !== expected.toLowerCase() || hash.toLowerCase() !== OFFICIAL_ENTRY_POINT_HASH) {
    fail("ENTRYPOINT_CODE_HASH_MISMATCH");
  }
  if (isIsolatedLocal) {
    const senderCode = await provider.send("eth_getCode", [SENDER_CREATOR, "latest"]);
    if (senderCode === "0x" || keccak256(senderCode).toLowerCase() !== OFFICIAL_SENDER_CREATOR_HASH) {
      await provider.send("anvil_setCode", [SENDER_CREATOR, OFFICIAL_SENDER_CREATOR_RUNTIME]);
    }
  }
  return hash;
}

async function deploymentMatchesChain(manifest) {
  try {
    if (manifest?.schema !== "memo.agent-did-deployment/1" || manifest.chainId !== 985 || manifest.environment !== environment) {
      return false;
    }
    const sections = ["entryPoint", "simpleAccountFactory", "didRegistry", "managementRegistry"];
    for (const section of sections) {
      const address = getAddress(manifest?.[section]?.address);
      const expectedHash = String(manifest?.[section]?.runtimeCodeHash || "");
      const code = await provider.getCode(address);
      if (code === "0x" || !/^0x[0-9a-fA-F]{64}$/.test(expectedHash) || keccak256(code).toLowerCase() !== expectedHash.toLowerCase()) {
        return false;
      }
    }
    if (manifest.entryPoint.runtimeCodeHash.toLowerCase() !== OFFICIAL_ENTRY_POINT_HASH) return false;
    const smartAccount = getAddress(manifest.relayerSmartAccount.address);
    const smartCode = await provider.getCode(smartAccount);
    if (smartCode === "0x" || keccak256(smartCode).toLowerCase() !== String(manifest.relayerSmartAccount.runtimeCodeHash).toLowerCase()) {
      return false;
    }
    const owner = getAddress(await new Contract(smartAccount, ["function owner() view returns (address)"], provider).owner());
    return owner === getAddress(manifest.relayerSmartAccount.ownerAddress)
      && owner === getAddress(ownerAddress);
  } catch {
    return false;
  }
}

async function upgradeLocalManifest(manifest, entryPointHash) {
  if (manifest?.schema !== "memo.agent-did-deployment/1" || manifest.chainId !== 985 || manifest.environment !== "local") {
    return manifest;
  }
  try {
    const account = getAddress(manifest.relayerSmartAccount.address);
    const code = await provider.getCode(account);
    if (code === "0x") return manifest;
    const owner = getAddress(await new Contract(account, ["function owner() view returns (address)"], provider).owner());
    if (owner !== getAddress(ownerAddress)) fail("RELAYER_SMART_ACCOUNT_OWNER_MISMATCH");
    const upgraded = {
      ...manifest,
      entryPoint: { ...manifest.entryPoint, runtimeCodeHash: entryPointHash },
      relayerSmartAccount: {
        ...manifest.relayerSmartAccount,
        ownerAddress: owner,
        runtimeCodeHash: keccak256(code),
      },
    };
    if (JSON.stringify(upgraded) !== JSON.stringify(manifest)) await replaceJson(manifestPath, upgraded);
    return upgraded;
  } catch (error) {
    if (error instanceof Error && error.message === "RELAYER_SMART_ACCOUNT_OWNER_MISMATCH") throw error;
    return manifest;
  }
}

async function deploy(contractArtifact, args) {
  const factory = new ContractFactory(contractArtifact.abi, bytecode(contractArtifact), deployer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function artifact(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function bytecode(value) {
  return typeof value.bytecode === "string" ? value.bytecode : value.bytecode.object;
}

function abiHash(abi) {
  return keccak256(toUtf8Bytes(JSON.stringify(abi)));
}

function deployerPrivateKey() {
  if (process.env.MEMO_DEPLOYER_PRIVATE_KEY) return process.env.MEMO_DEPLOYER_PRIVATE_KEY;
  if (environment !== "local") fail("MEMO_DEPLOYER_PRIVATE_KEY_REQUIRED");
  return HDNodeWallet.fromPhrase(process.env.MEMO_LOCAL_MNEMONIC || LOCAL_MNEMONIC, "", "m/44'/60'/0'/0/0").privateKey;
}

function relayerOwnerAddress() {
  if (process.env.MEMO_RELAYER_OWNER_ADDRESS) return getAddress(process.env.MEMO_RELAYER_OWNER_ADDRESS);
  if (process.env.MEMO_RELAYER_OWNER_PRIVATE_KEY) return new Wallet(process.env.MEMO_RELAYER_OWNER_PRIVATE_KEY).address;
  if (environment !== "local") fail("MEMO_RELAYER_OWNER_ADDRESS_REQUIRED");
  return HDNodeWallet.fromPhrase(process.env.MEMO_LOCAL_MNEMONIC || LOCAL_MNEMONIC, "", "m/44'/60'/0'/0/2").address;
}

function validateDeploymentSettings() {
  if (environment === "local") return;
  const secondary = requiredSetting("MEMO_SECONDARY_RPC_URL");
  const bundler = requiredSetting("MEMO_BUNDLER_URL");
  const publicRpc = requiredSetting("MEMO_PUBLIC_RPC_URL");
  const publicWss = requiredSetting("MEMO_PUBLIC_WSS_URL");
  for (const value of [secondary, bundler, publicRpc]) {
    if (!value.startsWith("https://")) fail("MAINNET_DEPLOYMENT_REQUIRES_HTTPS_ENDPOINTS");
  }
  if (!publicWss.startsWith("wss://")) fail("MAINNET_DEPLOYMENT_REQUIRES_WSS_ENDPOINT");
  if (secondary === rpcUrl) fail("SECONDARY_RPC_MUST_BE_INDEPENDENT");
  requiredSetting("MEMO_NETWORK_NAME");
  requiredSetting("MEMO_NATIVE_CURRENCY_NAME");
  requiredSetting("MEMO_NATIVE_CURRENCY_SYMBOL");
  const ownerProvider = requiredSetting("MEMO_RELAYER_OWNER_PROVIDER");
  if (!new Set(["kms", "hsm"]).has(ownerProvider)) fail("PRODUCTION_RELAYER_REQUIRES_KMS_OR_HSM");
}

async function replaceJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o644, flag: "wx" });
  await rename(temporary, path);
}

function requiredSetting(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) fail(name + "_REQUIRED");
  return value;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function fail(code) {
  throw new Error(code);
}
