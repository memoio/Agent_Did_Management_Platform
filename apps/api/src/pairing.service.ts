import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { getAddress } from "ethers";
import {
  CHAIN_ID,
  PAIRING_PACKAGE_SCHEMA,
  type PairingExchangeView,
} from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";
import { ChainStore, type StoreRow } from "./store.service.js";
import type { Principal } from "./session.service.js";

const EXCHANGE_ID = /^(pinv|poff)_[A-Za-z0-9_-]{12,100}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const HANDLE = /^memo-pair-v2\.((?:pinv|poff)_[A-Za-z0-9_-]{12,100})\.([A-Za-z0-9_-]{40,})$/;
const SCOPE = /^[a-z][a-z0-9_.:-]{1,63}$/;
const MAX_TERM_SECONDS = 365 * 24 * 60 * 60;

@Injectable()
export class PairingService {
  constructor(
    private readonly store: ChainStore,
    private readonly config: RuntimeConfigService,
  ) {}

  createInvitation(principal: Principal, input: Record<string, unknown>, idempotencyKey: string) {
    this.requireKind(principal, "wallet");
    exact(input, ["exchangeId", "tokenHash", "platformOrigin", "requestedScopes", "requestedTermSeconds", "visibility", "ttlSeconds"]);
    const exchangeId = invitationId(input.exchangeId);
    const requestedScopes = scopes(input.requestedScopes, "requestedScopes");
    const requestedTermSeconds = term(input.requestedTermSeconds, "requestedTermSeconds");
    const row = this.store.createPairingExchange({
      exchangeId,
      kind: "platform-invitation",
      tokenHash: hashValue(input.tokenHash),
      platformOrigin: this.platformOrigin(input.platformOrigin),
      creatorTenantId: principal.tenantId,
      creatorSubject: getAddress(principal.subject),
      managerAccount: getAddress(principal.subject),
      maxScopes: requestedScopes,
      maxTermSeconds: requestedTermSeconds,
      requestedScopes,
      requestedTermSeconds,
      visibility: visibilityValue(input.visibility),
      expiresAt: Date.now() + ttl(input.ttlSeconds) * 1000,
      idempotencyNamespace: "wallet:" + principal.subject.toLowerCase() + ":invitation-create",
      idempotencyKey: requiredKey(idempotencyKey),
      requestHash: requestHash(input),
    });
    return this.exchangeView(row);
  }

  inspectInvitation(principal: Principal, input: Record<string, unknown>) {
    this.requireKind(principal, "agent");
    exact(input, ["exchangeId", "handle"]);
    return this.exchangeView(this.inspect("platform-invitation", input.exchangeId, input.handle));
  }

  claimInvitation(principal: Principal, exchangeIdValue: string, input: Record<string, unknown>, idempotencyKey: string) {
    this.requireKind(principal, "agent");
    exact(input, ["handle"]);
    const exchangeId = invitationId(exchangeIdValue);
    const handle = handleValue(input.handle, exchangeId);
    const row = this.store.claimInvitation({
      exchangeId,
      tokenHash: sha256(handle),
      agentDid: principal.subject,
      idempotencyNamespace: "agent:" + principal.subject + ":invitation-claim",
      idempotencyKey: requiredKey(idempotencyKey),
      requestHash: requestHash({ exchangeId, handleHash: sha256(handle), agentDid: principal.subject }),
    });
    return this.exchangeView(row);
  }

  completeInvitation(principal: Principal, exchangeIdValue: string, idempotencyKey: string) {
    this.requireKind(principal, "agent");
    const exchangeId = invitationId(exchangeIdValue);
    const identity = this.store.identityProjection(principal.subject, true);
    if (!identity || identity.status !== "active") throw new Error("IDENTITY_NOT_ACTIVE_OR_CONFIRMED");
    const result = this.store.completeInvitation({
      exchangeId,
      agentDid: principal.subject,
      idempotencyNamespace: "agent:" + principal.subject + ":invitation-complete",
      idempotencyKey: requiredKey(idempotencyKey),
      requestHash: requestHash({ exchangeId, agentDid: principal.subject }),
    });
    return completionView(result, this.exchangeView(result.exchange));
  }

  createOffer(principal: Principal, input: Record<string, unknown>, idempotencyKey: string) {
    this.requireKind(principal, "agent");
    exact(input, ["exchangeId", "tokenHash", "platformOrigin", "maxScopes", "maxTermSeconds", "ttlSeconds"]);
    const identity = this.store.identityProjection(principal.subject, true);
    if (!identity || identity.status !== "active") throw new Error("IDENTITY_NOT_ACTIVE_OR_CONFIRMED");
    const exchangeId = offerId(input.exchangeId);
    const row = this.store.createPairingExchange({
      exchangeId,
      kind: "agent-offer",
      tokenHash: hashValue(input.tokenHash),
      platformOrigin: this.platformOrigin(input.platformOrigin),
      creatorTenantId: principal.tenantId,
      creatorSubject: principal.subject,
      agentDid: principal.subject,
      maxScopes: scopes(input.maxScopes, "maxScopes"),
      maxTermSeconds: term(input.maxTermSeconds, "maxTermSeconds"),
      requestedScopes: [],
      requestedTermSeconds: 0,
      visibility: "private",
      expiresAt: Date.now() + ttl(input.ttlSeconds) * 1000,
      idempotencyNamespace: "agent:" + principal.subject + ":offer-create",
      idempotencyKey: requiredKey(idempotencyKey),
      requestHash: requestHash(input),
    });
    return this.exchangeView(row);
  }

  inspectOffer(principal: Principal, input: Record<string, unknown>) {
    this.requireKind(principal, "wallet");
    exact(input, ["exchangeId", "handle"]);
    return this.exchangeView(this.inspect("agent-offer", input.exchangeId, input.handle));
  }

  redeemOffer(principal: Principal, exchangeIdValue: string, input: Record<string, unknown>, idempotencyKey: string) {
    this.requireKind(principal, "wallet");
    exact(input, ["handle", "requestedScopes", "requestedTermSeconds", "visibility"]);
    const exchangeId = offerId(exchangeIdValue);
    const handle = handleValue(input.handle, exchangeId);
    const requestedScopes = scopes(input.requestedScopes, "requestedScopes");
    const requestedTermSeconds = term(input.requestedTermSeconds, "requestedTermSeconds");
    const visibility = visibilityValue(input.visibility);
    const row = this.store.pairingExchange(exchangeId);
    if (!row || !row.agent_did) throw new Error("PAIRING_INVALID_OR_EXPIRED");
    const identity = this.store.identityProjection(String(row.agent_did), true);
    if (!identity || identity.status !== "active") throw new Error("IDENTITY_NOT_ACTIVE_OR_CONFIRMED");
    const result = this.store.redeemOffer({
      exchangeId,
      tokenHash: sha256(handle),
      tenantId: principal.tenantId,
      walletAccount: getAddress(principal.subject),
      requestedScopes,
      requestedTermSeconds,
      visibility,
      idempotencyNamespace: "wallet:" + principal.subject.toLowerCase() + ":offer-redeem",
      idempotencyKey: requiredKey(idempotencyKey),
      requestHash: requestHash({ exchangeId, handleHash: sha256(handle), requestedScopes, requestedTermSeconds, visibility }),
    });
    return completionView(result, this.exchangeView(result.exchange));
  }

  status(principal: Principal, exchangeId: string) {
    const row = this.store.pairingExchange(exchangeIdValue(exchangeId));
    if (!row || !this.canAccess(principal, row)) throw new Error("PAIRING_NOT_FOUND");
    return this.exchangeView(row);
  }

  cancel(principal: Principal, exchangeId: string, idempotencyKey: string) {
    const normalized = exchangeIdValue(exchangeId);
    return this.exchangeView(this.store.cancelPairingExchange(
      normalized,
      principal.kind,
      principal.subject,
      requiredKey(idempotencyKey),
      requestHash({ exchangeId: normalized }),
    ));
  }

  listBindings(principal: Principal) {
    this.requireKind(principal, "wallet");
    return { bindings: this.store.agentBindingsForTenant(principal.tenantId).map(bindingView) };
  }

  endBinding(principal: Principal, bindingId: string) {
    this.requireKind(principal, "wallet");
    return bindingView(this.store.endBinding(bindingId, principal.tenantId));
  }

  private inspect(kind: "platform-invitation" | "agent-offer", exchangeIdRaw: unknown, handleRaw: unknown): StoreRow {
    const exchangeId = exchangeIdValue(exchangeIdRaw);
    const handle = handleValue(handleRaw, exchangeId);
    const row = this.store.pairingExchange(exchangeId);
    if (!row || row.kind !== kind || row.token_hash !== sha256(handle)) throw new Error("PAIRING_INVALID_OR_EXPIRED");
    if (["CANCELLED", "EXPIRED", "FAILED"].includes(String(row.state)) || Number(row.expires_at) <= Date.now()) {
      throw new Error("PAIRING_INVALID_OR_EXPIRED");
    }
    return row;
  }

  private exchangeView(row: StoreRow): PairingExchangeView & Record<string, unknown> {
    const state = Number(row.expires_at) <= Date.now() && !["PAIRED", "CANCELLED", "FAILED"].includes(String(row.state))
      ? "EXPIRED"
      : String(row.state);
    const manifest = this.config.value.manifest;
    const identity = row.agent_did ? this.store.identityProjection(String(row.agent_did), true) : undefined;
    return {
      schema: PAIRING_PACKAGE_SCHEMA,
      exchangeId: String(row.exchange_id),
      kind: String(row.kind) as PairingExchangeView["kind"],
      state: state as PairingExchangeView["state"],
      platformOrigin: String(row.platform_origin),
      environment: manifest.environment,
      chainId: CHAIN_ID,
      didRegistry: manifest.didRegistry.address,
      managementRegistry: manifest.managementRegistry.address,
      ...(row.agent_did ? { agentDid: String(row.agent_did) } : {}),
      ...(identity ? { identityAccount: String(identity.identity_account), profileHash: String(identity.profile_hash) } : {}),
      ...(row.manager_account ? { managerAccount: getAddress(String(row.manager_account)) } : {}),
      maxScopes: JSON.parse(String(row.max_scopes_json)) as string[],
      maxTermSeconds: Number(row.max_term_seconds),
      requestedScopes: JSON.parse(String(row.requested_scopes_json)) as string[],
      requestedTermSeconds: Number(row.requested_term_seconds),
      visibility: String(row.visibility) as "private" | "public",
      issuedAt: new Date(Number(row.created_at)).toISOString(),
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      ...(row.completion_deadline ? { completionDeadline: new Date(Number(row.completion_deadline)).toISOString() } : {}),
      ...(row.binding_id ? { bindingId: String(row.binding_id) } : {}),
      ...(row.management_draft_id ? { managementDraftId: String(row.management_draft_id) } : {}),
    };
  }

  private platformOrigin(value: unknown): string {
    const origin = stringValue(value, "platformOrigin");
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("INVALID_PLATFORM_ORIGIN"); }
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/") throw new Error("INVALID_PLATFORM_ORIGIN");
    if (this.config.value.environment === "local" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
    if (parsed.protocol !== "https:" || !this.config.value.platformOrigins.includes(origin)) throw new Error("PLATFORM_ORIGIN_FORBIDDEN");
    return origin;
  }

  private canAccess(principal: Principal, row: StoreRow): boolean {
    if (principal.kind === "wallet") return row.creator_tenant_id === principal.tenantId
      || Boolean(row.binding_id && this.store.bindingById(String(row.binding_id), principal.tenantId));
    return row.creator_subject === principal.subject || row.agent_did === principal.subject;
  }

  private requireKind(principal: Principal, kind: Principal["kind"]): void {
    if (principal.kind !== kind) throw new Error(kind === "agent" ? "AGENT_SESSION_REQUIRED" : "WALLET_SESSION_REQUIRED");
  }
}

function completionView(
  result: { binding: StoreRow; draft: StoreRow; reused: boolean },
  exchange: Record<string, unknown>,
): Record<string, unknown> {
  return { ...exchange, binding: bindingView(result.binding), managementDraft: draftView(result.draft), reused: result.reused };
}

export function bindingView(row: StoreRow): Record<string, unknown> {
  return {
    bindingId: String(row.binding_id),
    agentDid: String(row.agent_did),
    walletAccount: getAddress(String(row.wallet_account)),
    sourceExchangeId: row.source_exchange_id ? String(row.source_exchange_id) : null,
    maxScopes: JSON.parse(String(row.max_scopes_json)) as string[],
    maxTermSeconds: Number(row.max_term_seconds),
    state: String(row.state),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    ...(row.ended_at ? { endedAt: new Date(Number(row.ended_at)).toISOString() } : {}),
  };
}

export function draftView(row: StoreRow): Record<string, unknown> {
  const state = row.state === "AWAITING_WALLET_SIGNATURE" && Number(row.expires_at) <= Date.now()
    ? "EXPIRED"
    : String(row.state);
  return {
    draftId: String(row.draft_id),
    bindingId: String(row.binding_id),
    agentDid: String(row.agent_did),
    managerAccount: getAddress(String(row.manager_account)),
    relationshipId: String(row.relationship_id),
    managementScopes: JSON.parse(String(row.scopes_json)) as string[],
    relationshipTermSeconds: Number(row.term_seconds),
    visibility: String(row.visibility),
    state,
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    ...(row.intent_id ? { intentId: String(row.intent_id) } : {}),
    ...(row.request_id ? { requestId: String(row.request_id) } : {}),
  };
}

function exact(value: Record<string, unknown>, fields: string[]): void {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((field, index) => field !== actual[index])) {
    throw new Error("UNKNOWN_OR_MISSING_PAIRING_FIELD");
  }
}

function exchangeIdValue(value: unknown): string {
  const result = stringValue(value, "exchangeId");
  if (!EXCHANGE_ID.test(result)) throw new Error("INVALID_PAIRING_EXCHANGE_ID");
  return result;
}

function invitationId(value: unknown): string {
  const result = exchangeIdValue(value);
  if (!result.startsWith("pinv_")) throw new Error("INVALID_PAIRING_EXCHANGE_ID");
  return result;
}

function offerId(value: unknown): string {
  const result = exchangeIdValue(value);
  if (!result.startsWith("poff_")) throw new Error("INVALID_PAIRING_EXCHANGE_ID");
  return result;
}

function handleValue(value: unknown, exchangeId: string): string {
  const result = stringValue(value, "handle");
  const match = HANDLE.exec(result);
  if (!match || match[1] !== exchangeId) throw new Error("INVALID_PAIRING_HANDLE");
  return result;
}

function hashValue(value: unknown): string {
  const result = stringValue(value, "tokenHash").toLowerCase();
  if (!TOKEN_HASH.test(result)) throw new Error("INVALID_PAIRING_TOKEN_HASH");
  return result;
}

function scopes(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("INVALID_PAIRING_SCOPES");
  const result = [...new Set(value.map((item) => stringValue(item, name)).sort())];
  if (result.some((scope) => !SCOPE.test(scope))) throw new Error("INVALID_PAIRING_SCOPES");
  return result;
}

function term(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 60 || Number(value) > MAX_TERM_SECONDS) {
    throw new Error("INVALID_" + name.toUpperCase());
  }
  return Number(value);
}

function ttl(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 60 || Number(value) > 86_400) throw new Error("INVALID_PAIRING_TTL");
  return Number(value);
}

function visibilityValue(value: unknown): "private" | "public" {
  if (value !== "private" && value !== "public") throw new Error("INVALID_VISIBILITY");
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error("INVALID_" + name.toUpperCase());
  return value;
}

function requiredKey(value: string | undefined): string {
  if (!value || value.length < 8 || value.length > 200) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  return value;
}

function requestHash(value: unknown): string {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
