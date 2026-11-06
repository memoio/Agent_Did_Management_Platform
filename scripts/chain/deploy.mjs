import {
  ContractFactory,
  Transaction,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  OpbnbChainAdapter,
  sha256,
  validateManifest,
  configuredSigner,
} from "../../dist/packages/chain-adapter/src/index.js";
import { providers, inspectNetwork, safeFailure } from "./network.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
let rpcs = [],
  lock,
  lockPath;
async function durableJson(filename, data) {
  const temporary = `${filename}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, filename);
  if (process.platform !== "win32") {
    const dir = await open(path.dirname(filename), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
function positiveInteger(value) {
  return (
    /^(?:[1-9][0-9]*)$/.test(value ?? "") && Number.isSafeInteger(Number(value))
  );
}
try {
  const execute = process.argv.includes("--execute");
  const env = process.env;
  const id = env.MEMO_DEPLOYMENT_ID;
  const deployer =
    env.MEMO_DEPLOYER_ADDRESS && getAddress(env.MEMO_DEPLOYER_ADDRESS);
  const mode = env.MEMO_FINALITY_MODE;
  if (
    !id ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(id) ||
    !deployer ||
    !["finalized-tag", "confirmations"].includes(mode) ||
    !positiveInteger(env.MEMO_FALLBACK_CONFIRMATIONS) ||
    !positiveInteger(env.MEMO_MAX_REORG_DEPTH) ||
    !positiveInteger(env.MEMO_GAS_PRICE_CAP_WEI) ||
    !positiveInteger(env.MEMO_GAS_LIMIT_CAP)
  )
    throw new Error("DEPLOYMENT_SETTINGS_REQUIRED");
  rpcs = providers();
  const checked = await inspectNetwork(rpcs);
  const artifacts = {};
  for (const name of ["AgentDIDRegistry", "AgentManagementRegistry"])
    artifacts[name] = JSON.parse(
      await readFile(
        path.join(root, "packages/contracts/artifacts", `${name}.json`),
        "utf8",
      ),
    );
  const directory =
    env.MEMO_DEPLOYMENT_DIR && path.resolve(env.MEMO_DEPLOYMENT_DIR);
  const relativeDirectory = directory && path.relative(root, directory);
  const outsideRepository =
    relativeDirectory &&
    (relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDirectory));
  if (
    !directory ||
    !path.isAbsolute(env.MEMO_DEPLOYMENT_DIR) ||
    !outsideRepository
  )
    throw new Error("DEPLOYMENT_DIRECTORY_MUST_BE_OUTSIDE_REPO");
  const fileId = encodeURIComponent(id);
  const filename = path.join(directory, `${fileId}.checkpoint.json`);
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(filename, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const finality = {
    mode,
    fallbackConfirmations: Number(env.MEMO_FALLBACK_CONFIRMATIONS),
    maxReorgDepth: Number(env.MEMO_MAX_REORG_DEPTH),
  };
  if (
    checkpoint &&
    (checkpoint.deploymentId !== id ||
      checkpoint.sourceCommit !== sourceCommit ||
      checkpoint.deployer !== deployer ||
      checkpoint.genesisHash !== checked.network.genesisHash)
  )
    throw new Error("DEPLOYMENT_ALREADY_STARTED");
  if (
    checkpoint &&
    JSON.stringify(checkpoint.finality) !== JSON.stringify(finality)
  )
    throw new Error("DEPLOYMENT_ALREADY_STARTED");
  const pending = await Promise.all(
    rpcs.map((p) => p.getTransactionCount(deployer, "pending")),
  );
  if (pending[0] !== pending[1]) throw new Error("RPC_FORK");
  const nonce = checkpoint?.startNonce ?? pending[0];
  const didAddress = getCreateAddress({ from: deployer, nonce });
  const managementAddress = getCreateAddress({
    from: deployer,
    nonce: nonce + 1,
  });
  const price = BigInt(await rpcs[0].send("eth_gasPrice", []));
  if (price > BigInt(env.MEMO_GAS_PRICE_CAP_WEI) || price <= 0n)
    throw new Error("GAS_PRICE_OUTSIDE_BUDGET");
  const requests = [];
  for (const [index, name] of [
    "AgentDIDRegistry",
    "AgentManagementRegistry",
  ].entries()) {
    const artifact = artifacts[name];
    const factory = new ContractFactory(artifact.abi, artifact.bytecode);
    const request = await factory.getDeployTransaction(
      ...(index ? [didAddress] : []),
    );
    requests.push({
      name,
      to: index ? managementAddress : didAddress,
      request,
      nonce: nonce + index,
    });
  }
  // Management's constructor calls the DID registry, so its estimate is possible only after DID deployment.
  const firstEstimate = checkpoint?.entries?.AgentDIDRegistry
    ? null
    : await rpcs[0].estimateGas({ ...requests[0].request, from: deployer });
  const preview = {
    execute,
    network: checked.network,
    deploymentId: id,
    sourceCommit,
    deployer,
    predicted: {
      didRegistry: didAddress,
      managementRegistry: managementAddress,
    },
    didEstimatedL2Gas: firstEstimate?.toString() ?? "already journaled",
    gasPriceWei: price.toString(),
    managementEstimatedL2Gas: "estimated immediately after DID deployment",
    l1Fee:
      "not included in L2 estimate; keep additional tBNB reserve and read receipts",
    finality,
  };
  if (!execute) {
    console.log(JSON.stringify(preview, null, 2));
  } else {
    if (
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim()
    )
      throw new Error("SOURCE_TREE_MUST_BE_COMMITTED");
    if (!env.MEMO_SIGNER_MODULE_PATH && !env.MEMO_RELAYER_PRIVATE_KEY)
      throw new Error("SIGNER_MODULE_REQUIRED");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lockPath = path.join(directory, `${fileId}.lock`);
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("DEPLOYMENT_LOCKED");
      throw error;
    }
    let currentCheckpoint;
    try {
      currentCheckpoint = JSON.parse(await readFile(filename, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (JSON.stringify(currentCheckpoint) !== JSON.stringify(checkpoint))
      throw new Error("DEPLOYMENT_ALREADY_STARTED");
    const signer = await configuredSigner(rpcs[0], {
      ...env,
      MEMO_RELAYER_ADDRESS: deployer,
    });
    if (getAddress(await signer.getAddress()) !== deployer)
      throw new Error("SIGNER_ADDRESS_MISMATCH");
    checkpoint ??= {
      schema: "memo.agent-chain-deploy-checkpoint/1",
      deploymentId: id,
      sourceCommit,
      deployer,
      genesisHash: checked.network.genesisHash,
      finality,
      startNonce: nonce,
      entries: {},
    };
    await durableJson(filename, checkpoint);
    for (const item of requests) {
      let entry = checkpoint.entries[item.name];
      if (!entry) {
        await inspectNetwork(rpcs);
        const gasEstimate = await rpcs[0].estimateGas({
          ...item.request,
          from: deployer,
        });
        const gasLimit = (gasEstimate * 120n) / 100n;
        if (gasLimit > BigInt(env.MEMO_GAS_LIMIT_CAP))
          throw new Error("GAS_LIMIT_OUTSIDE_BUDGET");
        const gasPrice = BigInt(await rpcs[0].send("eth_gasPrice", []));
        if (gasPrice > BigInt(env.MEMO_GAS_PRICE_CAP_WEI) || gasPrice <= 0n)
          throw new Error("GAS_PRICE_OUTSIDE_BUDGET");
        const nonces = await Promise.all(
          rpcs.map((p) => p.getTransactionCount(deployer, "pending")),
        );
        if (nonces.some((n) => n !== item.nonce))
          throw new Error("DEPLOYER_NONCE_CHANGED");
        const balance = await rpcs[0].getBalance(deployer);
        if (balance <= gasLimit * gasPrice)
          throw new Error("INSUFFICIENT_FUNDS");
        const rawTransaction = await signer.signTransaction({
          ...item.request,
          nonce: item.nonce,
          chainId: 5611,
          value: 0n,
          gasLimit,
          gasPrice,
          type: 0,
        });
        const tx = Transaction.from(rawTransaction);
        if (
          tx.from !== deployer ||
          tx.chainId !== 5611n ||
          tx.nonce !== item.nonce ||
          tx.to !== null ||
          tx.data !== item.request.data ||
          tx.value !== 0n ||
          tx.gasPrice !== gasPrice ||
          tx.gasLimit !== gasLimit
        )
          throw new Error("INVALID_SIGNED_TRANSACTION");
        entry = {
          address: item.to,
          rawTransaction,
          txHash: keccak256(rawTransaction),
        };
        checkpoint.entries[item.name] = entry;
        await durableJson(filename, checkpoint); // write-ahead, including a restart before broadcast.
      }
      const savedTransaction = Transaction.from(entry.rawTransaction);
      if (
        entry.address !== item.to ||
        keccak256(entry.rawTransaction) !== entry.txHash ||
        savedTransaction.chainId !== 5611n ||
        savedTransaction.from !== deployer ||
        savedTransaction.to !== null ||
        savedTransaction.nonce !== item.nonce ||
        savedTransaction.value !== 0n ||
        savedTransaction.data !== item.request.data
      )
        throw new Error("CHECKPOINT_MISMATCH");
      if (!(await rpcs[0].getTransaction(entry.txHash)))
        await rpcs[0].broadcastTransaction(entry.rawTransaction);
      const receipt = await rpcs[0].waitForTransaction(
        entry.txHash,
        1,
        120_000,
      );
      if (
        !receipt ||
        receipt.status !== 1 ||
        getAddress(receipt.contractAddress) !== item.to
      )
        throw new Error("DEPLOYMENT_REVERTED_OR_UNKNOWN");
      const other = await rpcs[1].getTransactionReceipt(entry.txHash);
      if (!other || other.blockHash !== receipt.blockHash || other.status !== 1)
        throw new Error("RPC_FORK");
      const code = await rpcs[0].getCode(item.to, receipt.blockNumber);
      const codeOther = await rpcs[1].getCode(item.to, receipt.blockNumber);
      if (code === "0x" || code !== codeOther)
        throw new Error("DEPLOYMENT_CODE_MISMATCH");
      const abiName = `${item.name}.abi.json`;
      entry.contract = {
        address: item.to,
        interfaceVersion: "1",
        runtimeCodeHash: keccak256(code),
        abiSha256: sha256(
          await readFile(
            path.join(root, "packages/contracts/artifacts", abiName),
          ),
        ),
        deploymentTxHash: receipt.hash,
        deploymentBlockNumber: receipt.blockNumber,
        deploymentBlockHash: receipt.blockHash,
        domain: {
          name:
            item.name === "AgentDIDRegistry"
              ? "MEMO Agent DID Registry"
              : "MEMO Agent DID Management",
          version: "1",
          chainId: 5611,
          verifyingContract: item.to,
        },
      };
      entry.gasUsed = receipt.gasUsed.toString();
      entry.executionFee = receipt.fee.toString();
      const rawReceipt = await rpcs[0].send("eth_getTransactionReceipt", [
        entry.txHash,
      ]);
      entry.l1Fee = rawReceipt.l1Fee ?? null;
      await durableJson(filename, checkpoint);
      console.log(
        JSON.stringify({
          deployed: item.name,
          address: item.to,
          txHash: entry.txHash,
          blockHash: receipt.blockHash,
        }),
      );
    }
    const manifest = {
      schema: "memo.agent-chain-deployment/1",
      deploymentId: id,
      environment: "testnet",
      network: checked.network,
      contracts: {
        didRegistry: checkpoint.entries.AgentDIDRegistry.contract,
        managementRegistry: checkpoint.entries.AgentManagementRegistry.contract,
      },
      finality: preview.finality,
      transport: { kind: "direct-relayer" },
      sourceCommit,
      createdAt: new Date().toISOString(),
    };
    validateManifest(manifest);
    const adapter = new OpbnbChainAdapter({
      manifest,
      primary: rpcs[0],
      secondary: rpcs[1],
    });
    const verified = await adapter.verifyDeployment();
    const manifestPath = path.join(directory, `${fileId}.manifest.json`);
    let existing;
    try {
      existing = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // A completed release is immutable. Restart verifies it, never rewrites createdAt/hash.
    if (existing) {
      validateManifest(existing);
      if (
        existing.sourceCommit !== sourceCommit ||
        existing.deploymentId !== id ||
        JSON.stringify(existing.finality) !== JSON.stringify(finality) ||
        JSON.stringify(existing.network) !== JSON.stringify(manifest.network) ||
        JSON.stringify(existing.contracts) !==
          JSON.stringify(manifest.contracts)
      )
        throw new Error("MANIFEST_ALREADY_EXISTS");
    } else await durableJson(manifestPath, manifest);
    const digest = sha256(await readFile(manifestPath));
    await durableJson(path.join(directory, `${fileId}.verification.json`), {
      ...verified,
      manifestSha256: digest,
    });
    console.log(
      JSON.stringify({
        manifestPath,
        manifestSha256: digest,
        verified: true,
        businessE2E: "not performed",
      }),
    );
  }
} catch (e) {
  safeFailure(e);
} finally {
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
  rpcs.forEach((p) => p.destroy());
}
