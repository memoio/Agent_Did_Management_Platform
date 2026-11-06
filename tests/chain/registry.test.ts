import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Contract,
  ContractFactory,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Wallet,
  keccak256,
  randomBytes,
} from "ethers";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID as uuid } from "node:crypto";
import {
  OpbnbChainAdapter,
  FileSubmissionJournal,
  advanceOperation,
  readNextWindow,
  sha256,
  hashJson,
  hashScopes,
  hashIdentifier,
  toDid,
  type Intent,
  type ActionType,
  type Message,
  type ActionSignature,
  type DeploymentManifest,
} from "../../packages/chain-adapter/src/index.js";
import didArtifact from "../../packages/contracts/artifacts/AgentDIDRegistry.json" with { type: "json" };
import managementArtifact from "../../packages/contracts/artifacts/AgentManagementRegistry.json" with { type: "json" };

const require = createRequire(import.meta.url);
const solc = require("solc");
const ganache = require("ganache");
let server: any;
let primary: JsonRpcProvider, secondary: JsonRpcProvider;
let manifest: DeploymentManifest;
let adapter: OpbnbChainAdapter;
let journal: FileSubmissionJournal;
let directory: string;
let relayer: Wallet;
let registry: Contract;

beforeAll(async () => {
  // Offline fault injection only. This is NOT remote opBNB deployment evidence.
  server = ganache.server({
    chain: { chainId: 5611, hardfork: "shanghai" },
    logging: { quiet: true },
    wallet: { totalAccounts: 2 },
  });
  await server.listen(0, "127.0.0.1");
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  primary = new JsonRpcProvider(url, undefined, {
    cacheTimeout: -1,
    batchMaxCount: 1,
  });
  secondary = new JsonRpcProvider(url, undefined, {
    cacheTimeout: -1,
    batchMaxCount: 1,
  });
  const deployer = await primary.getSigner();
  const did = await new ContractFactory(
    didArtifact.abi,
    didArtifact.bytecode,
    deployer,
  ).deploy();
  const dReceipt = (await did.deploymentTransaction()!.wait())!;
  const management = await new ContractFactory(
    managementArtifact.abi,
    managementArtifact.bytecode,
    deployer,
  ).deploy(await did.getAddress());
  const mReceipt = (await management.deploymentTransaction()!.wait())!;
  const accounts = server.provider.getInitialAccounts();
  relayer = new Wallet(
    (Object.values(accounts)[1] as { secretKey: string }).secretKey,
    primary,
  );
  const metadata = async (
    key: string,
    contract: typeof did,
    receipt: typeof dReceipt,
    name: string,
  ) => ({
    address: await contract.getAddress(),
    interfaceVersion: "1",
    runtimeCodeHash: keccak256(
      await primary.getCode(await contract.getAddress()),
    ),
    abiSha256: sha256(
      await readFile(`packages/contracts/artifacts/${key}.abi.json`),
    ),
    deploymentTxHash: receipt.hash,
    deploymentBlockNumber: receipt.blockNumber,
    deploymentBlockHash: receipt.blockHash,
    domain: {
      name,
      version: "1",
      chainId: 5611,
      verifyingContract: await contract.getAddress(),
    },
  });
  manifest = {
    schema: "memo.agent-chain-deployment/1",
    deploymentId: "offline-test-5611",
    environment: "testnet",
    network: {
      name: "Offline fixture (not opBNB)",
      caip2: "eip155:5611",
      chainId: 5611,
      genesisHash: (await primary.getBlock(0))!.hash!,
      publicRpcUrl: "https://example.invalid",
      explorerUrl: "https://example.invalid",
      nativeCurrency: { name: "Test", symbol: "TEST", decimals: 18 },
    },
    contracts: {
      didRegistry: await metadata(
        "AgentDIDRegistry",
        did,
        dReceipt,
        "MEMO Agent DID Registry",
      ),
      managementRegistry: await metadata(
        "AgentManagementRegistry",
        management,
        mReceipt,
        "MEMO Agent DID Management",
      ),
    },
    finality: {
      mode: "confirmations",
      fallbackConfirmations: 1,
      maxReorgDepth: 20,
    },
    transport: { kind: "direct-relayer" },
    sourceCommit: "1".repeat(40),
    createdAt: new Date().toISOString(),
  };
  directory = await mkdtemp(path.join(os.tmpdir(), "memo-agent-chain-"));
  journal = new FileSubmissionJournal(directory);
  adapter = new OpbnbChainAdapter({
    manifest,
    primary,
    secondary,
    signer: relayer,
    signerHealth: async () => true,
    journal,
    minimumBalance: 1n,
    gasLimitCap: 5_000_000n,
    gasPriceCap: 100_000_000_000n,
    logChunkSize: 2,
  });
  registry = new Contract(await did.getAddress(), didArtifact.abi, deployer);
});
afterAll(async () => {
  primary?.destroy();
  secondary?.destroy();
  await server?.close();
  if (
    directory &&
    path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) &&
    path.basename(directory).startsWith("memo-agent-chain-")
  )
    await rm(directory, { recursive: true, force: true });
});

async function signature(
  intent: Intent,
  role: string,
  wallet: Wallet,
): Promise<ActionSignature> {
  return {
    role,
    address: wallet.address,
    signature: await wallet.signTypedData(
      intent.domain,
      intent.types,
      intent.message,
    ),
  };
}
async function send(
  intent: Intent,
  signatures: ActionSignature[],
  requestId = uuid(),
) {
  const result = await adapter.submitSignedAction(
    intent,
    signatures,
    requestId,
  );
  const receipt = await primary.waitForTransaction(result.txHash, 1, 10_000);
  expect(receipt?.status).toBe(1);
  return {
    result,
    tracked: await adapter.getSubmission(result.submissionId),
    requestId,
  };
}
async function register() {
  const agent = Wallet.createRandom();
  const wallet = new Wallet(agent.privateKey);
  const publicKeyHash = keccak256(`0x${wallet.signingKey.publicKey.slice(4)}`);
  const intent = await adapter.buildIntent("RegisterAgent", {
    identityAccount: wallet.address,
    identityPublicKeyHash: publicKeyHash,
    documentHash: hashJson({ id: toDid(5611, wallet.address) }),
    profileHash: hashJson({ name: "测试 Agent", emoji: "🌱" }),
  });
  const signed = await signature(intent, "agent", wallet);
  await send(intent, [signed]);
  return { wallet, intent, signed };
}

describe("Agent DID v1 chain module (offline)", () => {
  it("verifies deployment anchors and rejects network/code/ABI mismatches", async () => {
    expect((await adapter.verifyDeployment()).verified).toBe(true);
    const wrong = structuredClone(manifest);
    wrong.network.chainId = 985;
    expect(
      () => new OpbnbChainAdapter({ manifest: wrong, primary, secondary }),
    ).toThrow();
    const altered = structuredClone(manifest);
    altered.contracts.didRegistry.runtimeCodeHash = `0x${"2".repeat(64)}`;
    await expect(
      new OpbnbChainAdapter({
        manifest: altered,
        primary,
        secondary,
      }).verifyDeployment(),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
    const abi = structuredClone(manifest);
    abi.contracts.didRegistry.abiSha256 = `0x${"3".repeat(64)}`;
    expect(
      () => new OpbnbChainAdapter({ manifest: abi, primary, secondary }),
    ).toThrow();
  });
  it("registers, returns schema-valid events and reconciles the same request after nonce consumption", async () => {
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const intent = await adapter.buildIntent("RegisterAgent", {
      identityAccount: wallet.address,
      identityPublicKeyHash: keccak256(
        `0x${wallet.signingKey.publicKey.slice(4)}`,
      ),
      documentHash: hashJson({ doc: 1 }),
      profileHash: hashJson({ profile: 1 }),
    });
    const signed = await signature(intent, "agent", wallet);
    const { result, tracked, requestId } = await send(intent, [signed]);
    expect(tracked).toMatchObject({
      state: "INCLUDED",
      confirmed: true,
      status: "success",
      events: [{ eventType: "AgentRegistered", revision: "1", nonce: "0" }],
    });
    expect(
      await adapter.submitSignedAction(intent, [signed], requestId),
    ).toEqual(result);
    expect(await adapter.readIdentity(wallet.address)).toMatchObject({
      status: "ACTIVE",
      revision: "1",
      nonce: "1",
    });
    await expect(
      adapter.verifySignedAction(intent, [signed]),
    ).rejects.toMatchObject({ code: "NONCE_CONFLICT" });
  });
  it("checks domain, signer, deadline, key/address binding and payload fields", async () => {
    const { wallet } = await register();
    const intent = await adapter.buildIntent("UpdateProfile", {
      identityAccount: wallet.address,
      profileHash: hashJson({ next: true }),
    });
    const signed = await signature(intent, "agent", wallet);
    const wrong = structuredClone(intent);
    wrong.domain.chainId = 204;
    await expect(
      adapter.verifySignedAction(wrong, [signed]),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await expect(
      adapter.verifySignedAction(intent, [
        await signature(
          intent,
          "agent",
          new Wallet(Wallet.createRandom().privateKey),
        ),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await expect(
      adapter.buildIntent("UpdateProfile", {
        identityAccount: wallet.address,
        profileHash: hashJson({}),
        nonce: "0",
      }),
    ).rejects.toThrow();
    await expect(
      adapter.buildIntent("UpdateProfile", {
        identityAccount: wallet.address,
        profileHash: hashJson({}),
        extra: "x",
      }),
    ).rejects.toThrow();
    const m = {
      identityAccount: wallet.address,
      expectedRevision: "1",
      nonce: "1",
      deadline: "1",
    };
    const expired = await wallet.signTypedData(
      intent.domain,
      {
        SuspendAgent: [
          { name: "identityAccount", type: "address" },
          { name: "expectedRevision", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      m,
    );
    await expect(registry.suspendAgent(m, expired)).rejects.toThrow();
    const rogue = new Wallet(Wallet.createRandom().privateKey);
    const bad = await adapter.buildIntent("RegisterAgent", {
      identityAccount: rogue.address,
      identityPublicKeyHash: hashJson({ unrelated: true }),
      documentHash: hashJson({}),
      profileHash: hashJson({}),
    });
    await expect(
      adapter.verifySignedAction(bad, [await signature(bad, "agent", rogue)]),
    ).rejects.toMatchObject({ code: "INVALID_ACTION" });
  });
  it("updates content, revokes instance credentials, suspends/resumes and permanently revokes", async () => {
    const { wallet } = await register();
    const cases: [ActionType, Message][] = [
      ["UpdateProfile", { profileHash: hashJson({ updated: true }) }],
      ["UpdateDocument", { documentHash: hashJson({ service: [] }) }],
      [
        "RevokeInstanceCredential",
        { credentialIdHash: hashIdentifier("instance-1") },
      ],
      ["SuspendAgent", {}],
      ["ResumeAgent", {}],
      ["RevokeAgent", {}],
    ];
    for (const [action, payload] of cases) {
      const intent = await adapter.buildIntent(action, {
        identityAccount: wallet.address,
        ...payload,
      });
      await send(intent, [await signature(intent, "agent", wallet)]);
    }
    expect(await adapter.readIdentity(wallet.address)).toMatchObject({
      status: "REVOKED",
      revision: "7",
      nonce: "7",
    });
    expect(
      (
        await adapter.readCredentialRevocation(
          wallet.address,
          hashIdentifier("instance-1"),
        )
      ).revoked,
    ).toBe(true);
    const resume = await adapter.buildIntent("ResumeAgent", {
      identityAccount: wallet.address,
    });
    await expect(
      adapter.verifySignedAction(resume, [
        await signature(resume, "agent", wallet),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ACTION" });
  });
  it("requires both parties and supports renewal, three-party transfer and unilateral end", async () => {
    const { wallet: agent } = await register();
    const manager = new Wallet(Wallet.createRandom().privateKey),
      nextManager = new Wallet(Wallet.createRandom().privateKey);
    const now = (await adapter.readBlock()).timestamp;
    const intent = await adapter.buildIntent("ActivateRelationship", {
      agent: agent.address,
      manager: manager.address,
      relationshipIdHash: hashIdentifier("relation-1"),
      scopesHash: hashScopes(["read", "write"]),
      issuedAt: String(now),
      expiresAt: String(now + 3600),
      discoverable: true,
    });
    await expect(
      adapter.verifySignedAction(intent, [
        await signature(intent, "agent", agent),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await send(intent, [
      await signature(intent, "agent", agent),
      await signature(intent, "manager", manager),
    ]);
    expect((await adapter.readRelationship(agent.address)).live).toBe(true);
    const renew = await adapter.buildIntent("RenewRelationship", {
      agent: agent.address,
      manager: manager.address,
      relationshipIdHash: hashIdentifier("relation-1"),
      scopesHash: hashScopes(["read"]),
      expiresAt: String(now + 7200),
      discoverable: false,
    });
    await send(renew, [
      await signature(renew, "agent", agent),
      await signature(renew, "manager", manager),
    ]);
    const transfer = await adapter.buildIntent("TransferRelationship", {
      agent: agent.address,
      oldManager: manager.address,
      newManager: nextManager.address,
      oldRelationshipIdHash: hashIdentifier("relation-1"),
      newRelationshipIdHash: hashIdentifier("relation-2"),
      scopesHash: hashScopes(["read"]),
      expiresAt: String(now + 7200),
      discoverable: false,
    });
    await send(transfer, [
      await signature(transfer, "agent", agent),
      await signature(transfer, "oldManager", manager),
      await signature(transfer, "newManager", nextManager),
    ]);
    const end = await adapter.buildIntent("EndRelationship", {
      agent: agent.address,
      manager: nextManager.address,
      relationshipIdHash: hashIdentifier("relation-2"),
      actor: nextManager.address,
      reasonHash: hashIdentifier("MANAGER_ENDED"),
    });
    await send(end, [await signature(end, "actor", nextManager)]);
    expect(await adapter.readRelationship(agent.address)).toMatchObject({
      ended: true,
      live: false,
      revision: "4",
      nonce: "4",
    });
    const {
      nonce: _n,
      expectedRevision: _r,
      deadline: _d,
      ...terms
    } = intent.message;
    const reused = await adapter.buildIntent("ActivateRelationship", terms);
    await send(reused, [
      await signature(reused, "agent", agent),
      await signature(reused, "manager", manager),
    ]);
    expect(await adapter.readRelationship(agent.address)).toMatchObject({
      live: true,
      revision: "5",
      nonce: "5",
    });
  });
  it("supports ERC-1271 Manager signatures and rejects invalid ones", async () => {
    const { wallet: agent } = await register();
    const manager = new Wallet(Wallet.createRandom().privateKey);
    const input = {
      language: "Solidity",
      sources: {
        "Wallet.sol": {
          content: `pragma solidity 0.8.28; contract Wallet1271 { address immutable owner; constructor(address a) {owner=a;} function isValidSignature(bytes32 h, bytes calldata s) external view returns(bytes4) { if(s.length!=65) return 0xffffffff; bytes32 r; bytes32 t; uint8 v; assembly {r:=calldataload(s.offset) t:=calldataload(add(s.offset,32)) v:=byte(0,calldataload(add(s.offset,64)))} return ecrecover(h,v,r,t)==owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff); } }`,
        },
      },
      settings: {
        evmVersion: "paris",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input))).contracts[
      "Wallet.sol"
    ].Wallet1271;
    const wallet = await new ContractFactory(
      output.abi,
      `0x${output.evm.bytecode.object}`,
      await primary.getSigner(),
    ).deploy(manager.address);
    await wallet.waitForDeployment();
    const now = (await adapter.readBlock()).timestamp;
    const intent = await adapter.buildIntent("ActivateRelationship", {
      agent: agent.address,
      manager: await wallet.getAddress(),
      relationshipIdHash: hashIdentifier("contract-wallet"),
      scopesHash: hashScopes(["read"]),
      issuedAt: String(now),
      expiresAt: String(now + 3600),
      discoverable: false,
    });
    const agentSig = await signature(intent, "agent", agent);
    const managerSig = {
      ...(await signature(intent, "manager", manager)),
      address: await wallet.getAddress(),
    };
    const originalCall = secondary.call.bind(secondary);
    secondary.call = async (transaction) => {
      if (
        String(transaction.to).toLowerCase() ===
        (await wallet.getAddress()).toLowerCase()
      )
        throw Object.assign(new Error("RPC timeout"), { code: "TIMEOUT" });
      return originalCall(transaction);
    };
    try {
      await expect(
        adapter.verifySignedAction(intent, [agentSig, managerSig]),
      ).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE", retryable: true });
    } finally {
      secondary.call = originalCall;
    }
    await expect(
      adapter.verifySignedAction(intent, [
        agentSig,
        { ...managerSig, signature: "0x1234" },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await send(intent, [agentSig, managerSig]);
  });
  it("leaves logs retryable after RPC failure and deduplicates results", async () => {
    const { wallet } = await register();
    const from = manifest.contracts.didRegistry.deploymentBlockNumber,
      to = (await adapter.readBlock()).blockNumber;
    const original = primary.getLogs.bind(primary);
    let attempts = 0;
    primary.getLogs = async (...args) => {
      if (attempts++ === 0) throw new Error("secret-bearing RPC details");
      return original(...args);
    };
    try {
      await expect(adapter.readEvents(from, to)).rejects.toMatchObject({
        code: "CHAIN_UNAVAILABLE",
      });
      const result = await adapter.readEvents(from, to);
      expect(result.complete).toBe(true);
      expect(
        result.events.some((e) => e.agentDid === toDid(5611, wallet.address)),
      ).toBe(true);
      expect(
        new Set(
          result.events.map((e) => `${e.blockHash}:${e.txHash}:${e.logIndex}`),
        ).size,
      ).toBe(result.events.length);
    } finally {
      primary.getLogs = original;
    }
  });
  it("recovers broadcast-response loss from a durable journal without issuing a second tx", async () => {
    const { wallet } = await register();
    const intent = await adapter.buildIntent("UpdateProfile", {
      identityAccount: wallet.address,
      profileHash: hashJson({ recovery: 1 }),
    });
    const signed = await signature(intent, "agent", wallet);
    const requestId = uuid();
    const original = primary.broadcastTransaction.bind(primary);
    primary.broadcastTransaction = async (...args) => {
      await original(...args);
      throw new Error("lost response");
    };
    try {
      await expect(
        adapter.submitSignedAction(intent, [signed], requestId),
      ).rejects.toMatchObject({
        code: "SUBMISSION_UNKNOWN",
        mayHaveBroadcast: true,
      });
    } finally {
      primary.broadcastTransaction = original;
    }
    const recovered = await adapter.submitSignedAction(
      intent,
      [signed],
      requestId,
    );
    expect((await adapter.getSubmission(recovered.submissionId)).state).toBe(
      "INCLUDED",
    );
    expect((await adapter.readIdentity(wallet.address)).revision).toBe("2");
    const reopened = new FileSubmissionJournal(directory);
    expect((await reopened.get(recovered.submissionId))?.txHash).toBe(
      recovered.txHash,
    );
  });
  it("reserves a signed but unbroadcast nonce across restart and blocks a different request", async () => {
    const { wallet } = await register();
    const intent = await adapter.buildIntent("UpdateProfile", {
      identityAccount: wallet.address,
      profileHash: hashJson({ reserved: 1 }),
    });
    const signed = await signature(intent, "agent", wallet);
    const requestId = uuid();
    const broadcast = primary.broadcastTransaction.bind(primary);
    primary.broadcastTransaction = async () => {
      throw new Error("offline before send");
    };
    try {
      await expect(
        adapter.submitSignedAction(intent, [signed], requestId),
      ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    } finally {
      primary.broadcastTransaction = broadcast;
    }
    await expect(
      adapter.submitSignedAction(intent, [signed], uuid()),
    ).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    const restarted = new OpbnbChainAdapter({
      manifest,
      primary,
      secondary,
      signer: relayer,
      journal: new FileSubmissionJournal(directory),
    });
    const result = await restarted.submitSignedAction(
      intent,
      [signed],
      requestId,
    );
    await primary.waitForTransaction(result.txHash, 1, 10_000);
    expect((await restarted.getSubmission(result.submissionId)).state).toBe(
      "INCLUDED",
    );
    expect((await adapter.readIdentity(wallet.address)).revision).toBe("2");
  });
  it("only permits approved finality fallback on RPC unavailability, never on a fork", async () => {
    const m = structuredClone(manifest);
    m.finality.mode = "finalized-tag";
    const fallback = new OpbnbChainAdapter({
      manifest: m,
      primary,
      secondary,
      allowFinalityFallback: true,
    });
    const strict = new OpbnbChainAdapter({ manifest: m, primary, secondary });
    const block = await adapter.readBlock();
    const original = secondary.getBlock.bind(secondary);
    secondary.getBlock = async (...args) => {
      if (args[0] === "finalized") throw new Error("temporarily unavailable");
      return original(...args);
    };
    try {
      expect(
        await fallback.evaluateFinality(block.blockNumber, block.blockHash),
      ).toMatchObject({ confirmed: true, finalitySource: "confirmations" });
      await expect(
        strict.evaluateFinality(block.blockNumber, block.blockHash),
      ).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    } finally {
      secondary.getBlock = original;
    }
    secondary.getBlock = async (...args) => {
      const b = await original(...args);
      return args[0] === "finalized" && b
        ? ({ ...b, hash: `0x${"f".repeat(64)}` } as typeof b)
        : b;
    };
    try {
      await expect(
        fallback.evaluateFinality(block.blockNumber, block.blockHash),
      ).rejects.toMatchObject({ code: "CHAIN_STATE_UNCERTAIN" });
    } finally {
      secondary.getBlock = original;
    }
  });
  it("rejects divergent RPC block hashes and missing submission evidence", async () => {
    const original = secondary.getBlock.bind(secondary);
    secondary.getBlock = async (...args) => {
      const b = await original(...args);
      if (b && args[0] !== 0)
        return { ...b, hash: `0x${"a".repeat(64)}` } as typeof b;
      return b;
    };
    try {
      await expect(adapter.verifyDeployment()).rejects.toMatchObject({
        code: "CHAIN_STATE_UNCERTAIN",
      });
    } finally {
      secondary.getBlock = original;
    }
  });
  it("keeps confirmed operations on stale updates and only permits reorg with changed canonical hash", async () => {
    const block = await adapter.readBlock();
    const confirmed = {
      state: "CONFIRMED" as const,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      confirmations: 2,
      txHash: `0x${"a".repeat(64)}`,
    };
    expect(
      await advanceOperation(adapter, confirmed, { state: "SUBMITTED" }),
    ).toEqual(confirmed);
    await expect(
      advanceOperation(adapter, confirmed, { state: "REORGED" }),
    ).rejects.toMatchObject({ code: "CHAIN_STATE_UNCERTAIN" });
    // Fault-injected canonical hash change; this does NOT prove a real opBNB reorg.
    const original = adapter.readBlock.bind(adapter);
    adapter.readBlock = async () => ({
      ...block,
      blockHash: `0x${"b".repeat(64)}`,
    });
    try {
      expect(
        (await advanceOperation(adapter, confirmed, { state: "REORGED" }))
          .state,
      ).toBe("REORGED");
    } finally {
      adapter.readBlock = original;
    }
  });
  it("persists no cursor on failed reads, resumes from saved cursor and detects ancestor changes", async () => {
    const block = await adapter.readBlock(
      manifest.contracts.didRegistry.deploymentBlockNumber - 1,
    );
    const cursor = {
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
    };
    const original = adapter.readEvents.bind(adapter);
    adapter.readEvents = async () => {
      throw new Error("injected unavailable");
    };
    try {
      await expect(readNextWindow(adapter, cursor)).rejects.toThrow();
    } finally {
      adapter.readEvents = original;
    }
    expect(cursor.blockNumber).toBe(block.blockNumber);
    const result = await readNextWindow(adapter, cursor);
    expect(result.cursor.blockNumber).toBeGreaterThan(cursor.blockNumber);
    const savedCursor = JSON.parse(JSON.stringify(result.cursor));
    expect((await readNextWindow(adapter, savedCursor)).idle).toBe(true);
    await expect(
      readNextWindow(adapter, { ...cursor, blockHash: `0x${"b".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "CHAIN_STATE_UNCERTAIN" });
  });
});

it("uses JCS+SHA256 for multilingual data and stable scope hashes", () => {
  expect(hashJson({ 中文: "🌱", a: 1 })).toBe(hashJson({ a: 1, 中文: "🌱" }));
  expect(hashScopes(["write", "read", "read"])).toBe(
    hashScopes(["read", "write"]),
  );
  expect(() => hashJson({ n: Infinity })).toThrow();
  expect(() => hashJson("\ud800")).toThrow();
});
