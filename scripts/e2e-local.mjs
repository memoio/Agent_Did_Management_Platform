import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Wallet } from "ethers";

const apiOrigin = process.env.MEMO_E2E_API_URL || "http://127.0.0.1:4273";
const parsedApi = new URL(apiOrigin);
if (parsedApi.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsedApi.hostname)) {
  throw new Error("LOCAL_E2E_REQUIRES_LOOPBACK_API");
}

const e2eRootParent = resolve(".data", "e2e-runs");
mkdirSync(e2eRootParent, { recursive: true, mode: 0o700 });
const e2eRoot = mkdtempSync(resolve(e2eRootParent, "run-"));
const installationId = `e2e-${Date.now()}`;
Object.assign(process.env, {
  MEMO_AGENT_MAINNET_HOME: e2eRoot,
  MEMO_AGENT_MAINNET_INSTALLATION_ID: installationId,
  MEMO_AGENT_MAINNET_KEY_PROVIDER: "env-master-key",
  MEMO_AGENT_MAINNET_MASTER_KEY: randomBytes(48).toString("base64url"),
  MEMO_AGENT_MAINNET_ENVIRONMENT: "local",
  MEMO_AGENT_MAINNET_API_URL: parsedApi.toString(),
  MEMO_AGENT_MAINNET_CHAIN_ID: "985",
  MEMO_AGENT_MAINNET_ALLOW_R2: "1",
  MEMO_AGENT_MAINNET_ALLOW_R4_TEST: "1",
});

const { loadConfig } = await import("../packages/skill/dist/config.js");
const { AgentDidService } = await import("../packages/skill/dist/service.js");
const service = new AgentDidService(loadConfig());
let invitedService;
const operationIds = [];

try {
  const health = await api("/api/v1/health");
  assert(health.status === "ok", "LOCAL_STACK_NOT_HEALTHY");
  assert(health.chain?.chainId === 985, "LOCAL_STACK_CHAIN_ID_MISMATCH");

  const ensured = service.ensureIdentity();
  const agentDid = String(ensured.agentDid);
  const identityAccount = String(ensured.identityAccount);
  const publicKey = String(ensured.publicKey);
  const registered = await service.register({
    name: "MEMO chain-985 automated E2E Agent",
    description: "Ephemeral local acceptance identity",
    capabilities: ["agent-did", "eip-712", "erc-4337"],
  }, false);
  operationIds.push(registered.operationId);

  const profileUpdate = await service.updateProfile({
    name: "MEMO chain-985 automated E2E Agent",
    description: "Profile updated through a second UserOperation",
    capabilities: ["agent-did", "eip-712", "erc-4337", "resolver-verified"],
  });
  operationIds.push(profileUpdate.operationId);

  const documentUpdate = await service.updateDocument({
    id: agentDid,
    verificationMethod: [{
      id: `${agentDid}#identity-1`,
      type: "MemoEip712Secp256k1VerificationMethod2026",
      controller: agentDid,
      blockchainAccountId: `eip155:985:${identityAccount}`,
      publicKeyMultibase: publicKey,
    }],
    authentication: [`${agentDid}#identity-1`],
    assertionMethod: [`${agentDid}#identity-1`],
    service: [{ id: `${agentDid}#agent-api`, type: "MemoAgentApi", serviceEndpoint: "https://agent-did.example.com/e2e" }],
  });
  operationIds.push(documentUpdate.operationId);

  const suspended = await service.changeIdentityState("suspend");
  const resumed = await service.changeIdentityState("resume");
  operationIds.push(suspended.operationId, resumed.operationId);

  const instances = service.listInstances().instances;
  assert(Array.isArray(instances) && instances.length > 0, "DEFAULT_INSTANCE_NOT_CREATED");
  const instanceRevocation = await service.revokeInstance(String(instances[0].instanceId), "automated acceptance");
  operationIds.push(instanceRevocation.operation.operationId);

  const pairing = await service.createPairingOffer("profile.update,instance.issue", "30d", "15m");
  const offer = pairing.pairingPackage;
  assert(offer?.schema === "memo.agent-pairing-package/2", "PAIRING_OFFER_SCHEMA_MISMATCH");
  const consoleOperator = Wallet.createRandom();
  const manager = consoleOperator;
  const managerSession = await openWalletSession(consoleOperator);
  const inspected = await api("/api/v1/pairing-offers/inspect", {
    method: "POST",
    token: managerSession,
    body: { exchangeId: offer.exchangeId, handle: offer.handle },
  });
  assert(inspected.agentDid === agentDid, "PAIRING_INSPECT_DID_MISMATCH");
  const redeemed = await api(`/api/v1/pairing-offers/${encodeURIComponent(offer.exchangeId)}/redeem`, {
    method: "POST",
    token: managerSession,
    headers: { "idempotency-key": `e2e:${installationId}:offer-redeem` },
    body: {
      handle: offer.handle,
      requestedScopes: ["profile.update", "instance.issue"],
      requestedTermSeconds: 30 * 24 * 60 * 60,
      visibility: "private",
    },
  });
  assert(redeemed.agentDid === agentDid, "PAIRING_DID_MISMATCH");
  assert(redeemed.maxTermSeconds === 30 * 24 * 60 * 60, "PAIRING_MAX_TERM_MISMATCH");
  assert(redeemed.binding?.agentDid === agentDid, "PAIRING_BINDING_NOT_CREATED");
  assert(redeemed.managementDraft?.state === "AWAITING_WALLET_SIGNATURE", "PAIRING_DRAFT_NOT_CREATED");

  const invitationExchangeId = `pinv_${randomBytes(18).toString("base64url")}`;
  const invitationHandle = `memo-pair-v2.${invitationExchangeId}.${randomBytes(32).toString("base64url")}`;
  const invitationRemote = await api("/api/v1/pairing-invitations", {
    method: "POST",
    token: managerSession,
    headers: { "idempotency-key": `e2e:${installationId}:invitation-create` },
    body: {
      exchangeId: invitationExchangeId,
      tokenHash: createHash("sha256").update(invitationHandle).digest("hex"),
      platformOrigin: parsedApi.origin,
      requestedScopes: ["profile.update"],
      requestedTermSeconds: 14 * 24 * 60 * 60,
      visibility: "private",
      ttlSeconds: 900,
    },
  });
  const invitation = {
    schema: invitationRemote.schema,
    kind: invitationRemote.kind,
    exchangeId: invitationRemote.exchangeId,
    platformOrigin: invitationRemote.platformOrigin,
    environment: invitationRemote.environment,
    chainId: invitationRemote.chainId,
    didRegistry: invitationRemote.didRegistry,
    managementRegistry: invitationRemote.managementRegistry,
    handle: invitationHandle,
    issuedAt: invitationRemote.issuedAt,
    expiresAt: invitationRemote.expiresAt,
    managerAccount: invitationRemote.managerAccount,
    requestedScopes: invitationRemote.requestedScopes,
    requestedTermSeconds: invitationRemote.requestedTermSeconds,
    visibility: invitationRemote.visibility,
  };
  process.env.MEMO_AGENT_MAINNET_HOME = resolve(e2eRoot, "invited-agent");
  process.env.MEMO_AGENT_MAINNET_INSTALLATION_ID = `${installationId}-invited`;
  invitedService = new AgentDidService(loadConfig());
  const invitationAccepted = await invitedService.acceptPairingInvitation(invitation, {
    name: "MEMO chain-985 invited E2E Agent",
    description: "Second isolated installation paired through Platform Invitation",
    capabilities: ["agent-did", "pairing-invitation"],
  });
  const invitedAgentDid = String(invitationAccepted.agentDid);
  assert(invitationAccepted.state === "PAIRED", "INVITATION_NOT_PAIRED");
  assert(invitedAgentDid !== agentDid, "MULTI_AGENT_DID_NOT_ISOLATED");
  if (invitationAccepted.operationId) operationIds.push(invitationAccepted.operationId);

  const dashboard = await api("/api/v1/dashboard", { token: managerSession });
  const dashboardDids = dashboard.agents.map((item) => item.agentDid);
  assert(dashboardDids.includes(agentDid), "OFFER_AGENT_MISSING_FROM_DASHBOARD");
  assert(dashboardDids.includes(invitedAgentDid), "INVITED_AGENT_MISSING_FROM_DASHBOARD");

  const latestBlock = await api("/api/v1/chain/blocks/latest");
  const issuedAt = Number(latestBlock.timestamp);
  await expectApiError("ISSUED_AT_IN_FUTURE", "/api/v1/management-intents", {
    method: "POST",
    token: managerSession,
    body: {
      actionType: "ActivateRelationship",
      agentDid,
      managerAccount: manager.address,
      relationshipId: `rel-${installationId}-future-rejected`,
      managementScopes: ["profile.update"],
      issuedAt: issuedAt + 60,
      expiresAt: issuedAt + 20 * 24 * 60 * 60,
      visibility: "private",
    },
  });
  await expectApiError("PAIRING_SCOPE_EXCEEDED", "/api/v1/management-intents", {
    method: "POST",
    token: managerSession,
    body: {
      actionType: "ActivateRelationship",
      agentDid,
      managerAccount: manager.address,
      relationshipId: `rel-${installationId}-scope-rejected`,
      managementScopes: ["identity.revoke"],
      issuedAt,
      expiresAt: issuedAt + 20 * 24 * 60 * 60,
      visibility: "private",
    },
  });
  await expectApiError("PAIRING_TERM_EXCEEDED", "/api/v1/management-intents", {
    method: "POST",
    token: managerSession,
    body: {
      actionType: "ActivateRelationship",
      agentDid,
      managerAccount: manager.address,
      relationshipId: `rel-${installationId}-term-rejected`,
      managementScopes: ["profile.update"],
      issuedAt,
      expiresAt: issuedAt + 31 * 24 * 60 * 60,
      visibility: "private",
    },
  });
  const activation = await managementDraftRoundTrip(
    managerSession,
    manager,
    String(redeemed.managementDraft.draftId),
  );
  operationIds.push(activation.operation.operationId);
  const activatedDashboard = await api(`/api/v1/dashboard/agents/${encodeURIComponent(agentDid)}`, { token: managerSession });
  assert(activatedDashboard.managementDraft?.state === "CONFIRMED", "MANAGEMENT_DRAFT_NOT_CONFIRMED");

  const renewal = await managementRoundTrip(managerSession, {
    actionType: "RenewRelationship",
    agentDid,
    managerAccount: manager.address,
    managementScopes: ["profile.update"],
    expiresAt: Math.floor(Date.now() / 1000) + 25 * 24 * 60 * 60,
    visibility: "public",
  }, async (intent) => ({ managerSignature: await signIntent(manager, intent) }));
  operationIds.push(renewal.operation.operationId);

  const newManager = Wallet.createRandom();
  const transfer = await managementRoundTrip(managerSession, {
    actionType: "TransferRelationship",
    agentDid,
    managerAccount: manager.address,
    newManager: newManager.address,
    newRelationshipId: `rel-${installationId}-transferred`,
    managementScopes: ["profile.update"],
    expiresAt: Math.floor(Date.now() / 1000) + 25 * 24 * 60 * 60,
    visibility: "private",
  }, async (intent) => ({
    oldManagerSignature: await signIntent(manager, intent),
    newManagerSignature: await signIntent(newManager, intent),
  }));
  operationIds.push(transfer.operation.operationId);

  const ended = await managementRoundTrip(managerSession, {
    actionType: "EndRelationship",
    agentDid,
    managerAccount: manager.address,
    actor: newManager.address,
    reason: "automated acceptance complete",
  }, async (intent) => ({ actorSignature: await signIntent(newManager, intent) }));
  operationIds.push(ended.operation.operationId);

  const revoked = await service.changeIdentityState("revoke");
  operationIds.push(revoked.operationId);
  const resolved = await service.resolve(agentDid, true);
  assert(resolved.status === "revoked", "RESOLVER_FINAL_STATUS_MISMATCH");
  assert(resolved.didResolutionMetadata?.contentHashesVerified === true, "RESOLVER_HASH_VERIFICATION_FAILED");

  process.stdout.write(JSON.stringify({
    passed: true,
    chainId: 985,
    agentDid,
    finalStatus: resolved.status,
    finalRevision: resolved.revision,
    operationCount: operationIds.filter(Boolean).length,
    operationIds: operationIds.filter(Boolean),
    entryPointCodeHash: health.chain.entryPointCodeHash,
    relayerSmartAccountOwner: health.chain.relayerSmartAccountOwner,
  }) + "\n");
} finally {
  invitedService?.close();
  service.close();
  rmSync(e2eRoot, { recursive: true, force: true });
}

async function managementRoundTrip(walletToken, input, signatures) {
  const intent = await api("/api/v1/management-intents", { method: "POST", token: walletToken, body: input });
  const managerSignatures = await signatures(intent);
  const queued = await api("/api/v1/management-requests", {
    method: "POST",
    token: walletToken,
    body: { intentId: intent.intentId, signatures: managerSignatures },
  });
  const next = await service.nextAgentRequest(2);
  assert(next.request?.requestId === queued.requestId, "AGENT_REQUEST_QUEUE_MISMATCH");
  const decision = await service.decideAgentRequest(queued.requestId, "approve");
  assert(decision.operation?.state === "CONFIRMED", "MANAGEMENT_OPERATION_NOT_CONFIRMED");
  return decision;
}

async function managementDraftRoundTrip(walletToken, wallet, draftId) {
  const created = await api(`/api/v1/management-drafts/${encodeURIComponent(draftId)}/intent`, {
    method: "POST",
    token: walletToken,
  });
  const signature = await signIntent(wallet, created.intent);
  const queued = await api(`/api/v1/management-drafts/${encodeURIComponent(draftId)}/wallet-signature`, {
    method: "POST",
    token: walletToken,
    headers: { "idempotency-key": `e2e:${draftId}:wallet-signature` },
    body: { intentId: created.intent.intentId, managerSignature: signature },
  });
  const next = await service.nextAgentRequest(2);
  assert(next.request?.requestId === queued.requestId, "MANAGEMENT_DRAFT_AGENT_QUEUE_MISMATCH");
  const decision = await service.decideAgentRequest(queued.requestId, "approve");
  assert(decision.operation?.state === "CONFIRMED", "MANAGEMENT_DRAFT_OPERATION_NOT_CONFIRMED");
  return decision;
}

async function signIntent(wallet, intent) {
  return wallet.signTypedData(intent.domain, intent.types, intent.message);
}

async function openWalletSession(wallet) {
  const challenge = await api("/api/v1/wallet-login-intents", {
    method: "POST",
    body: { account: wallet.address, chainId: 985 },
  });
  const signature = await wallet.signMessage(challenge.message);
  const session = await api("/api/v1/wallet-sessions", {
    method: "POST",
    body: { challengeId: challenge.challengeId, signature },
  });
  return session.token;
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, parsedApi), {
    method: options.method || "GET",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) throw new Error(envelope.error?.code || `HTTP_${response.status}`);
  return envelope.data;
}

async function expectApiError(expectedCode, path, options) {
  try {
    await api(path, options);
  } catch (error) {
    if (error instanceof Error && error.message === expectedCode) return;
    throw error;
  }
  throw new Error(`EXPECTED_API_ERROR_NOT_RAISED:${expectedCode}`);
}

function assert(value, code) {
  if (!value) throw new Error(code);
}
