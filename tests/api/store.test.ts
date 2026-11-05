import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeConfigService, type RuntimeConfig } from "../../apps/api/src/config.service.js";
import { ChainStore } from "../../apps/api/src/store.service.js";
import { didDomain, type ActionIntent, type DeploymentManifest } from "../../packages/protocol/src/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("isolated chain store", () => {
  it("enforces tenant-scoped idempotency and returns the original operation", () => {
    const store = createStore();
    try {
      const firstIntent = intent("int_1", "0x" + "11".repeat(32));
      store.saveIntent(firstIntent, "tenant-a", "did:memo:agent:985:0x2000000000000000000000000000000000000002");
      const first = store.createOperation(operationInput(firstIntent, "tenant-a", firstIntent.digest));
      const repeated = store.createOperation(operationInput(firstIntent, "tenant-a", firstIntent.digest));
      expect(repeated.operationId).toBe(first.operationId);
      const secondIntent = intent("int_2", "0x" + "22".repeat(32));
      store.saveIntent(secondIntent, "tenant-a", "did:memo:agent:985:0x2000000000000000000000000000000000000002");
      expect(() => store.createOperation(operationInput(secondIntent, "tenant-a", firstIntent.digest))).toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
    } finally {
      store.onModuleDestroy();
    }
  });

  it("atomically marks orphaned operations REORGED and rebuilds canonical projections", () => {
    const store = createStore();
    try {
      const value = intent("int_reorg", "0x" + "33".repeat(32));
      store.saveIntent(value, "tenant-a", "did:memo:agent:985:0x2000000000000000000000000000000000000002");
      const operation = store.createOperation(operationInput(value, "tenant-a", value.digest));
      store.transitionOperation(operation.operationId, "SUBMITTED", { user_op_hash: "0x" + "44".repeat(32) });
      store.transitionOperation(operation.operationId, "INCLUDED", {
        tx_hash: "0x" + "55".repeat(32), block_number: 11, block_hash: "0x" + "66".repeat(32), confirmations: 1,
      });
      store.saveBlock({ number: 10, hash: "0x" + "10".repeat(32), parentHash: "0x" + "09".repeat(32), canonical: true });
      store.saveBlock({ number: 11, hash: "0x" + "66".repeat(32), parentHash: "0x" + "10".repeat(32), canonical: true });
      store.saveIndexedEvent({
        blockNumber: 11,
        blockHash: "0x" + "66".repeat(32),
        txHash: "0x" + "55".repeat(32),
        logIndex: 0,
        contractAddress: "0x1000000000000000000000000000000000000001",
        eventName: "AgentRegistered",
        subject: "0x2000000000000000000000000000000000000002",
        revision: 1,
        payload: { identityAccount: "0x2000000000000000000000000000000000000002", revision: "1", nonce: "0", documentHash: "0x" + "77".repeat(32), profileHash: "0x" + "88".repeat(32) },
      });
      const affected = store.rollbackAfter(10);
      expect(affected).toEqual([operation.operationId]);
      expect(store.operation(operation.operationId)).toMatchObject({ state: "REORGED", confirmations: 0 });
      expect(store.block(11)).toBeUndefined();
      expect(store.identityProjection("did:memo:agent:985:0x2000000000000000000000000000000000000002", false)).toBeUndefined();
    } finally {
      store.onModuleDestroy();
    }
  });

  it("claims an Invitation once, binds only after completion, and creates a management draft", () => {
    const store = createStore();
    try {
      const agentDid = "did:memo:agent:985:0x2000000000000000000000000000000000000002";
      const exchangeId = "pinv_123456789012";
      store.createPairingExchange({
        exchangeId,
        kind: "platform-invitation",
        tokenHash: "a".repeat(64),
        platformOrigin: "http://127.0.0.1:4273",
        creatorTenantId: "wallet:manager",
        creatorSubject: "0x3000000000000000000000000000000000000003",
        managerAccount: "0x3000000000000000000000000000000000000003",
        maxScopes: ["profile.update"],
        maxTermSeconds: 2_592_000,
        requestedScopes: ["profile.update"],
        requestedTermSeconds: 2_592_000,
        visibility: "private",
        expiresAt: Date.now() + 60_000,
        idempotencyNamespace: "wallet:manager:create",
        idempotencyKey: "create-invitation",
        requestHash: "1".repeat(64),
      });
      store.claimInvitation({
        exchangeId,
        tokenHash: "a".repeat(64),
        agentDid,
        idempotencyNamespace: "agent:claim",
        idempotencyKey: "claim-invitation",
        requestHash: "2".repeat(64),
      });
      expect(store.agentTenant(agentDid)).toBe("unpaired:" + agentDid);
      const completed = store.completeInvitation({
        exchangeId,
        agentDid,
        idempotencyNamespace: "agent:complete",
        idempotencyKey: "complete-invitation",
        requestHash: "3".repeat(64),
      });
      expect(store.agentTenant(agentDid)).toBe("wallet:manager");
      expect(completed.binding).toMatchObject({ agent_did: agentDid, state: "ACTIVE" });
      expect(completed.draft).toMatchObject({ state: "AWAITING_WALLET_SIGNATURE" });
      const repeated = store.completeInvitation({
        exchangeId,
        agentDid,
        idempotencyNamespace: "agent:complete",
        idempotencyKey: "complete-invitation",
        requestHash: "3".repeat(64),
      });
      expect(repeated.reused).toBe(true);
      expect(store.agentBindingsForTenant("wallet:manager")).toHaveLength(1);
    } finally {
      store.onModuleDestroy();
    }
  });

  it("allows one wallet tenant to bind multiple Agents but rejects a cross-wallet rebind", () => {
    const store = createStore();
    try {
      const tenantA = "wallet:0x3000000000000000000000000000000000000003";
      const tenantB = "wallet:0x4000000000000000000000000000000000000004";
      const walletA = "0x3000000000000000000000000000000000000003";
      const walletB = "0x4000000000000000000000000000000000000004";
      const agentA = "did:memo:agent:985:0x2000000000000000000000000000000000000002";
      const agentB = "did:memo:agent:985:0x2100000000000000000000000000000000000002";

      createOffer(store, "poff_123456789012", agentA, "a".repeat(64));
      createOffer(store, "poff_223456789012", agentB, "b".repeat(64));
      redeemOffer(store, "poff_123456789012", "a".repeat(64), agentA, tenantA, walletA, "redeem-a");
      redeemOffer(store, "poff_223456789012", "b".repeat(64), agentB, tenantA, walletA, "redeem-b");

      expect(store.agentBindingsForTenant(tenantA).map((row) => row.agent_did).sort()).toEqual([agentA, agentB].sort());
      expect(store.agentBindingsForTenant(tenantB)).toHaveLength(0);

      createOffer(store, "poff_323456789012", agentA, "c".repeat(64));
      expect(() => redeemOffer(
        store,
        "poff_323456789012",
        "c".repeat(64),
        agentA,
        tenantB,
        walletB,
        "redeem-conflict",
      )).toThrow(/PAIRING_CONFLICT/);
      expect(store.agentTenant(agentA)).toBe(tenantA);
    } finally {
      store.onModuleDestroy();
    }
  });

  it("makes cancellation idempotent and rejects key reuse with different content", () => {
    const store = createStore();
    try {
      const exchangeId = "poff_423456789012";
      const agentDid = "did:memo:agent:985:0x2200000000000000000000000000000000000002";
      createOffer(store, exchangeId, agentDid, "d".repeat(64));
      const first = store.cancelPairingExchange(exchangeId, "agent", agentDid, "cancel-once", "1".repeat(64));
      const repeated = store.cancelPairingExchange(exchangeId, "agent", agentDid, "cancel-once", "1".repeat(64));
      expect(first.state).toBe("CANCELLED");
      expect(repeated.exchange_id).toBe(first.exchange_id);
      expect(() => store.cancelPairingExchange(
        exchangeId,
        "agent",
        agentDid,
        "cancel-once",
        "2".repeat(64),
      )).toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
    } finally {
      store.onModuleDestroy();
    }
  });

  it("freezes a Pairing management draft across registration reorg and restores it after replay", () => {
    const store = createStore();
    try {
      const agentDid = "did:memo:agent:985:0x2300000000000000000000000000000000000002";
      const identityAccount = "0x2300000000000000000000000000000000000002";
      const tenantId = "wallet:0x3000000000000000000000000000000000000003";
      const exchangeId = "poff_523456789012";
      createOffer(store, exchangeId, agentDid, "e".repeat(64));
      const paired = redeemOffer(
        store,
        exchangeId,
        "e".repeat(64),
        agentDid,
        tenantId,
        "0x3000000000000000000000000000000000000003",
        "redeem-reorg",
      );
      expect(paired.draft.state).toBe("AWAITING_WALLET_SIGNATURE");

      const registration = registrationIntent("int_registration_reorg", identityAccount, "0x" + "44".repeat(32));
      store.saveIntent(registration, "unpaired:" + agentDid, agentDid);
      const operation = store.createOperation(operationInput(registration, "unpaired:" + agentDid, registration.digest));
      store.transitionOperation(operation.operationId, "SUBMITTED");
      store.transitionOperation(operation.operationId, "INCLUDED", {
        tx_hash: "0x" + "55".repeat(32),
        block_number: 21,
        block_hash: "0x" + "66".repeat(32),
        confirmations: 1,
      });
      store.transitionOperation(operation.operationId, "CONFIRMED", { confirmations: 2 });

      store.rollbackAfter(20);
      expect(store.managementDraftForAgent(agentDid, tenantId)?.state).toBe("FROZEN_REORG");

      store.transitionOperation(operation.operationId, "SUBMITTED");
      store.transitionOperation(operation.operationId, "INCLUDED", {
        tx_hash: "0x" + "77".repeat(32),
        block_number: 22,
        block_hash: "0x" + "88".repeat(32),
        confirmations: 1,
      });
      store.transitionOperation(operation.operationId, "CONFIRMED", { confirmations: 2 });
      expect(store.managementDraftForAgent(agentDid, tenantId)?.state).toBe("AWAITING_WALLET_SIGNATURE");
    } finally {
      store.onModuleDestroy();
    }
  });
});

function createOffer(store: ChainStore, exchangeId: string, agentDid: string, tokenHash: string): void {
  store.createPairingExchange({
    exchangeId,
    kind: "agent-offer",
    tokenHash,
    platformOrigin: "http://127.0.0.1:4273",
    creatorTenantId: "unpaired:" + agentDid,
    creatorSubject: agentDid,
    agentDid,
    maxScopes: ["profile.update", "instance.issue"],
    maxTermSeconds: 2_592_000,
    requestedScopes: [],
    requestedTermSeconds: 0,
    visibility: "private",
    expiresAt: Date.now() + 60_000,
    idempotencyNamespace: "agent:" + agentDid + ":offer-create",
    idempotencyKey: "create:" + exchangeId,
    requestHash: tokenHash,
  });
}

function redeemOffer(
  store: ChainStore,
  exchangeId: string,
  tokenHash: string,
  agentDid: string,
  tenantId: string,
  walletAccount: string,
  idempotencyKey: string,
) {
  return store.redeemOffer({
    exchangeId,
    tokenHash,
    tenantId,
    walletAccount,
    requestedScopes: ["profile.update"],
    requestedTermSeconds: 86400,
    visibility: "private",
    idempotencyNamespace: tenantId + ":offer-redeem",
    idempotencyKey,
    requestHash: tokenHash + agentDid,
  });
}

function createStore(): ChainStore {
  const dataRoot = mkdtempSync(resolve(tmpdir(), "memo-mainnet-store-"));
  roots.push(dataRoot);
  return new ChainStore(new RuntimeConfigService(runtimeConfig(dataRoot)));
}

function runtimeConfig(dataRoot: string): RuntimeConfig {
  const manifest: DeploymentManifest = {
    schema: "memo.agent-did-deployment/1",
    environment: "local",
    networkName: "MEMO Mainnet Local",
    chainId: 985,
    publicRpcUrl: "http://127.0.0.1:9545",
    nativeCurrency: { name: "MEMO", symbol: "MEMO", decimals: 18 },
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: "0.7", runtimeCodeHash: "0x" + "01".repeat(32) },
    simpleAccountFactory: { address: "0x4000000000000000000000000000000000000004", deploymentBlock: 1, runtimeCodeHash: "0x" + "02".repeat(32) },
    relayerSmartAccount: {
      address: "0x5000000000000000000000000000000000000005",
      ownerAddress: "0x7000000000000000000000000000000000000007",
      ownerProvider: "dev-private-key",
      runtimeCodeHash: "0x" + "07".repeat(32),
    },
    didRegistry: { address: "0x1000000000000000000000000000000000000001", deploymentBlock: 1, runtimeCodeHash: "0x" + "03".repeat(32), abiHash: "0x" + "04".repeat(32) },
    managementRegistry: { address: "0x6000000000000000000000000000000000000006", deploymentBlock: 1, runtimeCodeHash: "0x" + "05".repeat(32), abiHash: "0x" + "06".repeat(32) },
    finality: { preferFinalizedTag: true, fallbackConfirmations: 12 },
    generatedAt: new Date().toISOString(),
  };
  return {
    environment: "local", port: 4273, primaryRpcUrl: "http://127.0.0.1:9545", secondaryRpcUrl: "http://127.0.0.1:9545",
    bundlerUrl: "http://127.0.0.1:4337", dataRoot, sessionSigningKey: "x".repeat(32), requiredConfirmations: 2,
    entryPointCodeHash: manifest.entryPoint.runtimeCodeHash, platformOrigins: [], minEntryPointDepositWei: 1n,
    minBundlerExecutorBalanceWei: 1n, manifestPath: "test", manifest,
  };
}

function intent(intentId: string, digest: string): ActionIntent {
  return {
    intentId,
    actionType: "SuspendAgent",
    domain: didDomain("0x1000000000000000000000000000000000000001"),
    types: { SuspendAgent: [
      { name: "identityAccount", type: "address" }, { name: "expectedRevision", type: "uint64" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
    ] },
    primaryType: "SuspendAgent",
    message: { identityAccount: "0x2000000000000000000000000000000000000002", expectedRevision: "1", nonce: "1", deadline: "2000000000" },
    digest,
    nonce: "1",
    expectedRevision: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function registrationIntent(intentId: string, identityAccount: string, digest: string): ActionIntent {
  return {
    intentId,
    actionType: "RegisterAgent",
    domain: didDomain("0x1000000000000000000000000000000000000001"),
    types: { RegisterAgent: [
      { name: "identityAccount", type: "address" },
      { name: "publicKeyHash", type: "bytes32" },
      { name: "documentHash", type: "bytes32" },
      { name: "profileHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ] },
    primaryType: "RegisterAgent",
    message: {
      identityAccount,
      publicKeyHash: "0x" + "11".repeat(32),
      documentHash: "0x" + "22".repeat(32),
      profileHash: "0x" + "33".repeat(32),
      nonce: "0",
      deadline: "2000000000",
    },
    digest,
    nonce: "0",
    expectedRevision: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function operationInput(value: ActionIntent, tenantId: string, idempotencyKey: string) {
  return {
    tenantId,
    intentId: value.intentId,
    actionType: value.actionType,
    digest: value.digest,
    idempotencyKey,
    signatures: { agentSignature: "0x01" },
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    smartAccount: "0x5000000000000000000000000000000000000005",
    requiredConfirmations: 2,
  };
}
