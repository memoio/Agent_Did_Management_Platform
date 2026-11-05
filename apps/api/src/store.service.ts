import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ActionIntent, OperationState, OperationView } from "../../../packages/protocol/src/index.js";
import { assertOperationTransition } from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";

export type StoreRow = Record<string, unknown>;
type SqlValue = null | number | bigint | string | Uint8Array;

@Injectable()
export class ChainStore implements OnModuleDestroy {
  readonly db: DatabaseSync;
  private readonly requiredConfirmations: number;

  constructor(config: RuntimeConfigService) {
    this.requiredConfirmations = config.value.requiredConfirmations;
    const path = resolve(config.value.dataRoot, "agent-did-mainnet.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertChallenge(input: {
    challengeId: string;
    kind: "agent" | "wallet";
    subject: string;
    nonceHash: string;
    message: string;
    expiresAt: number;
  }): void {
    this.db.prepare(
      "INSERT INTO challenges(challenge_id,kind,subject,nonce_hash,message,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(input.challengeId, input.kind, input.subject, input.nonceHash, input.message, input.expiresAt, Date.now());
  }

  consumeChallenge(challengeId: string, kind: "agent" | "wallet"): StoreRow | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM challenges WHERE challenge_id=? AND kind=? AND consumed_at IS NULL",
      ).get(challengeId, kind) as StoreRow | undefined;
      if (!row || Number(row.expires_at) <= Date.now()) return undefined;
      this.db.prepare("UPDATE challenges SET consumed_at=? WHERE challenge_id=?").run(Date.now(), challengeId);
      return row;
    });
  }

  createSession(input: {
    kind: "agent" | "wallet";
    subject: string;
    tenantId: string;
    expiresAt: number;
  }): string {
    const token = randomBytes(32).toString("base64url");
    const id = sessionHash(token);
    this.db.prepare(
      "INSERT INTO sessions(session_id,kind,subject,tenant_id,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, input.kind, input.subject, input.tenantId, input.expiresAt, Date.now());
    return token;
  }

  session(token: string, kind?: "agent" | "wallet"): StoreRow | undefined {
    const id = sessionHash(token);
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE session_id=? AND revoked_at IS NULL AND expires_at>?",
    ).get(id, Date.now()) as StoreRow | undefined;
    if (!row || (kind && row.kind !== kind)) return undefined;
    return row;
  }

  revokeSession(token: string): void {
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE session_id=?").run(Date.now(), sessionHash(token));
  }

  agentTenant(agentDid: string): string {
    const row = this.db.prepare("SELECT tenant_id FROM agent_bindings WHERE agent_did=? AND state='ACTIVE'")
      .get(agentDid) as StoreRow | undefined;
    return row ? String(row.tenant_id) : "unpaired:" + agentDid;
  }

  agentBinding(agentDid: string, tenantId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM agent_bindings WHERE agent_did=? AND tenant_id=? AND state='ACTIVE'")
      .get(agentDid, tenantId) as StoreRow | undefined;
  }

  agentBindingsForTenant(tenantId: string): StoreRow[] {
    return this.db.prepare("SELECT * FROM agent_bindings WHERE tenant_id=? AND state='ACTIVE' ORDER BY created_at DESC")
      .all(tenantId) as StoreRow[];
  }

  bindingById(bindingId: string, tenantId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM agent_bindings WHERE binding_id=? AND tenant_id=? AND state='ACTIVE'")
      .get(bindingId, tenantId) as StoreRow | undefined;
  }

  queueAgentRequest(input: {
    tenantId: string;
    agentDid: string;
    requestType: string;
    payload: unknown;
    expiresAt: number;
  }): string {
    const id = "req_" + randomUUID();
    this.db.prepare(
      "INSERT INTO agent_requests(request_id,tenant_id,agent_did,request_type,payload_json,state,expires_at,created_at) VALUES(?,?,?,?,?,'PENDING',?,?)",
    ).run(id, input.tenantId, input.agentDid, input.requestType, JSON.stringify(input.payload), input.expiresAt, Date.now());
    return id;
  }

  nextAgentRequest(tenantId: string, agentDid: string): StoreRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agent_requests WHERE tenant_id=? AND agent_did=? AND state='PENDING' AND expires_at>? ORDER BY created_at LIMIT 1",
    ).get(tenantId, agentDid, Date.now()) as StoreRow | undefined;
  }

  decideAgentRequest(
    requestId: string,
    tenantId: string,
    agentDid: string,
    decision: "APPROVED" | "REJECTED",
    result: unknown,
  ): void {
    const changed = this.db.prepare(
      "UPDATE agent_requests SET state=?,decision_json=?,decided_at=? WHERE request_id=? AND tenant_id=? AND agent_did=? AND state='PENDING'",
    ).run(decision, JSON.stringify(result), Date.now(), requestId, tenantId, agentDid);
    if (Number(changed.changes) !== 1) throw new Error("AGENT_REQUEST_NOT_PENDING");
  }

  createPairingExchange(input: {
    exchangeId: string;
    kind: "platform-invitation" | "agent-offer";
    tokenHash: string;
    platformOrigin: string;
    creatorTenantId: string;
    creatorSubject: string;
    agentDid?: string;
    managerAccount?: string;
    maxScopes: string[];
    maxTermSeconds: number;
    requestedScopes: string[];
    requestedTermSeconds: number;
    visibility: "private" | "public";
    expiresAt: number;
    idempotencyNamespace: string;
    idempotencyKey: string;
    requestHash: string;
  }): StoreRow {
    return this.transaction(() => {
      const repeated = this.pairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash);
      if (repeated) return this.pairingExchange(String(repeated.resource_id))!;
      if (this.pairingExchange(input.exchangeId)) throw new Error("PAIRING_EXCHANGE_ID_CONFLICT");
      const now = Date.now();
      this.db.prepare(`INSERT INTO pairing_exchanges(
        exchange_id,kind,token_hash,platform_origin,creator_tenant_id,creator_subject,agent_did,manager_account,
        max_scopes_json,max_term_seconds,requested_scopes_json,requested_term_seconds,visibility,
        state,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'CREATED',?,?,?)`).run(
        input.exchangeId,
        input.kind,
        input.tokenHash,
        input.platformOrigin,
        input.creatorTenantId,
        input.creatorSubject,
        input.agentDid ?? null,
        input.managerAccount ?? null,
        JSON.stringify(input.maxScopes),
        input.maxTermSeconds,
        JSON.stringify(input.requestedScopes),
        input.requestedTermSeconds,
        input.visibility,
        input.expiresAt,
        now,
        now,
      );
      this.recordPairingIdempotency(
        input.idempotencyNamespace,
        input.idempotencyKey,
        input.requestHash,
        input.exchangeId,
      );
      this.appendAudit(input.creatorTenantId, "PAIRING_" + input.kind.toUpperCase().replace("-", "_") + "_CREATED", input.exchangeId, "platform", {
        kind: input.kind,
        agentDid: input.agentDid ?? null,
        managerAccount: input.managerAccount ?? null,
        expiresAt: input.expiresAt,
      });
      return this.pairingExchange(input.exchangeId)!;
    });
  }

  pairingExchange(exchangeId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM pairing_exchanges WHERE exchange_id=?").get(exchangeId) as StoreRow | undefined;
  }

  latestPairingForAgent(agentDid: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM pairing_exchanges WHERE agent_did=? ORDER BY created_at DESC LIMIT 1")
      .get(agentDid) as StoreRow | undefined;
  }

  pairingExchangesForTenant(tenantId: string, limit = 100): StoreRow[] {
    return this.db.prepare(`SELECT DISTINCT p.* FROM pairing_exchanges p
      LEFT JOIN agent_bindings b ON b.binding_id=p.binding_id
      WHERE p.creator_tenant_id=? OR b.tenant_id=?
      ORDER BY p.created_at DESC LIMIT ?`)
      .all(tenantId, tenantId, Math.max(1, Math.min(500, limit))) as StoreRow[];
  }

  claimInvitation(input: {
    exchangeId: string;
    tokenHash: string;
    agentDid: string;
    idempotencyNamespace: string;
    idempotencyKey: string;
    requestHash: string;
  }): StoreRow {
    return this.transaction(() => {
      const repeated = this.pairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash);
      if (repeated) return this.pairingExchange(String(repeated.resource_id))!;
      const row = this.pairingExchange(input.exchangeId);
      if (!row || row.kind !== "platform-invitation" || row.token_hash !== input.tokenHash) throw new Error("PAIRING_INVALID_OR_EXPIRED");
      if (["CANCELLED", "EXPIRED", "FAILED"].includes(String(row.state)) || Number(row.expires_at) <= Date.now()) {
        throw new Error("PAIRING_INVALID_OR_EXPIRED");
      }
      if (row.agent_did && row.agent_did !== input.agentDid) throw new Error("PAIRING_INVALID_OR_EXPIRED");
      const binding = this.db.prepare("SELECT tenant_id FROM agent_bindings WHERE agent_did=? AND state='ACTIVE'")
        .get(input.agentDid) as StoreRow | undefined;
      if (binding && binding.tenant_id !== row.creator_tenant_id) throw new Error("PAIRING_CONFLICT");
      if (row.state === "CREATED") {
        const now = Date.now();
        this.db.prepare(`UPDATE pairing_exchanges SET agent_did=?,state='REGISTRATION_PENDING',claimed_at=?,
          completion_deadline=?,updated_at=? WHERE exchange_id=?`)
          .run(input.agentDid, now, now + 30 * 60_000, now, input.exchangeId);
      } else if (!["CLAIMED", "REGISTRATION_PENDING", "PAIRED"].includes(String(row.state))) {
        throw new Error("PAIRING_INVALID_OR_EXPIRED");
      }
      this.recordPairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash, input.exchangeId);
      return this.pairingExchange(input.exchangeId)!;
    });
  }

  completeInvitation(input: {
    exchangeId: string;
    agentDid: string;
    idempotencyNamespace: string;
    idempotencyKey: string;
    requestHash: string;
  }): { exchange: StoreRow; binding: StoreRow; draft: StoreRow; reused: boolean } {
    return this.transaction(() => {
      const repeated = this.pairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash);
      if (repeated) return this.pairingCompletion(String(repeated.resource_id));
      const row = this.pairingExchange(input.exchangeId);
      if (!row || row.kind !== "platform-invitation" || row.agent_did !== input.agentDid) throw new Error("PAIRING_INVALID_OR_EXPIRED");
      if (row.state === "PAIRED") return this.pairingCompletion(input.exchangeId);
      if (row.state !== "REGISTRATION_PENDING" || Number(row.completion_deadline || 0) <= Date.now()) {
        throw new Error("PAIRING_INVALID_OR_EXPIRED");
      }
      const result = this.createBindingAndDraft(row, {
        agentDid: input.agentDid,
        tenantId: String(row.creator_tenant_id),
        walletAccount: String(row.manager_account),
        maxScopes: JSON.parse(String(row.max_scopes_json)) as string[],
        maxTermSeconds: Number(row.max_term_seconds),
        requestedScopes: JSON.parse(String(row.requested_scopes_json)) as string[],
        requestedTermSeconds: Number(row.requested_term_seconds),
        visibility: String(row.visibility) as "private" | "public",
      });
      this.recordPairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash, input.exchangeId);
      return result;
    });
  }

  redeemOffer(input: {
    exchangeId: string;
    tokenHash: string;
    tenantId: string;
    walletAccount: string;
    requestedScopes: string[];
    requestedTermSeconds: number;
    visibility: "private" | "public";
    idempotencyNamespace: string;
    idempotencyKey: string;
    requestHash: string;
  }): { exchange: StoreRow; binding: StoreRow; draft: StoreRow; reused: boolean } {
    return this.transaction(() => {
      const repeated = this.pairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash);
      if (repeated) return this.pairingCompletion(String(repeated.resource_id));
      const row = this.pairingExchange(input.exchangeId);
      if (!row || row.kind !== "agent-offer" || row.token_hash !== input.tokenHash) throw new Error("PAIRING_INVALID_OR_EXPIRED");
      if (row.state === "PAIRED") return this.pairingCompletion(input.exchangeId);
      if (row.state !== "CREATED" || Number(row.expires_at) <= Date.now()) throw new Error("PAIRING_INVALID_OR_EXPIRED");
      const allowed = new Set(JSON.parse(String(row.max_scopes_json)) as string[]);
      if (input.requestedScopes.some((scope) => !allowed.has(scope))) throw new Error("PAIRING_SCOPE_EXCEEDED");
      if (input.requestedTermSeconds > Number(row.max_term_seconds)) throw new Error("PAIRING_TERM_EXCEEDED");
      this.db.prepare(`UPDATE pairing_exchanges SET manager_account=?,requested_scopes_json=?,requested_term_seconds=?,
        visibility=?,updated_at=? WHERE exchange_id=?`).run(
        input.walletAccount,
        JSON.stringify(input.requestedScopes),
        input.requestedTermSeconds,
        input.visibility,
        Date.now(),
        input.exchangeId,
      );
      const updated = this.pairingExchange(input.exchangeId)!;
      const result = this.createBindingAndDraft(updated, {
        agentDid: String(updated.agent_did),
        tenantId: input.tenantId,
        walletAccount: input.walletAccount,
        maxScopes: JSON.parse(String(updated.max_scopes_json)) as string[],
        maxTermSeconds: Number(updated.max_term_seconds),
        requestedScopes: input.requestedScopes,
        requestedTermSeconds: input.requestedTermSeconds,
        visibility: input.visibility,
      });
      this.recordPairingIdempotency(input.idempotencyNamespace, input.idempotencyKey, input.requestHash, input.exchangeId);
      return result;
    });
  }

  cancelPairingExchange(
    exchangeId: string,
    principalKind: "agent" | "wallet",
    subject: string,
    idempotencyKey: string,
    requestHash: string,
  ): StoreRow {
    return this.transaction(() => {
      const namespace = principalKind + ":" + subject.toLowerCase() + ":pairing-cancel";
      const repeated = this.pairingIdempotency(namespace, idempotencyKey, requestHash);
      if (repeated) return this.pairingExchange(String(repeated.resource_id))!;
      const row = this.pairingExchange(exchangeId);
      if (!row) throw new Error("PAIRING_NOT_FOUND");
      const authorized = principalKind === "wallet"
        ? row.creator_tenant_id === "wallet:" + subject.toLowerCase()
        : row.creator_subject === subject || row.agent_did === subject;
      if (!authorized) throw new Error("PAIRING_ACCESS_DENIED");
      if (row.state === "PAIRED") throw new Error("PAIRING_ALREADY_COMPLETED");
      if (!['CANCELLED', 'EXPIRED'].includes(String(row.state))) {
        this.db.prepare("UPDATE pairing_exchanges SET state='CANCELLED',cancelled_at=?,updated_at=? WHERE exchange_id=?")
          .run(Date.now(), Date.now(), exchangeId);
      }
      this.recordPairingIdempotency(namespace, idempotencyKey, requestHash, exchangeId);
      return this.pairingExchange(exchangeId)!;
    });
  }

  managementDraft(draftId: string, tenantId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM management_drafts WHERE draft_id=? AND tenant_id=?")
      .get(draftId, tenantId) as StoreRow | undefined;
  }

  managementDraftForAgent(agentDid: string, tenantId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM management_drafts WHERE agent_did=? AND tenant_id=? ORDER BY created_at DESC LIMIT 1")
      .get(agentDid, tenantId) as StoreRow | undefined;
  }

  updateManagementDraft(draftId: string, tenantId: string, state: string, patch: { intentId?: string; requestId?: string } = {}): StoreRow {
    const changed = this.db.prepare(`UPDATE management_drafts SET state=?,intent_id=COALESCE(?,intent_id),
      request_id=COALESCE(?,request_id),updated_at=? WHERE draft_id=? AND tenant_id=?`)
      .run(state, patch.intentId ?? null, patch.requestId ?? null, Date.now(), draftId, tenantId);
    if (Number(changed.changes) !== 1) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
    return this.managementDraft(draftId, tenantId)!;
  }

  managementDraftForRequest(requestId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM management_drafts WHERE request_id=?").get(requestId) as StoreRow | undefined;
  }

  queueManagementDraftRequest(input: {
    draftId: string;
    tenantId: string;
    agentDid: string;
    payload: unknown;
    expiresAt: number;
    idempotencyKey: string;
    requestHash: string;
  }): { requestId: string; reused: boolean } {
    return this.transaction(() => {
      const namespace = input.tenantId + ":management-draft-signature";
      const repeated = this.pairingIdempotency(namespace, input.idempotencyKey, input.requestHash);
      if (repeated) return { requestId: String(repeated.resource_id), reused: true };
      const draft = this.managementDraft(input.draftId, input.tenantId);
      if (!draft) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
      if (draft.state === "WAITING_AGENT" && draft.request_id) {
        throw new Error("MANAGEMENT_DRAFT_ALREADY_SIGNED");
      }
      const requestId = "req_" + randomUUID();
      this.db.prepare(
        "INSERT INTO agent_requests(request_id,tenant_id,agent_did,request_type,payload_json,state,expires_at,created_at) VALUES(?,?,?,?,?,'PENDING',?,?)",
      ).run(requestId, input.tenantId, input.agentDid, "management-signature", JSON.stringify(input.payload), input.expiresAt, Date.now());
      this.db.prepare(`UPDATE management_drafts SET state='WAITING_AGENT',request_id=?,updated_at=?
        WHERE draft_id=? AND tenant_id=?`).run(requestId, Date.now(), input.draftId, input.tenantId);
      this.recordPairingIdempotency(namespace, input.idempotencyKey, input.requestHash, requestId);
      return { requestId, reused: false };
    });
  }

  endBinding(bindingId: string, tenantId: string): StoreRow {
    return this.transaction(() => {
      const binding = this.bindingById(bindingId, tenantId);
      if (!binding) throw new Error("PAIRING_BINDING_NOT_FOUND");
      const relationship = this.managementProjection(String(binding.agent_did), true);
      if (relationship && relationship.status === "active" && Number(relationship.expires_at) > Math.floor(Date.now() / 1000)) {
        throw new Error("ACTIVE_MANAGEMENT_RELATIONSHIP");
      }
      const now = Date.now();
      this.db.prepare("UPDATE agent_bindings SET state='ENDED',ended_at=? WHERE binding_id=?").run(now, bindingId);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE kind='agent' AND subject=? AND revoked_at IS NULL")
        .run(now, String(binding.agent_did));
      this.appendAudit(tenantId, "PAIRING_ENDED", String(binding.agent_did), "platform", { bindingId });
      return { ...binding, state: "ENDED", ended_at: now };
    });
  }

  managementProjection(agentDid: string, confirmedOnly = true): StoreRow | undefined {
    return this.db.prepare(
      `SELECT * FROM ${confirmedOnly ? "management_projection_history" : "management_projection"}
       WHERE agent_did=? ${confirmedOnly ? "AND confirmed=1 ORDER BY block_number DESC,log_index DESC LIMIT 1" : ""}`,
    ).get(agentDid) as StoreRow | undefined;
  }

  operationsForTenant(tenantId: string, limit = 100): OperationView[] {
    const rows = this.db.prepare("SELECT * FROM operations WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(500, limit))) as StoreRow[];
    return rows.map(operationView);
  }

  operationDetailsForTenant(tenantId: string, limit = 100): StoreRow[] {
    return this.db.prepare(
      "SELECT o.*,i.domain_json,i.types_json,i.message_json FROM operations o JOIN intents i ON i.intent_id=o.intent_id WHERE o.tenant_id=? ORDER BY o.created_at DESC LIMIT ?",
    ).all(tenantId, Math.max(1, Math.min(500, limit))) as StoreRow[];
  }

  eventsForSubject(subject: string, limit = 200): StoreRow[] {
    return this.db.prepare("SELECT * FROM events WHERE subject=? ORDER BY block_number DESC,log_index DESC LIMIT ?")
      .all(subject, Math.max(1, Math.min(1000, limit))) as StoreRow[];
  }

  requestsForTenant(tenantId: string, agentDid: string, limit = 100): StoreRow[] {
    return this.db.prepare("SELECT * FROM agent_requests WHERE tenant_id=? AND agent_did=? ORDER BY created_at DESC LIMIT ?")
      .all(tenantId, agentDid, Math.max(1, Math.min(500, limit))) as StoreRow[];
  }

  appendAudit(tenantId: string, eventType: string, subject: string, authority: string, payload: unknown): void {
    this.db.prepare(
      "INSERT INTO audit_log(tenant_id,event_type,subject,authority,payload_json,occurred_at) VALUES(?,?,?,?,?,?)",
    ).run(tenantId, eventType, subject, authority, JSON.stringify(payload), Date.now());
  }

  auditForTenant(tenantId: string, limit = 500): StoreRow[] {
    return this.db.prepare("SELECT * FROM audit_log WHERE tenant_id=? ORDER BY event_sequence DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(2000, limit))) as StoreRow[];
  }

  saveIntent(intent: ActionIntent, tenantId: string, subject: string, content?: unknown): void {
    this.db.prepare(
      "INSERT INTO intents(intent_id,tenant_id,subject,action_type,digest,domain_json,types_json,message_json,content_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      intent.intentId,
      tenantId,
      subject,
      intent.actionType,
      intent.digest,
      JSON.stringify(intent.domain),
      JSON.stringify(intent.types),
      JSON.stringify(intent.message),
      content === undefined ? null : JSON.stringify(content),
      Date.parse(intent.expiresAt),
      Date.now(),
    );
  }

  intent(intentId: string): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM intents WHERE intent_id=?").get(intentId) as StoreRow | undefined;
  }

  createOperation(input: {
    tenantId: string;
    intentId: string;
    actionType: string;
    digest: string;
    idempotencyKey: string;
    signatures: unknown;
    entryPoint: string;
    smartAccount: string;
    requiredConfirmations: number;
  }): OperationView {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT digest,operation_id FROM idempotency WHERE tenant_id=? AND key=?")
        .get(input.tenantId, input.idempotencyKey) as StoreRow | undefined;
      if (existing) {
        if (existing.digest !== input.digest) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return this.operation(String(existing.operation_id))!;
      }
      const operationId = "op_" + randomUUID();
      const now = Date.now();
      this.db.prepare(
        "INSERT INTO operations(operation_id,tenant_id,intent_id,action_type,digest,state,signatures_json,entry_point,smart_account,confirmations,required_confirmations,created_at,updated_at) VALUES(?,?,?,?,?,'SIGNED',?,?,?,?,?,?,?)",
      ).run(
        operationId,
        input.tenantId,
        input.intentId,
        input.actionType,
        input.digest,
        JSON.stringify(input.signatures),
        input.entryPoint,
        input.smartAccount,
        0,
        input.requiredConfirmations,
        now,
        now,
      );
      this.db.prepare("INSERT INTO idempotency(tenant_id,key,digest,operation_id,created_at) VALUES(?,?,?,?,?)")
        .run(input.tenantId, input.idempotencyKey, input.digest, operationId, now);
      this.appendAudit(input.tenantId, "OPERATION_SIGNED", input.digest, "agent-did-protocol", {
        operationId, actionType: input.actionType, digest: input.digest,
      });
      return this.operation(operationId)!;
    });
  }

  operation(id: string): OperationView | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(id) as StoreRow | undefined;
    return row ? operationView(row) : undefined;
  }

  nextOperation(states: OperationState[]): StoreRow | undefined {
    const placeholders = states.map(() => "?").join(",");
    return this.db.prepare(
      "SELECT o.*,i.domain_json,i.types_json,i.message_json,i.content_json FROM operations o JOIN intents i ON i.intent_id=o.intent_id WHERE o.state IN (" +
        placeholders + ") ORDER BY o.created_at LIMIT 1",
    ).get(...states) as StoreRow | undefined;
  }

  transitionOperation(
    id: string,
    next: OperationState,
    patch: Record<string, SqlValue | undefined> = {},
  ): OperationView {
    return this.transaction(() => {
      const current = this.operation(id);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      if (current.state !== next) assertOperationTransition(current.state, next);
      const allowed = new Set([
        "user_op_hash", "bundler_state", "tx_hash", "block_number", "block_hash", "confirmations",
        "finality_source", "actual_gas_used", "actual_gas_cost", "resulting_revision", "error_code", "error_message",
        "user_op_json",
      ]);
      const entries = Object.entries(patch).filter(([key, value]) => allowed.has(key) && value !== undefined);
      const assignments = ["state=?", "updated_at=?", ...entries.map(([key]) => key + "=?")];
      this.db.prepare("UPDATE operations SET " + assignments.join(",") + " WHERE operation_id=?")
        .run(next, Date.now(), ...entries.map(([, value]) => value!), id);
      if (next === "CONFIRMED") {
        this.db.prepare(`UPDATE management_drafts SET state='CONFIRMED',updated_at=?
          WHERE intent_id=(SELECT intent_id FROM operations WHERE operation_id=?)`).run(Date.now(), id);
        this.restorePairingDraftAfterRegistration(id);
      } else if (next === "REORGED") {
        this.db.prepare(`UPDATE management_drafts SET state='SUBMITTED',updated_at=?
          WHERE intent_id=(SELECT intent_id FROM operations WHERE operation_id=?) AND state='CONFIRMED'`).run(Date.now(), id);
        this.freezePairingDraftAfterRegistrationReorg(id);
      }
      this.appendAudit(current.tenantId, "OPERATION_" + next, current.digest, "erc-4337-v0.7", {
        operationId: id,
        state: next,
        ...(patch.user_op_hash ? { userOpHash: patch.user_op_hash } : {}),
        ...(patch.tx_hash ? { txHash: patch.tx_hash } : {}),
        ...(patch.block_number !== undefined ? { blockNumber: patch.block_number } : {}),
      });
      return this.operation(id)!;
    });
  }

  saveBlock(block: { number: number; hash: string; parentHash: string; canonical: boolean }): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO blocks(block_number,block_hash,parent_hash,canonical,indexed_at) VALUES(?,?,?,?,?)",
    ).run(block.number, block.hash, block.parentHash, block.canonical ? 1 : 0, Date.now());
  }

  block(number: number): StoreRow | undefined {
    return this.db.prepare("SELECT * FROM blocks WHERE block_number=? AND canonical=1").get(number) as StoreRow | undefined;
  }

  latestStoredBlockNumber(): number | undefined {
    const row = this.db.prepare("SELECT MAX(block_number) AS number FROM blocks WHERE canonical=1").get() as StoreRow;
    return row.number === null || row.number === undefined ? undefined : Number(row.number);
  }

  rollbackAfter(ancestor: number): string[] {
    return this.transaction(() => {
      const confirmedHeight = this.db.prepare(`
        SELECT MAX(block_number) AS height FROM (
          SELECT block_number FROM identity_projection_history WHERE confirmed=1 AND block_number<=?
          UNION ALL
          SELECT block_number FROM management_projection_history WHERE confirmed=1 AND block_number<=?
        )
      `).get(ancestor, ancestor) as StoreRow;
      const affected = this.db.prepare(
        "SELECT operation_id,tenant_id,digest FROM operations WHERE block_number>? AND state IN ('INCLUDED','CONFIRMED')",
      ).all(ancestor) as StoreRow[];
      this.db.prepare(
        "UPDATE operations SET state='REORGED',confirmations=0,bundler_state='dropped',user_op_hash=NULL,user_op_json=NULL,tx_hash=NULL,block_number=NULL,block_hash=NULL,finality_source=NULL,actual_gas_used=NULL,actual_gas_cost=NULL,resulting_revision=NULL,updated_at=? WHERE block_number>? AND state IN ('INCLUDED','CONFIRMED')",
      ).run(Date.now(), ancestor);
      this.db.prepare("DELETE FROM events WHERE block_number>?").run(ancestor);
      this.db.prepare("DELETE FROM blocks WHERE block_number>?").run(ancestor);
      this.rebuildProjections();
      if (confirmedHeight.height !== null && confirmedHeight.height !== undefined) {
        this.confirmProjections(Number(confirmedHeight.height) + this.requiredConfirmations - 1, this.requiredConfirmations);
      }
      for (const row of affected) {
        this.db.prepare(`UPDATE management_drafts SET state='SUBMITTED',updated_at=?
          WHERE intent_id=(SELECT intent_id FROM operations WHERE operation_id=?) AND state='CONFIRMED'`)
          .run(Date.now(), String(row.operation_id));
        this.freezePairingDraftAfterRegistrationReorg(String(row.operation_id));
        this.appendAudit(String(row.tenant_id), "OPERATION_REORGED", String(row.digest), "indexer", {
          operationId: row.operation_id, commonAncestor: ancestor,
        });
      }
      return affected.map((row) => String(row.operation_id));
    });
  }

  saveIndexedEvent(input: {
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
    contractAddress: string;
    eventName: string;
    subject: string;
    revision: number;
    payload: unknown;
  }): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO events(block_number,block_hash,tx_hash,log_index,contract_address,event_name,subject,revision,payload_json) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      input.blockNumber, input.blockHash, input.txHash, input.logIndex, input.contractAddress,
      input.eventName, input.subject, input.revision, JSON.stringify(input.payload),
    );
  }

  identityProjection(did: string, confirmedOnly = true): StoreRow | undefined {
    return this.db.prepare(
      `SELECT * FROM ${confirmedOnly ? "identity_projection_history" : "identity_projection"}
       WHERE agent_did=? ${confirmedOnly ? "AND confirmed=1 ORDER BY block_number DESC,log_index DESC LIMIT 1" : ""}`,
    ).get(did) as StoreRow | undefined;
  }

  upsertIdentityProjection(input: {
    agentDid: string;
    identityAccount: string;
    status: string;
    revision: number;
    nonce: string;
    documentHash?: string;
    profileHash?: string;
    blockNumber: number;
    blockHash: string;
    confirmed: boolean;
    logIndex?: number;
  }): void {
    this.db.prepare(
      "INSERT INTO identity_projection(agent_did,identity_account,status,revision,nonce,document_hash,profile_hash,block_number,block_hash,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(agent_did) DO UPDATE SET status=excluded.status,revision=excluded.revision,nonce=excluded.nonce,document_hash=COALESCE(excluded.document_hash,identity_projection.document_hash),profile_hash=COALESCE(excluded.profile_hash,identity_projection.profile_hash),block_number=excluded.block_number,block_hash=excluded.block_hash,confirmed=excluded.confirmed",
    ).run(
      input.agentDid, input.identityAccount, input.status, input.revision, input.nonce,
      input.documentHash ?? null, input.profileHash ?? null, input.blockNumber, input.blockHash, input.confirmed ? 1 : 0,
    );
    this.db.prepare(
      `INSERT OR REPLACE INTO identity_projection_history
       (agent_did,identity_account,status,revision,nonce,document_hash,profile_hash,block_number,block_hash,confirmed,log_index)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.agentDid, input.identityAccount, input.status, input.revision, input.nonce,
      input.documentHash ?? null, input.profileHash ?? null, input.blockNumber, input.blockHash,
      input.confirmed ? 1 : 0, input.logIndex ?? 0);
  }

  confirmProjections(canonicalHead: number, requiredConfirmations: number): void {
    const maximumBlock = canonicalHead - requiredConfirmations + 1;
    if (maximumBlock < 0) return;
    this.db.prepare("UPDATE identity_projection SET confirmed=1 WHERE block_number<=?").run(maximumBlock);
    this.db.prepare("UPDATE management_projection SET confirmed=1 WHERE block_number<=?").run(maximumBlock);
    this.db.prepare("UPDATE identity_projection_history SET confirmed=1 WHERE block_number<=?").run(maximumBlock);
    this.db.prepare("UPDATE management_projection_history SET confirmed=1 WHERE block_number<=?").run(maximumBlock);
  }

  upsertManagementProjection(input: {
    agentDid: string;
    managerAccount: string;
    relationshipHash: string;
    scopesHash: string;
    expiresAt: number;
    discoverable: boolean;
    status: string;
    revision: number;
    nonce: string;
    blockNumber: number;
    blockHash: string;
    confirmed: boolean;
    logIndex?: number;
  }): void {
    this.db.prepare(
      "INSERT INTO management_projection(agent_did,manager_account,relationship_hash,scopes_hash,expires_at,discoverable,status,revision,nonce,block_number,block_hash,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(agent_did) DO UPDATE SET manager_account=excluded.manager_account,relationship_hash=excluded.relationship_hash,scopes_hash=excluded.scopes_hash,expires_at=excluded.expires_at,discoverable=excluded.discoverable,status=excluded.status,revision=excluded.revision,nonce=excluded.nonce,block_number=excluded.block_number,block_hash=excluded.block_hash,confirmed=excluded.confirmed",
    ).run(
      input.agentDid, input.managerAccount, input.relationshipHash, input.scopesHash, input.expiresAt,
      input.discoverable ? 1 : 0, input.status, input.revision, input.nonce, input.blockNumber,
      input.blockHash, input.confirmed ? 1 : 0,
    );
    this.db.prepare(
      `INSERT OR REPLACE INTO management_projection_history
       (agent_did,manager_account,relationship_hash,scopes_hash,expires_at,discoverable,status,revision,nonce,block_number,block_hash,confirmed,log_index)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.agentDid, input.managerAccount, input.relationshipHash, input.scopesHash, input.expiresAt,
      input.discoverable ? 1 : 0, input.status, input.revision, input.nonce, input.blockNumber,
      input.blockHash, input.confirmed ? 1 : 0, input.logIndex ?? 0);
  }

  private rebuildProjections(): void {
    this.db.exec("DELETE FROM identity_projection; DELETE FROM management_projection; DELETE FROM identity_projection_history; DELETE FROM management_projection_history;");
    const rows = this.db.prepare("SELECT * FROM events ORDER BY block_number,log_index").all() as StoreRow[];
    for (const row of rows) {
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      const name = String(row.event_name);
      const subject = String(row.subject);
      const did = `did:memo:agent:985:${subject.toLowerCase()}`;
      if (["AgentRegistered", "ProfileUpdated", "DocumentUpdated", "AgentStatusChanged", "SuccessorDeclared", "InstanceCredentialRevoked"].includes(name)) {
        const previous = this.identityProjection(did, false);
        const status = name === "AgentRegistered"
          ? "active"
          : name === "AgentStatusChanged"
            ? ["none", "active", "suspended", "revoked", "superseded"][Number(payload.status)] || "unknown"
            : name === "SuccessorDeclared"
              ? "superseded"
              : String(previous?.status || "active");
        this.upsertIdentityProjection({
          agentDid: did,
          identityAccount: subject,
          status,
          revision: Number(payload.revision),
          nonce: (BigInt(String(payload.nonce)) + 1n).toString(),
          documentHash: name === "AgentRegistered" || name === "DocumentUpdated"
            ? String(payload.documentHash)
            : previous?.document_hash ? String(previous.document_hash) : undefined,
          profileHash: name === "AgentRegistered" || name === "ProfileUpdated"
            ? String(payload.profileHash)
            : previous?.profile_hash ? String(previous.profile_hash) : undefined,
          blockNumber: Number(row.block_number),
          blockHash: String(row.block_hash),
          confirmed: false,
          logIndex: Number(row.log_index),
        });
        continue;
      }
      const previous = this.managementProjection(did, false);
      const transferred = name === "RelationshipTransferred";
      this.upsertManagementProjection({
        agentDid: did,
        managerAccount: String(transferred ? payload.newManager : payload.manager || previous?.manager_account),
        relationshipHash: String(transferred ? payload.newRelationshipIdHash : payload.relationshipIdHash || previous?.relationship_hash),
        scopesHash: String(payload.scopesHash || previous?.scopes_hash || "0x" + "00".repeat(32)),
        expiresAt: Number(payload.expiresAt || previous?.expires_at || 0),
        discoverable: payload.discoverable === undefined ? Boolean(previous?.discoverable) : Boolean(payload.discoverable),
        status: name === "RelationshipEnded" ? "ended" : "active",
        revision: Number(payload.revision),
        nonce: (BigInt(String(payload.nonce)) + 1n).toString(),
        blockNumber: Number(row.block_number),
        blockHash: String(row.block_hash),
        confirmed: false,
        logIndex: Number(row.log_index),
      });
    }
  }

  private pairingIdempotency(namespace: string, key: string, requestHash: string): StoreRow | undefined {
    const row = this.db.prepare("SELECT * FROM pairing_idempotency WHERE namespace=? AND key=?")
      .get(namespace, key) as StoreRow | undefined;
    if (row && row.request_hash !== requestHash) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return row;
  }

  private recordPairingIdempotency(namespace: string, key: string, requestHash: string, resourceId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO pairing_idempotency(namespace,key,request_hash,resource_id,created_at) VALUES(?,?,?,?,?)",
    ).run(namespace, key, requestHash, resourceId, Date.now());
  }

  private pairingCompletion(exchangeId: string): {
    exchange: StoreRow;
    binding: StoreRow;
    draft: StoreRow;
    reused: boolean;
  } {
    const exchange = this.pairingExchange(exchangeId);
    if (!exchange || exchange.state !== "PAIRED") throw new Error("PAIRING_NOT_COMPLETED");
    const binding = this.db.prepare("SELECT * FROM agent_bindings WHERE source_exchange_id=? AND state='ACTIVE'")
      .get(exchangeId) as StoreRow | undefined;
    if (!binding) throw new Error("PAIRING_BINDING_NOT_FOUND");
    const draft = this.db.prepare("SELECT * FROM management_drafts WHERE binding_id=? ORDER BY created_at DESC LIMIT 1")
      .get(String(binding.binding_id)) as StoreRow | undefined;
    if (!draft) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
    return { exchange, binding, draft, reused: true };
  }

  private createBindingAndDraft(
    exchange: StoreRow,
    input: {
      agentDid: string;
      tenantId: string;
      walletAccount: string;
      maxScopes: string[];
      maxTermSeconds: number;
      requestedScopes: string[];
      requestedTermSeconds: number;
      visibility: "private" | "public";
    },
  ): { exchange: StoreRow; binding: StoreRow; draft: StoreRow; reused: boolean } {
    const existing = this.db.prepare("SELECT * FROM agent_bindings WHERE agent_did=? AND state='ACTIVE'")
      .get(input.agentDid) as StoreRow | undefined;
    if (existing) {
      if (existing.tenant_id !== input.tenantId) throw new Error("PAIRING_CONFLICT");
      const existingDraft = this.db.prepare("SELECT * FROM management_drafts WHERE binding_id=? ORDER BY created_at DESC LIMIT 1")
        .get(String(existing.binding_id)) as StoreRow | undefined;
      if (!existingDraft) throw new Error("MANAGEMENT_DRAFT_NOT_FOUND");
      this.db.prepare("UPDATE pairing_exchanges SET state='PAIRED',paired_at=?,binding_id=?,management_draft_id=?,updated_at=? WHERE exchange_id=?")
        .run(Date.now(), String(existing.binding_id), String(existingDraft.draft_id), Date.now(), String(exchange.exchange_id));
      return { exchange: this.pairingExchange(String(exchange.exchange_id))!, binding: existing, draft: existingDraft, reused: true };
    }
    const now = Date.now();
    const bindingId = "bind_" + randomUUID();
    const draftId = "mdr_" + randomUUID();
    const relationshipId = "rel_" + randomUUID();
    this.db.prepare(`INSERT INTO agent_bindings(
      binding_id,agent_did,tenant_id,wallet_account,source_exchange_id,max_scopes_json,max_term_seconds,state,created_at
    ) VALUES(?,?,?,?,?,?,?,'ACTIVE',?)`).run(
      bindingId,
      input.agentDid,
      input.tenantId,
      input.walletAccount,
      String(exchange.exchange_id),
      JSON.stringify(input.maxScopes),
      input.maxTermSeconds,
      now,
    );
    this.db.prepare(`INSERT INTO management_drafts(
      draft_id,binding_id,tenant_id,agent_did,manager_account,relationship_id,scopes_json,term_seconds,
      visibility,state,expires_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'AWAITING_WALLET_SIGNATURE',?,?,?)`).run(
      draftId,
      bindingId,
      input.tenantId,
      input.agentDid,
      input.walletAccount,
      relationshipId,
      JSON.stringify(input.requestedScopes),
      input.requestedTermSeconds,
      input.visibility,
      now + 30 * 60_000,
      now,
      now,
    );
    this.db.prepare("UPDATE pairing_exchanges SET state='PAIRED',paired_at=?,binding_id=?,management_draft_id=?,updated_at=? WHERE exchange_id=?")
      .run(now, bindingId, draftId, now, String(exchange.exchange_id));
    this.db.prepare("UPDATE sessions SET tenant_id=? WHERE kind='agent' AND subject=? AND revoked_at IS NULL")
      .run(input.tenantId, input.agentDid);
    this.db.prepare("UPDATE idempotency SET tenant_id=? WHERE operation_id IN (SELECT o.operation_id FROM operations o JOIN intents i ON i.intent_id=o.intent_id WHERE i.subject=?)")
      .run(input.tenantId, input.agentDid);
    this.db.prepare("UPDATE operations SET tenant_id=? WHERE intent_id IN (SELECT intent_id FROM intents WHERE subject=?)")
      .run(input.tenantId, input.agentDid);
    this.db.prepare("UPDATE intents SET tenant_id=? WHERE subject=?").run(input.tenantId, input.agentDid);
    this.appendAudit(input.tenantId, "PAIRING_COMPLETED", input.agentDid, "platform", {
      exchangeId: exchange.exchange_id,
      bindingId,
      draftId,
      kind: exchange.kind,
      walletAccount: input.walletAccount,
      maxScopes: input.maxScopes,
      maxTermSeconds: input.maxTermSeconds,
    });
    return {
      exchange: this.pairingExchange(String(exchange.exchange_id))!,
      binding: this.bindingById(bindingId, input.tenantId)!,
      draft: this.managementDraft(draftId, input.tenantId)!,
      reused: false,
    };
  }

  private registrationDidForOperation(operationId: string): string | undefined {
    const row = this.db.prepare(`SELECT i.message_json FROM operations o
      JOIN intents i ON i.intent_id=o.intent_id
      WHERE o.operation_id=? AND o.action_type='RegisterAgent'`).get(operationId) as StoreRow | undefined;
    if (!row) return undefined;
    const message = JSON.parse(String(row.message_json)) as { identityAccount?: unknown };
    const account = String(message.identityAccount || "").toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(account) ? "did:memo:agent:985:" + account : undefined;
  }

  private freezePairingDraftAfterRegistrationReorg(operationId: string): void {
    const agentDid = this.registrationDidForOperation(operationId);
    if (!agentDid) return;
    this.db.prepare(`UPDATE management_drafts
      SET reorg_previous_state=state,state='FROZEN_REORG',updated_at=?
      WHERE agent_did=? AND state IN ('AWAITING_WALLET_SIGNATURE','WAITING_AGENT','SUBMITTED')`)
      .run(Date.now(), agentDid);
  }

  private restorePairingDraftAfterRegistration(operationId: string): void {
    const agentDid = this.registrationDidForOperation(operationId);
    if (!agentDid) return;
    this.db.prepare(`UPDATE management_drafts
      SET state=COALESCE(reorg_previous_state,'AWAITING_WALLET_SIGNATURE'),reorg_previous_state=NULL,updated_at=?
      WHERE agent_did=? AND state='FROZEN_REORG'`)
      .run(Date.now(), agentDid);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
      );
    `);
    const bindingTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_bindings'")
      .get() as StoreRow | undefined;
    const bindingColumns = bindingTable
      ? new Set((this.db.prepare("PRAGMA table_info(agent_bindings)").all() as StoreRow[]).map((row) => String(row.name)))
      : new Set<string>();
    if (bindingTable && !bindingColumns.has("binding_id")) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE agent_bindings RENAME TO agent_bindings_v1_legacy");
        this.createBindingTable();
        const rows = this.db.prepare("SELECT * FROM agent_bindings_v1_legacy").all() as StoreRow[];
        for (const row of rows) {
          this.db.prepare(`INSERT INTO agent_bindings(
            binding_id,agent_did,tenant_id,wallet_account,source_exchange_id,max_scopes_json,
            max_term_seconds,state,created_at
          ) VALUES(?,?,?,?,NULL,?,?,'ACTIVE',?)`).run(
            "bind_" + randomUUID(),
            String(row.agent_did),
            String(row.tenant_id),
            String(row.wallet_account),
            String(row.max_scopes_json || "[]"),
            Number(row.max_term_seconds || 365 * 24 * 60 * 60),
            Number(row.created_at || Date.now()),
          );
        }
      });
    } else {
      this.createBindingTable();
    }
    const oldPairing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pairing_grants'")
      .get() as StoreRow | undefined;
    const legacyPairing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pairing_grants_v1_legacy'")
      .get() as StoreRow | undefined;
    if (oldPairing && !legacyPairing) this.db.exec("ALTER TABLE pairing_grants RENAME TO pairing_grants_v1_legacy");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenges(
        challenge_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, nonce_hash TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions(
        session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, tenant_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(kind,subject,tenant_id);
      CREATE TABLE IF NOT EXISTS agent_requests(
        request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_did TEXT NOT NULL, request_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, state TEXT NOT NULL, decision_json TEXT, expires_at INTEGER NOT NULL,
        decided_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_agent_requests ON agent_requests(tenant_id,agent_did,state,created_at);
      CREATE TABLE IF NOT EXISTS pairing_exchanges(
        exchange_id TEXT PRIMARY KEY, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, platform_origin TEXT NOT NULL,
        creator_tenant_id TEXT NOT NULL, creator_subject TEXT NOT NULL, agent_did TEXT, manager_account TEXT,
        max_scopes_json TEXT NOT NULL, max_term_seconds INTEGER NOT NULL,
        requested_scopes_json TEXT NOT NULL, requested_term_seconds INTEGER NOT NULL, visibility TEXT NOT NULL,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL, completion_deadline INTEGER,
        claimed_at INTEGER, paired_at INTEGER, cancelled_at INTEGER, failure_code TEXT,
        binding_id TEXT, management_draft_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pairing_exchange_agent ON pairing_exchanges(agent_did,created_at);
      CREATE INDEX IF NOT EXISTS pairing_exchange_creator ON pairing_exchanges(creator_tenant_id,created_at);
      CREATE TABLE IF NOT EXISTS pairing_idempotency(
        namespace TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(namespace,key)
      );
      CREATE TABLE IF NOT EXISTS management_drafts(
        draft_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES agent_bindings(binding_id),
        tenant_id TEXT NOT NULL, agent_did TEXT NOT NULL, manager_account TEXT NOT NULL,
        relationship_id TEXT NOT NULL, scopes_json TEXT NOT NULL, term_seconds INTEGER NOT NULL,
        visibility TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL,
        intent_id TEXT, request_id TEXT, reorg_previous_state TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS management_draft_agent ON management_drafts(tenant_id,agent_did,created_at);
      CREATE TABLE IF NOT EXISTS intents(
        intent_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL, action_type TEXT NOT NULL,
        digest TEXT NOT NULL UNIQUE, domain_json TEXT NOT NULL, types_json TEXT NOT NULL, message_json TEXT NOT NULL,
        content_json TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL REFERENCES intents(intent_id),
        action_type TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, signatures_json TEXT NOT NULL,
        user_op_hash TEXT, user_op_json TEXT, bundler_state TEXT, entry_point TEXT NOT NULL, smart_account TEXT NOT NULL,
        tx_hash TEXT, block_number INTEGER, block_hash TEXT, confirmations INTEGER NOT NULL DEFAULT 0,
        required_confirmations INTEGER NOT NULL, finality_source TEXT, actual_gas_used TEXT, actual_gas_cost TEXT,
        resulting_revision INTEGER, error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_state ON operations(state,created_at);
      CREATE TABLE IF NOT EXISTS idempotency(
        tenant_id TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        created_at INTEGER NOT NULL, PRIMARY KEY(tenant_id,key)
      );
      CREATE TABLE IF NOT EXISTS blocks(
        block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL UNIQUE, parent_hash TEXT NOT NULL,
        canonical INTEGER NOT NULL, indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        contract_address TEXT NOT NULL, event_name TEXT NOT NULL, subject TEXT NOT NULL, revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL, PRIMARY KEY(tx_hash,log_index)
      );
      CREATE TABLE IF NOT EXISTS identity_projection(
        agent_did TEXT PRIMARY KEY, identity_account TEXT NOT NULL UNIQUE, status TEXT NOT NULL, revision INTEGER NOT NULL,
        nonce TEXT NOT NULL, document_hash TEXT, profile_hash TEXT, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        confirmed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS management_projection(
        agent_did TEXT PRIMARY KEY, manager_account TEXT NOT NULL, relationship_hash TEXT NOT NULL, scopes_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, discoverable INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        nonce TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, confirmed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_projection_history(
        agent_did TEXT NOT NULL, identity_account TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        nonce TEXT NOT NULL, document_hash TEXT, profile_hash TEXT, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        confirmed INTEGER NOT NULL, log_index INTEGER NOT NULL,
        PRIMARY KEY(agent_did,block_number,log_index)
      );
      CREATE INDEX IF NOT EXISTS identity_projection_history_confirmed
        ON identity_projection_history(agent_did,confirmed,block_number DESC,log_index DESC);
      CREATE TABLE IF NOT EXISTS management_projection_history(
        agent_did TEXT NOT NULL, manager_account TEXT NOT NULL, relationship_hash TEXT NOT NULL, scopes_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL, discoverable INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        nonce TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, confirmed INTEGER NOT NULL,
        log_index INTEGER NOT NULL, PRIMARY KEY(agent_did,block_number,log_index)
      );
      CREATE INDEX IF NOT EXISTS management_projection_history_confirmed
        ON management_projection_history(agent_did,confirmed,block_number DESC,log_index DESC);
      CREATE TABLE IF NOT EXISTS audit_log(
        event_sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL,
        subject TEXT NOT NULL, authority TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_tenant_sequence ON audit_log(tenant_id,event_sequence);
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(2,'pairing-v2',?)")
      .run(Date.now());
    const draftColumns = new Set(
      (this.db.prepare("PRAGMA table_info(management_drafts)").all() as StoreRow[]).map((row) => String(row.name)),
    );
    if (!draftColumns.has("reorg_previous_state")) {
      this.db.exec("ALTER TABLE management_drafts ADD COLUMN reorg_previous_state TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(3,'pairing-registration-reorg-freeze',?)")
      .run(Date.now());
    const historyMigration = this.db.prepare("SELECT version FROM schema_migrations WHERE version=4").get();
    if (!historyMigration) {
      this.transaction(() => {
        this.rebuildProjections();
        this.confirmProjections(this.latestStoredBlockNumber() ?? -1, this.requiredConfirmations);
        this.db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(4,'confirmed-projection-history',?)")
          .run(Date.now());
      });
    }
  }

  private createBindingTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_bindings(
        binding_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, tenant_id TEXT NOT NULL, wallet_account TEXT NOT NULL,
        source_exchange_id TEXT, max_scopes_json TEXT NOT NULL, max_term_seconds INTEGER NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_binding_per_agent
        ON agent_bindings(agent_did) WHERE state='ACTIVE';
      CREATE INDEX IF NOT EXISTS active_bindings_by_tenant
        ON agent_bindings(tenant_id,created_at) WHERE state='ACTIVE';
    `);
  }
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function operationView(row: StoreRow): OperationView {
  return {
    operationId: String(row.operation_id),
    tenantId: String(row.tenant_id),
    actionType: String(row.action_type) as OperationView["actionType"],
    digest: String(row.digest),
    state: String(row.state) as OperationState,
    ...(row.user_op_hash ? { userOpHash: String(row.user_op_hash) } : {}),
    entryPoint: String(row.entry_point),
    relayerSmartAccount: String(row.smart_account),
    ...(row.bundler_state ? { bundlerState: String(row.bundler_state) as OperationView["bundlerState"] } : {}),
    ...(row.tx_hash ? { txHash: String(row.tx_hash) } : {}),
    ...(row.block_number !== null && row.block_number !== undefined ? { blockNumber: Number(row.block_number) } : {}),
    ...(row.block_hash ? { blockHash: String(row.block_hash) } : {}),
    confirmations: Number(row.confirmations),
    requiredConfirmations: Number(row.required_confirmations),
    ...(row.finality_source ? { finalitySource: String(row.finality_source) as OperationView["finalitySource"] } : {}),
    ...(row.actual_gas_used ? { actualGasUsed: String(row.actual_gas_used) } : {}),
    ...(row.actual_gas_cost ? { actualGasCost: String(row.actual_gas_cost) } : {}),
    ...(row.resulting_revision !== null && row.resulting_revision !== undefined
      ? { resultingRevision: Number(row.resulting_revision) }
      : {}),
    ...(row.error_code ? { errorCode: String(row.error_code), errorMessage: String(row.error_message || "") } : {}),
  };
}
