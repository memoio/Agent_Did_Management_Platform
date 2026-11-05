import { Body, Controller, Delete, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RuntimeConfigService } from "./config.service.js";
import { SessionService } from "./session.service.js";
import { ChainStore } from "./store.service.js";
import { IntentService } from "./intent.service.js";
import { PairingService, draftView } from "./pairing.service.js";
import { ResolverService } from "./resolver.service.js";
import { ChainHealthService } from "./chain-health.service.js";
import { DashboardService } from "./dashboard.service.js";

@Controller("api/v1")
export class ApiController {
  constructor(
    private readonly config: RuntimeConfigService,
    private readonly sessions: SessionService,
    private readonly store: ChainStore,
    private readonly intents: IntentService,
    private readonly pairing: PairingService,
    private readonly resolver: ResolverService,
    private readonly chain: ChainHealthService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get("health")
  health() {
    return this.chain.health();
  }

  @Get("chain/config")
  chainConfig() {
    return this.config.publicChainConfig();
  }

  @Get("chain/accounts")
  async chainAccounts() {
    const health = await this.chain.health();
    return { relayerSmartAccount: health.relayerSmartAccount };
  }

  @Get("chain/blocks/latest")
  latestBlock() {
    return this.chain.latestBlock();
  }

  @Get("transactions/:txHash")
  transaction(@Param("txHash") hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("INVALID_TRANSACTION_HASH");
    return this.chain.transaction(hash);
  }

  @Get("operations/:operationId")
  operation(@Param("operationId") id: string, @Headers("authorization") authorization?: string) {
    const principal = this.sessions.require(this.sessions.bearer(authorization));
    const operation = this.store.operation(id);
    if (!operation || operation.tenantId !== principal.tenantId) throw new Error("OPERATION_NOT_FOUND");
    return operation;
  }

  @Post("agent-sessions/challenges")
  agentChallenge(@Body() body: { agentDid?: string }) {
    return this.sessions.createAgentChallenge(required(body.agentDid, "AGENT_DID_REQUIRED"));
  }

  @Post("agent-sessions")
  agentSession(@Body() body: { challengeId?: string; signature?: string }) {
    return this.sessions.createAgentSession(
      required(body.challengeId, "CHALLENGE_ID_REQUIRED"),
      required(body.signature, "SIGNATURE_REQUIRED"),
    );
  }

  @Post("wallet-login-intents")
  walletChallenge(@Body() body: { account?: string; chainId?: number }) {
    if (body.chainId !== 985) throw new Error("UNSUPPORTED_WALLET_NETWORK");
    return this.sessions.createWalletChallenge(required(body.account, "ACCOUNT_REQUIRED"));
  }

  @Post("wallet-sessions")
  walletSession(@Body() body: { challengeId?: string; intentId?: string; signature?: string }) {
    return this.sessions.createWalletSession(
      required(body.challengeId || body.intentId, "CHALLENGE_ID_REQUIRED"),
      required(body.signature, "SIGNATURE_REQUIRED"),
    );
  }

  @Get("wallet-session")
  currentWalletSession(@Headers("authorization") authorization?: string) {
    const principal = this.wallet(authorization);
    return { account: principal.subject, tenantId: principal.tenantId };
  }

  @Delete("wallet-session")
  deleteWalletSession(@Headers("authorization") authorization?: string) {
    const token = this.sessions.bearer(authorization);
    this.sessions.require(token, "wallet");
    this.sessions.revoke(token!);
    return { revoked: true };
  }

  @Get("dashboard")
  dashboard(@Headers("authorization") authorization?: string) {
    return this.dashboardService.view(this.wallet(authorization));
  }

  @Get("dashboard/agents/:did")
  dashboardAgent(@Param("did") did: string, @Headers("authorization") authorization?: string) {
    return this.dashboardService.detail(this.wallet(authorization), decodeURIComponent(did));
  }

  @Post("registration-intents")
  createRegistration(
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
  ) {
    return this.intents.createRegistration(this.agent(authorization), body);
  }

  @Post("registry-action-intents")
  createRegistryAction(
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
  ) {
    return this.intents.createRegistryAction(this.agent(authorization), body);
  }

  @Post("management-intents")
  createManagementIntent(
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
  ) {
    return this.intents.createManagementAction(this.wallet(authorization), body);
  }

  @Post("agent-dids")
  register(
    @Body() body: { intentId?: string; signature?: string },
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.intents.submit(this.agent(authorization), {
      intentId: required(body.intentId, "INTENT_ID_REQUIRED"),
      signature: required(body.signature, "SIGNATURE_REQUIRED"),
      idempotencyKey: required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    });
  }

  @Post("registry-actions")
  registryAction(
    @Body() body: { intentId?: string; signature?: string },
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.register(body, authorization, idempotencyKey);
  }

  @Post("management-actions")
  managementAction(
    @Body() body: { intentId?: string; signatures?: Record<string, string> },
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.intents.submit(this.wallet(authorization), {
      intentId: required(body.intentId, "INTENT_ID_REQUIRED"),
      signatures: body.signatures || {},
      idempotencyKey: required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    });
  }

  @Get("agent-dids/:did")
  resolve(@Param("did") did: string) {
    return this.resolver.resolve(decodeURIComponent(did));
  }

  @Post("pairing-invitations")
  createPairingInvitation(
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.createInvitation(this.wallet(authorization), body, required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"));
  }

  @Post("pairing-invitations/inspect")
  inspectPairingInvitation(@Body() body: Record<string, unknown>, @Headers("authorization") authorization?: string) {
    return this.pairing.inspectInvitation(this.agent(authorization), body);
  }

  @Post("pairing-invitations/:id/claim")
  claimPairingInvitation(
    @Param("id") exchangeId: string,
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.claimInvitation(
      this.agent(authorization), exchangeId, body, required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    );
  }

  @Post("pairing-invitations/:id/complete")
  completePairingInvitation(
    @Param("id") exchangeId: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.completeInvitation(
      this.agent(authorization), exchangeId, required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    );
  }

  @Post("pairing-offers")
  createPairingOffer(
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.createOffer(this.agent(authorization), body, required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"));
  }

  @Post("pairing-offers/inspect")
  inspectPairingOffer(@Body() body: Record<string, unknown>, @Headers("authorization") authorization?: string) {
    return this.pairing.inspectOffer(this.wallet(authorization), body);
  }

  @Post("pairing-offers/:id/redeem")
  redeemPairingOffer(
    @Param("id") exchangeId: string,
    @Body() body: Record<string, unknown>,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.redeemOffer(
      this.wallet(authorization), exchangeId, body, required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    );
  }

  @Get("pairing-exchanges/:id")
  pairingExchange(@Param("id") exchangeId: string, @Headers("authorization") authorization?: string) {
    return this.pairing.status(this.sessions.require(this.sessions.bearer(authorization)), exchangeId);
  }

  @Post("pairing-exchanges/:id/cancel")
  cancelPairingExchange(
    @Param("id") exchangeId: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.pairing.cancel(
      this.sessions.require(this.sessions.bearer(authorization)),
      exchangeId,
      required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED"),
    );
  }

  @Get("pairings")
  pairings(@Headers("authorization") authorization?: string) {
    return this.pairing.listBindings(this.wallet(authorization));
  }

  @Post("pairings/:bindingId/end")
  endPairing(@Param("bindingId") bindingId: string, @Headers("authorization") authorization?: string) {
    return this.pairing.endBinding(this.wallet(authorization), bindingId);
  }

  @Post("agent-dids/:did/pairing-grants")
  removedPairingGrantCreate() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Post("pairing-grants/redeem")
  removedPairingGrantRedeem() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Post("pairing-grants/resolve")
  removedPairingGrantResolve() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Get("pairing-grants/:grantHash/status")
  removedPairingGrantStatus() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Post("pairing-grants/:grantHash/cancel")
  removedPairingGrantCancel() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Post("bootstrap-intents")
  removedBootstrapIntentCreate() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Get("bootstrap-intents/:id")
  removedBootstrapIntentStatus() {
    throw new Error("PAIRING_V1_REMOVED");
  }

  @Post("management-drafts/:id/intent")
  async managementDraftIntent(
    @Param("id") draftId: string,
    @Headers("authorization") authorization?: string,
  ) {
    const principal = this.wallet(authorization);
    const draft = this.store.managementDraft(draftId, principal.tenantId);
    if (!draft) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
    if (Number(draft.expires_at) <= Date.now()) throw new Error("MANAGEMENT_DRAFT_EXPIRED");
    if (!['AWAITING_WALLET_SIGNATURE', 'WAITING_AGENT'].includes(String(draft.state))) {
      throw new Error("MANAGEMENT_DRAFT_NOT_SIGNABLE");
    }
    const latestBlock = await this.chain.latestBlock();
    const issuedAt = Number(latestBlock.timestamp);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("CHAIN_HEAD_UNAVAILABLE");
    const intent = await this.intents.createManagementAction(principal, {
      actionType: "ActivateRelationship",
      agentDid: String(draft.agent_did),
      managerAccount: String(draft.manager_account),
      relationshipId: String(draft.relationship_id),
      managementScopes: JSON.parse(String(draft.scopes_json)),
      issuedAt,
      expiresAt: issuedAt + Number(draft.term_seconds),
      visibility: String(draft.visibility),
    });
    this.store.updateManagementDraft(draftId, principal.tenantId, "AWAITING_WALLET_SIGNATURE", { intentId: intent.intentId });
    return { draft: draftView(this.store.managementDraft(draftId, principal.tenantId)!), intent };
  }

  @Post("management-drafts/:id/wallet-signature")
  async managementDraftWalletSignature(
    @Param("id") draftId: string,
    @Body() body: { intentId?: string; managerSignature?: string },
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const principal = this.wallet(authorization);
    const draft = this.store.managementDraft(draftId, principal.tenantId);
    if (!draft) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
    if (Number(draft.expires_at) <= Date.now()) throw new Error("MANAGEMENT_DRAFT_EXPIRED");
    const intentId = required(body.intentId, "INTENT_ID_REQUIRED");
    if (draft.intent_id && draft.intent_id !== intentId) throw new Error("MANAGEMENT_DRAFT_INTENT_MISMATCH");
    const intent = this.store.intent(intentId);
    if (!intent || intent.tenant_id !== principal.tenantId) throw new Error("INTENT_NOT_FOUND");
    const message = JSON.parse(String(intent.message_json)) as { agent?: string; manager?: string };
    const agentDid = "did:memo:agent:985:" + String(message.agent).toLowerCase();
    if (agentDid !== draft.agent_did || String(message.manager).toLowerCase() !== String(draft.manager_account).toLowerCase()) {
      throw new Error("MANAGEMENT_DRAFT_INTENT_MISMATCH");
    }
    const signatures = { managerSignature: required(body.managerSignature, "MANAGER_SIGNATURE_REQUIRED") };
    await this.intents.assertManagerProofForQueue(intentId, signatures);
    const key = required(idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
    const payload = {
        intentId,
        actionType: intent.action_type,
        domain: JSON.parse(String(intent.domain_json)),
        types: JSON.parse(String(intent.types_json)),
        message,
        digest: intent.digest,
        managerSignatures: signatures,
        managementDraftId: draftId,
      };
    const queued = this.store.queueManagementDraftRequest({
      draftId,
      tenantId: principal.tenantId,
      agentDid,
      payload,
      expiresAt: Number(intent.expires_at),
      idempotencyKey: key,
      requestHash: createHash("sha256").update(JSON.stringify({ intentId, managerSignature: signatures.managerSignature })).digest("hex"),
    });
    this.store.updateManagementDraft(draftId, principal.tenantId, "WAITING_AGENT", { intentId, requestId: queued.requestId });
    return {
      draft: draftView(this.store.managementDraft(draftId, principal.tenantId)!),
      requestId: queued.requestId,
      agentDid,
      state: "WAITING_AGENT",
      reused: queued.reused,
    };
  }

  @Post("management-requests")
  queueManagement(
    @Body() body: { intentId?: string; managerSignature?: string; signatures?: Record<string, string>; summary?: unknown },
    @Headers("authorization") authorization?: string,
  ) {
    const principal = this.wallet(authorization);
    const intentId = required(body.intentId, "INTENT_ID_REQUIRED");
    const intent = this.store.intent(intentId);
    if (!intent || intent.tenant_id !== principal.tenantId) throw new Error("INTENT_NOT_FOUND");
    const message = JSON.parse(String(intent.message_json)) as { agent?: string };
    const agentDid = "did:memo:agent:985:" + String(message.agent).toLowerCase();
    const managerSignatures = body.signatures || { managerSignature: required(body.managerSignature, "MANAGER_SIGNATURE_REQUIRED") };
    return this.intents.assertManagerProofForQueue(intentId, managerSignatures).then(() => {
      const requestId = this.store.queueAgentRequest({
      tenantId: principal.tenantId,
      agentDid,
      requestType: "management-signature",
      payload: {
        intentId,
        actionType: intent.action_type,
        domain: JSON.parse(String(intent.domain_json)),
        types: JSON.parse(String(intent.types_json)),
        message,
        digest: intent.digest,
        managerSignatures,
        summary: body.summary || null,
      },
      expiresAt: Number(intent.expires_at),
      });
      return { requestId, agentDid, state: "PENDING", expiresAt: new Date(Number(intent.expires_at)).toISOString() };
    });
  }

  @Get("agent-requests/next")
  async nextAgentRequest(
    @Headers("authorization") authorization?: string,
    @Query("waitSeconds") waitSecondsValue?: string,
  ) {
    const principal = this.agent(authorization);
    const waitSeconds = Math.min(25, Math.max(0, Number(waitSecondsValue || 20)));
    const deadline = Date.now() + waitSeconds * 1000;
    do {
      const row = this.store.nextAgentRequest(principal.tenantId, principal.subject);
      if (row) return agentRequestView(row);
      if (Date.now() >= deadline) break;
      await delay(250);
    } while (true);
    return { request: null };
  }

  @Post("agent-requests/:id/decision")
  async decideAgentRequest(
    @Param("id") requestId: string,
    @Body() body: { decision?: string; agentSignature?: string; idempotencyKey?: string; reason?: string },
    @Headers("authorization") authorization?: string,
  ) {
    const principal = this.agent(authorization);
    const row = this.store.nextAgentRequest(principal.tenantId, principal.subject);
    if (!row || row.request_id !== requestId) throw new Error("AGENT_REQUEST_NOT_PENDING");
    const payload = JSON.parse(String(row.payload_json)) as {
      intentId: string;
      digest: string;
      managerSignatures: Record<string, string>;
      actionType: string;
      managementDraftId?: string;
    };
    if (payload.managementDraftId) {
      const draft = this.store.managementDraft(payload.managementDraftId, principal.tenantId);
      if (draft?.state === "FROZEN_REORG") throw new Error("PAIRING_REGISTRATION_REORGED");
    }
    if (body.decision === "reject") {
      this.store.decideAgentRequest(requestId, principal.tenantId, principal.subject, "REJECTED", {
        reason: body.reason || "declined",
      });
      if (payload.managementDraftId) {
        this.store.updateManagementDraft(payload.managementDraftId, principal.tenantId, "REJECTED", { requestId });
      }
      return { requestId, state: "REJECTED" };
    }
    if (body.decision !== "approve") throw new Error("INVALID_AGENT_DECISION");
    const signatures = signaturesForManagementAction(
      payload.actionType,
      required(body.agentSignature, "AGENT_SIGNATURE_REQUIRED"),
      payload.managerSignatures,
    );
    const operation = await this.intents.submit(principal, {
      intentId: payload.intentId,
      signatures,
      idempotencyKey: body.idempotencyKey || payload.digest,
    });
    this.store.decideAgentRequest(requestId, principal.tenantId, principal.subject, "APPROVED", {
      operationId: operation.operationId,
    });
    if (payload.managementDraftId) {
      this.store.updateManagementDraft(payload.managementDraftId, principal.tenantId, "SUBMITTED", { requestId });
    }
    return { requestId, state: "APPROVED", operation };
  }

  @Post("bootstrap")
  bootstrap() {
    throw new Error("LOCAL_AGENT_CONNECTION_REQUIRED");
  }

  private agent(authorization?: string) {
    return this.sessions.require(this.sessions.bearer(authorization), "agent");
  }

  private wallet(authorization?: string) {
    return this.sessions.require(this.sessions.bearer(authorization), "wallet");
  }
}

function required(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}

function agentRequestView(row: Record<string, unknown>) {
  return {
    request: {
      requestId: String(row.request_id),
      type: String(row.request_type),
      payload: JSON.parse(String(row.payload_json)),
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
    },
  };
}

function signaturesForManagementAction(
  actionType: string,
  agentSignature: string,
  managerSignatures: Record<string, string>,
): Record<string, string> {
  if (actionType === "TransferRelationship") {
    return { ...managerSignatures, agentSignature };
  }
  if (actionType === "EndRelationship") {
    return Object.keys(managerSignatures).length > 0 ? managerSignatures : { actorSignature: agentSignature };
  }
  return { ...managerSignatures, agentSignature };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
