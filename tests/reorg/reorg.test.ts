import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Interface } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeConfigService, type RuntimeConfig } from "../../apps/api/src/config.service.js";
import { ChainStore } from "../../apps/api/src/store.service.js";
import { ChainWorker } from "../../apps/chain-worker/src/worker.js";
import type { DeploymentManifest } from "../../packages/protocol/src/index.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("canonical projection rollback", () => {
  it("retries a block when log retrieval fails before committing its cursor", async () => {
    const store = makeStore();
    const account = "0x2000000000000000000000000000000000000002";
    const registry = "0x1000000000000000000000000000000000000001";
    const event = new Interface([
      "event AgentRegistered(address indexed identityAccount,uint64 revision,uint256 nonce,bytes32 identityPublicKeyHash,bytes32 documentHash,bytes32 profileHash,bytes32 actionDigest)",
    ]);
    const encoded = event.encodeEventLog(event.getEvent("AgentRegistered")!, [
      account, 1, 0, hash("11"), hash("21"), hash("31"), hash("41"),
    ]);
    let attempts = 0;
    const provider = {
      getBlockNumber: async () => 5,
      getBlock: async (number: number) => number === 5
        ? { hash: hash("05"), parentHash: hash("04") }
        : null,
      getLogs: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("RPC_LOGS_TEMPORARILY_UNAVAILABLE");
        return [{ address: registry, ...encoded, blockHash: hash("05"), transactionHash: hash("15"), index: 0 }];
      },
    };
    const worker = Object.assign(Object.create(ChainWorker.prototype), {
      store,
      provider,
      config: { value: { manifest: {
        didRegistry: { address: registry, deploymentBlock: 5 },
        managementRegistry: { address: "0x6000000000000000000000000000000000000006", deploymentBlock: 5 },
      }, requiredConfirmations: 2 } },
    }) as ChainWorker;
    try {
      await expect(worker.tick()).rejects.toThrow("RPC_LOGS_TEMPORARILY_UNAVAILABLE");
      expect(store.block(5)).toBeUndefined();
      expect(store.eventsForSubject(account)).toHaveLength(0);
      await worker.tick();
      expect(attempts).toBe(2);
      expect(store.block(5)?.block_hash).toBe(hash("05"));
      expect(store.identityProjection(`did:memo:agent:985:${account}`, false)?.revision).toBe(1);
    } finally {
      store.onModuleDestroy();
    }
  });

  it("keeps confirmed identity and management snapshots visible during unconfirmed updates", () => {
    const store = makeStore();
    const account = "0x2000000000000000000000000000000000000002";
    const did = `did:memo:agent:985:${account}`;
    try {
      const identity = {
        agentDid: did, identityAccount: account, status: "active", nonce: "1",
        documentHash: hash("21"), profileHash: hash("31"), blockNumber: 5,
        blockHash: hash("05"), confirmed: true, logIndex: 0, revision: 1,
      };
      store.upsertIdentityProjection(identity);
      const management = {
        agentDid: did, managerAccount: "0x3000000000000000000000000000000000000003",
        relationshipHash: hash("41"), scopesHash: hash("51"), expiresAt: 9999999999,
        discoverable: false, status: "active", revision: 1, nonce: "1",
        blockNumber: 5, blockHash: hash("05"), confirmed: true, logIndex: 1,
      };
      store.upsertManagementProjection(management);
      store.upsertIdentityProjection({ ...identity, revision: 2, nonce: "2", profileHash: hash("32"), blockNumber: 6, blockHash: hash("06"), confirmed: false });
      store.upsertManagementProjection({ ...management, revision: 2, nonce: "2", scopesHash: hash("52"), blockNumber: 6, blockHash: hash("06"), confirmed: false });
      expect(store.identityProjection(did, true)).toMatchObject({ revision: 1, profile_hash: hash("31") });
      expect(store.managementProjection(did, true)).toMatchObject({ revision: 1, scopes_hash: hash("51") });
      expect(store.identityProjection(did, false)?.revision).toBe(2);
      store.confirmProjections(7, 2);
      expect(store.identityProjection(did, true)).toMatchObject({ revision: 2, profile_hash: hash("32") });
      expect(store.managementProjection(did, true)).toMatchObject({ revision: 2, scopes_hash: hash("52") });
    } finally {
      store.onModuleDestroy();
    }
  });

  it("removes orphan events and rebuilds the surviving confirmed history", () => {
    const store = makeStore();
    const account = "0x2000000000000000000000000000000000000002";
    const did = `did:memo:agent:985:${account}`;
    try {
      store.saveBlock({ number: 5, hash: hash("05"), parentHash: hash("04"), canonical: true });
      store.saveBlock({ number: 6, hash: hash("06"), parentHash: hash("05"), canonical: true });
      store.saveIndexedEvent({
        blockNumber: 5, blockHash: hash("05"), txHash: hash("15"), logIndex: 0,
        contractAddress: "0x1000000000000000000000000000000000000001", eventName: "AgentRegistered",
        subject: account, revision: 1,
        payload: { identityAccount: account, revision: "1", nonce: "0", documentHash: hash("21"), profileHash: hash("31") },
      });
      store.saveIndexedEvent({
        blockNumber: 6, blockHash: hash("06"), txHash: hash("16"), logIndex: 0,
        contractAddress: "0x1000000000000000000000000000000000000001", eventName: "ProfileUpdated",
        subject: account, revision: 2,
        payload: { identityAccount: account, revision: "2", nonce: "1", profileHash: hash("32") },
      });
      store.upsertIdentityProjection({
        agentDid: did, identityAccount: account, status: "active", revision: 1, nonce: "1",
        documentHash: hash("21"), profileHash: hash("31"), blockNumber: 5, blockHash: hash("05"),
        confirmed: true, logIndex: 0,
      });
      store.upsertIdentityProjection({
        agentDid: did, identityAccount: account, status: "active", revision: 2, nonce: "2",
        documentHash: hash("21"), profileHash: hash("32"), blockNumber: 6, blockHash: hash("06"),
        confirmed: false, logIndex: 0,
      });
      store.rollbackAfter(5);
      const rebuilt = store.identityProjection(did, false);
      expect(rebuilt).toMatchObject({ revision: 1, nonce: "1", profile_hash: hash("31"), block_number: 5 });
      expect(store.identityProjection(did, true)).toMatchObject({ revision: 1, profile_hash: hash("31") });
      expect(store.eventsForSubject(account)).toHaveLength(1);
      expect(store.block(6)).toBeUndefined();
    } finally {
      store.onModuleDestroy();
    }
  });
});

function makeStore(): ChainStore {
  const dataRoot = mkdtempSync(resolve(tmpdir(), "memo-mainnet-reorg-"));
  roots.push(dataRoot);
  const manifest: DeploymentManifest = {
    schema: "memo.agent-did-deployment/1", environment: "local", networkName: "MEMO Mainnet Local", chainId: 985,
    publicRpcUrl: "http://127.0.0.1:9545", nativeCurrency: { name: "MEMO", symbol: "MEMO", decimals: 18 },
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: "0.7", runtimeCodeHash: hash("01") },
    simpleAccountFactory: { address: "0x4000000000000000000000000000000000000004", deploymentBlock: 1, runtimeCodeHash: hash("02") },
    relayerSmartAccount: {
      address: "0x5000000000000000000000000000000000000005",
      ownerAddress: "0x7000000000000000000000000000000000000007",
      ownerProvider: "dev-private-key",
      runtimeCodeHash: hash("07"),
    },
    didRegistry: { address: "0x1000000000000000000000000000000000000001", deploymentBlock: 1, runtimeCodeHash: hash("03"), abiHash: hash("04") },
    managementRegistry: { address: "0x6000000000000000000000000000000000000006", deploymentBlock: 1, runtimeCodeHash: hash("05"), abiHash: hash("06") },
    finality: { preferFinalizedTag: true, fallbackConfirmations: 12 }, generatedAt: new Date().toISOString(),
  };
  const config: RuntimeConfig = {
    environment: "local", port: 4273, primaryRpcUrl: "http://127.0.0.1:9545", secondaryRpcUrl: "http://127.0.0.1:9545",
    bundlerUrl: "http://127.0.0.1:4337", dataRoot, sessionSigningKey: "x".repeat(32), requiredConfirmations: 2,
    entryPointCodeHash: manifest.entryPoint.runtimeCodeHash, platformOrigins: [], minEntryPointDepositWei: 1n,
    minBundlerExecutorBalanceWei: 1n, manifestPath: "test", manifest,
  };
  return new ChainStore(new RuntimeConfigService(config));
}

function hash(byte: string): string { return "0x" + byte.repeat(32); }
