import {
  configuredProviders,
  opbnbTestnet,
} from "../../dist/packages/chain-adapter/src/index.js";

export const network = opbnbTestnet;

export function providers() {
  return configuredProviders();
}
export async function inspectNetwork(rpcs) {
  const samples = await Promise.all(
    rpcs.map(async (p) => {
      if (BigInt(await p.send("eth_chainId", [])) !== 5611n)
        throw new Error("NETWORK_MISMATCH");
      const genesis = await p.getBlock(0),
        head = await p.getBlock("latest");
      if (!genesis?.hash || !head?.hash)
        throw new Error("MISSING_BLOCK_EVIDENCE");
      return { genesisHash: genesis.hash, headNumber: head.number };
    }),
  );
  if (samples[0].genesisHash !== samples[1].genesisHash)
    throw new Error("GENESIS_MISMATCH");
  if (samples[0].genesisHash !== network.genesisHash)
    throw new Error("GENESIS_MISMATCH");
  const height = Math.min(...samples.map((s) => s.headNumber));
  const blocks = await Promise.all(rpcs.map((p) => p.getBlock(height)));
  if (!blocks[0]?.hash || blocks[0].hash !== blocks[1]?.hash)
    throw new Error("RPC_FORK");
  const finalized = await Promise.all(
    rpcs.map(async (p) => {
      try {
        const b = await p.getBlock("finalized");
        return b ? { number: b.number, hash: b.hash } : null;
      } catch {
        return null;
      }
    }),
  );
  // Read-only capability probe; no empty-result success substitution on errors.
  await Promise.all(
    rpcs.map((p) =>
      p.getLogs({
        fromBlock: height,
        toBlock: height,
        address: "0x0000000000000000000000000000000000000001",
      }),
    ),
  );
  return {
    schema: "memo.agent-chain-network-check/1",
    checkedAt: new Date().toISOString(),
    network: { ...network, genesisHash: samples[0].genesisHash },
    endpoints: samples,
    commonBlock: {
      number: height,
      hash: blocks[0].hash,
      timestamp: blocks[0].timestamp,
    },
    finalized,
    note: "Read-only network evidence, not a deployment, finality-policy approval or business E2E acceptance.",
  };
}
export function safeFailure(error) {
  const known = new Set([
    "SECONDARY_RPC_REQUIRED",
    "INDEPENDENT_RPC_REQUIRED",
    "HTTPS_RPC_REQUIRED",
    "NETWORK_MISMATCH",
    "MISSING_BLOCK_EVIDENCE",
    "GENESIS_MISMATCH",
    "RPC_FORK",
    "MANIFEST_PATH_REQUIRED",
    "SIGNER_MODULE_REQUIRED",
    "DEPLOYMENT_SETTINGS_REQUIRED",
    "DEPLOYMENT_DIRECTORY_MUST_BE_OUTSIDE_REPO",
    "DEPLOYMENT_ALREADY_STARTED",
    "SOURCE_TREE_MUST_BE_COMMITTED",
    "GAS_PRICE_OUTSIDE_BUDGET",
    "GAS_LIMIT_OUTSIDE_BUDGET",
    "SIGNER_ADDRESS_MISMATCH",
    "DEPLOYER_NONCE_CHANGED",
    "INSUFFICIENT_FUNDS",
    "INVALID_SIGNED_TRANSACTION",
    "CHECKPOINT_MISMATCH",
    "DEPLOYMENT_REVERTED_OR_UNKNOWN",
    "DEPLOYMENT_CODE_MISMATCH",
    "MANIFEST_ALREADY_EXISTS",
    "DEPLOYMENT_LOCKED",
  ]);
  console.error(
    JSON.stringify({
      ok: false,
      error: known.has(error?.message)
        ? error.message
        : error?.code && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : "CHAIN_OPERATION_FAILED",
    }),
  );
  process.exitCode = 1;
}
