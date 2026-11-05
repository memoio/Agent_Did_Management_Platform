import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getAddress, keccak256, TypedDataEncoder, verifyTypedData } from "ethers";
import type { Config } from "./config.js";
import { CHAIN_ID } from "./config.js";
import { AgentError } from "./errors.js";
import { canonicalHash, canonicalize, sha256, assertExactFields } from "./canonical.js";
import { parseDuration } from "./duration.js";
import { authorize, hasLocalR4TestGrant } from "./policy.js";
import { ACTION_REGISTRY, LocalKmsSigner, TYPED_DOMAIN } from "./signer.js";
import { Store } from "./store.js";

type Row = Record<string, unknown>;

const DID_PATTERN = /^did:memo:agent:(\d+):(0x[0-9a-f]{40})$/;
const MANAGER_PATTERN = /^eip155:(\d+):(0x[0-9a-f]{40})$/;
const PAIRING_SCHEMA = "memo.agent-pairing-package/2";
const PAIRING_HANDLE = /^memo-pair-v2\.((?:pinv|poff)_[A-Za-z0-9_-]{12,100})\.([A-Za-z0-9_-]{40,})$/;
const INVITATION_FIELDS = [
  "schema", "kind", "exchangeId", "platformOrigin", "environment", "chainId", "didRegistry",
  "managementRegistry", "handle", "issuedAt", "expiresAt", "managerAccount", "requestedScopes",
  "requestedTermSeconds", "visibility",
] as const;
const OFFER_FIELDS = [
  "schema", "kind", "exchangeId", "platformOrigin", "environment", "chainId", "didRegistry",
  "managementRegistry", "handle", "issuedAt", "expiresAt", "agentDid", "identityAccount", "profileHash",
  "maxScopes", "maxTermSeconds",
] as const;

const MANAGEMENT_FIELDS = [
  "requestId", "relationshipId", "agentDid", "managerAccount", "managementScopes",
  "issuedAt", "expiresAt", "termEndsAt", "visibility", "requestVersion",
  "relationshipRevision", "source",
  "managerSignature",
] as const;

function managementProofPayload(request: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: request.requestId,
    relationshipId: request.relationshipId,
    agentDid: request.agentDid,
    managerAccount: request.managerAccount,
    scopesHash: canonicalHash(request.managementScopes),
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    termEndsAt: request.termEndsAt,
    visibility: request.visibility,
    requestVersion: request.requestVersion,
    relationshipRevision: request.relationshipRevision,
    source: request.source,
  };
}

function now(): number { return Math.floor(Date.now() / 1000); }
function pairingTokenHash(handle: string): string { return createHash("sha256").update(handle).digest("hex"); }
function asObject(value: unknown, name = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("INVALID_REQUEST", `${name} must be an object`);
  return value as Record<string, unknown>;
}
function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new AgentError("INVALID_REQUEST", `${name} must be a non-empty string`);
  return value;
}
function asInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AgentError("INVALID_REQUEST", `${name} must be a non-negative integer`);
  return Number(value);
}
function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new AgentError("INVALID_REQUEST", `${name} must be a non-empty string array`);
  }
  return [...new Set(value)].sort();
}
function publicInstallation(row: Row): Record<string, unknown> {
  return {
    installationId: row.installation_id,
    agentDid: row.agent_did,
    identityAccount: row.identity_account,
    publicKey: row.public_key,
    identityKeyHandle: row.identity_key_handle,
    identityRevision: row.last_identity_revision,
    state: row.state,
    registered: Number(row.last_identity_revision) > 0 && !["LOCAL_IDENTITY_READY", "REGISTRATION_SUBMITTED", "QUARANTINED"].includes(String(row.state)),
    keyProvider: row.key_provider,
    network: row.network,
    profileHash: row.profile_hash,
    registryAddress: row.registry_address,
    managementRegistryAddress: row.management_registry_address,
    apiUrl: row.api_url,
    defaultInstanceState: row.default_instance_state,
    deploymentEnvironment: row.deployment_environment,
  };
}

export class AgentDidService {
  readonly store: Store;
  readonly signer: LocalKmsSigner;
  private agentSessionToken?: string;

  constructor(readonly config: Config) {
    this.store = new Store(config.dbPath);
    this.signer = new LocalKmsSigner(config);
    this.retireV1PairingSecrets();
  }

  close(): void { this.store.close(); }

  private async rawApi(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const url = new URL(path, this.config.apiUrl);
    if (url.origin !== this.config.apiOrigin) throw new AgentError("API_ORIGIN_FORBIDDEN", "API request escaped the configured platform origin");
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
    const envelope = await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> } };
    if (!response.ok || !envelope.ok || !envelope.data) {
      throw new AgentError(envelope.error?.code || "PLATFORM_API_ERROR", envelope.error?.message || `Platform API failed with ${response.status}`, Boolean(envelope.error?.retryable), envelope.error?.details);
    }
    return envelope.data;
  }

  private async openAgentSession(): Promise<string> {
    const identity = this.installation()!;
    const challenge = await this.rawApi("/api/v1/agent-sessions/challenges", {
      method: "POST",
      body: JSON.stringify({ agentDid: identity.agent_did }),
    });
    const challengeId = asString(challenge.challengeId, "challengeId");
    const message = asString(challenge.message, "message");
    const signature = await this.signer.signSessionChallenge(
      String(identity.identity_key_handle),
      message,
      String(identity.agent_did),
      challengeId,
    );
    const session = await this.rawApi("/api/v1/agent-sessions", {
      method: "POST",
      body: JSON.stringify({ challengeId, signature }),
    });
    this.agentSessionToken = asString(session.token, "session token");
    return this.agentSessionToken;
  }

  private async api(path: string, init: RequestInit = {}, authenticated = true): Promise<Record<string, unknown>> {
    if (!authenticated) return this.rawApi(path, init);
    const token = this.agentSessionToken || await this.openAgentSession();
    return this.rawApi(path, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token}` },
    });
  }

  private async chainConfig(): Promise<Record<string, unknown>> {
    const config = await this.api("/api/v1/chain/config", {}, false);
    if (Number(config.chainId) !== this.config.expectedChainId) throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Platform chain does not match expected chain");
    if (config.environment !== this.config.deploymentEnvironment) throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Platform deployment environment does not match the Skill installation");
    const contracts = asObject(config.contracts, "contracts");
    for (const name of ["agentDidRegistry", "agentManagementRegistry"]) {
      const contract = asObject(contracts[name], name);
      if (!/^0x[0-9a-f]{40}$/i.test(String(contract.address)) || /^0x0{40}$/i.test(String(contract.address))) {
        throw new AgentError("INVALID_SIGNING_DOMAIN", `${name} address is invalid`);
      }
    }
    return config;
  }

  private async waitOperation(operationId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const operation = await this.api(`/api/v1/operations/${encodeURIComponent(operationId)}`);
      if (operation.state === "CONFIRMED") return operation;
      if (operation.state === "FAILED") throw new AgentError("CHAIN_OPERATION_FAILED", "Registry operation failed", false, operation);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new AgentError("FINALITY_PENDING", "Operation has not reached required confirmations", true, { operationId });
  }

  private assertRegistryDomain(identity: Row, domainValue: unknown): Record<string, unknown> {
    const domain = asObject(domainValue, "domain");
    if (Number(domain.chainId) !== this.config.expectedChainId
      || String(domain.verifyingContract || "").toLowerCase() !== String(identity.registry_address).toLowerCase()
      || domain.name !== "MEMO Agent DID Registry"
      || String(domain.version) !== "1") {
      throw new AgentError("INVALID_SIGNING_DOMAIN", "Registry intent domain does not match local configuration");
    }
    return domain;
  }

  private installation(required = true): Row | undefined {
    const row = this.store.db.prepare("SELECT * FROM installations WHERE installation_id = ?").get(this.config.installationId) as Row | undefined;
    if (!row) {
      const another = this.store.db.prepare("SELECT installation_id FROM installations LIMIT 1").get() as Row | undefined;
      if (another) throw new AgentError("INSTALLATION_ID_MISMATCH", "State directory belongs to a different Agent installation");
    }
    if (!row && required) throw new AgentError("IDENTITY_NOT_FOUND", "No local identity exists");
    return row;
  }

  doctor(): Record<string, unknown> {
    const checks: Record<string, unknown>[] = [
      { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.versions.node },
      { name: "registryAdapter", ok: true, value: "memo-mainnet-erc4337-v0.7" },
      { name: "networkEgress", ok: this.config.deploymentEnvironment === "local" || this.config.apiUrl.startsWith("https://"), value: this.config.apiOrigin },
      { name: "dataDidDependency", ok: true, value: "absent" },
      { name: "r2ServiceGrant", ok: process.env.MEMO_AGENT_MAINNET_ALLOW_R2 === "1" },
      { name: "r4TestGrant", ok: hasLocalR4TestGrant() },
      { name: "masterKey", ok: Boolean(process.env.MEMO_AGENT_MAINNET_MASTER_KEY) },
      { name: "installationIdentity", ok: Boolean(this.config.installationId), value: this.config.installationId },
      { name: "keyProvider", ok: true, value: (() => { try { return this.signer.providerName; } catch { return "unavailable"; } })() },
      { name: "keyringAvailable", ok: this.signer.keyringAvailable() },
      { name: "secureStorageReady", ok: this.signer.secureStorageReady() },
    ];
    if (existsSync(this.config.dbPath)) checks.push({ name: "stateStoreMode", ok: (statSync(this.config.dbPath).mode & 0o777) === 0o600, value: (statSync(this.config.dbPath).mode & 0o777).toString(8) });
    if (existsSync(this.config.keyStorePath)) checks.push({ name: "keyStoreMode", ok: (statSync(this.config.keyStorePath).mode & 0o777) === 0o600, value: (statSync(this.config.keyStorePath).mode & 0o777).toString(8) });
    return { mode: `memo-mainnet-${this.config.deploymentEnvironment}`, chainId: CHAIN_ID, ready: checks.filter((item) => ["node", "registryAdapter", "networkEgress", "dataDidDependency", "stateStoreMode", "keyStoreMode", "installationIdentity", "secureStorageReady"].includes(String(item.name))).every((item) => item.ok), checks };
  }

  ensureIdentity(): Record<string, unknown> {
    const existing = this.installation(false);
    if (existing) {
      if (existing.network !== `eip155:${this.config.expectedChainId}`) {
        this.store.db.prepare("UPDATE installations SET state='QUARANTINED' WHERE installation_id=?").run(this.config.installationId);
        throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Existing local identity belongs to another chain");
      }
      if (existing.deployment_environment && existing.deployment_environment !== this.config.deploymentEnvironment) {
        this.store.db.prepare("UPDATE installations SET state='QUARANTINED' WHERE installation_id=?").run(this.config.installationId);
        throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Existing local identity belongs to another deployment environment");
      }
      try {
        const publicKey = this.signer.getPublic(String(existing.identity_key_handle));
        const did = `did:memo:agent:${this.config.expectedChainId}:${publicKey.address}`;
        if (publicKey.address !== existing.identity_account || publicKey.publicKey !== existing.public_key || did !== existing.agent_did) {
          throw new AgentError("DID_KEY_MISMATCH", "Local identity key does not match persisted identity metadata");
        }
      } catch (error) {
        this.store.db.prepare("UPDATE installations SET state='QUARANTINED' WHERE installation_id=?").run(this.config.installationId);
        throw error;
      }
      return { ...publicInstallation(existing), state: existing.state === "LOCAL_KEY_CREATED" ? "LOCAL_IDENTITY_READY" : existing.state, reused: true };
    }
    return this.store.transaction(() => {
      const raced = this.installation(false);
      if (raced) return { ...publicInstallation(raced), reused: true };
      const handle = `identity_${this.config.installationId}_v1`;
      const key = this.signer.ensureKey("identity", handle);
      const did = `did:memo:agent:${this.config.expectedChainId}:${key.address}`;
      this.store.db.prepare(`INSERT INTO installations
        (installation_id,agent_did,network,identity_key_handle,identity_account,public_key,last_identity_revision,state,
         profile_hash,registry_address,management_registry_address,api_url,key_provider,default_instance_state,deployment_environment)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'LOCAL_IDENTITY_READY', NULL, NULL, NULL, NULL, ?, NULL, ?)`)
        .run(this.config.installationId, did, `eip155:${this.config.expectedChainId}`, key.handle, key.address, key.publicKey, this.signer.providerName, this.config.deploymentEnvironment);
      return { ...publicInstallation(this.installation()!), reused: false };
    });
  }

  async initialize(storage = "auto"): Promise<Record<string, unknown>> {
    if (!["auto", "encrypted-file", "os-keyring"].includes(storage)) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Unsupported identity storage provider");
    return this.ensureIdentity();
  }

  migrateKeyToOsKeyring(): Record<string, unknown> {
    const identity = this.installation()!;
    const before = this.signer.getPublic(String(identity.identity_key_handle));
    const migrated = this.signer.migrateToOsKeyring();
    const after = this.signer.getPublic(String(identity.identity_key_handle));
    if (before.address !== after.address || before.publicKey !== after.publicKey) throw new AgentError("DID_KEY_MISMATCH", "Key migration changed the identity key");
    this.store.db.prepare("UPDATE installations SET key_provider='os-keyring' WHERE installation_id=?").run(this.config.installationId);
    return { ...migrated, agentDid: identity.agent_did, identityAccount: after.address, publicKey: after.publicKey };
  }

  status(): Record<string, unknown> {
    const row = this.installation(false);
    return row ? { exists: true, ...publicInstallation(row) } : { exists: false, state: "ABSENT" };
  }

  async register(profile: unknown, dryRun: boolean): Promise<{ data: Record<string, unknown>; operationId: string | null }> {
    let identity = this.installation()!;
    const object = asObject(profile, "profile");
    const encoded = canonicalize(object);
    if (Buffer.byteLength(encoded) > 16_384) throw new AgentError("INVALID_PROFILE", "Profile exceeds 16 KiB");
    const forbidden = /private|secret|password|token|recovery|dataDid|managerDid/i;
    if (Object.keys(object).some((key) => forbidden.test(key))) throw new AgentError("INVALID_PROFILE", "Profile contains a forbidden field");
    const profileHash = sha256(encoded);
    if (!dryRun) {
      this.store.db.prepare("UPDATE installations SET local_profile_json=? WHERE installation_id=?")
        .run(encoded, this.config.installationId);
    }
    if (!dryRun && identity.state === "ACTIVE" && identity.profile_hash === profileHash) {
      const prior = this.store.db.prepare("SELECT * FROM operations WHERE action_type = 'RegisterAgent' ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined;
      if (prior) return { data: { ...JSON.parse(String(prior.data_json)), reused: true }, operationId: String(prior.operation_id) };
    }
    const document = {
      id: identity.agent_did,
      verificationMethod: [{ id: `${identity.agent_did}#identity-1`, type: "MemoEip712Secp256k1VerificationMethod2026", controller: identity.agent_did, blockchainAccountId: `${identity.network}:${identity.identity_account}`, publicKeyMultibase: identity.public_key }],
      authentication: [`${identity.agent_did}#identity-1`],
      assertionMethod: [`${identity.agent_did}#identity-1`],
    };
    const registrationInput = {
      identityAccount: identity.identity_account,
      identityPublicKeyHash: keccak256(String(identity.public_key)),
      profile: object,
      document,
    };
    if (dryRun) return { data: { dryRun: true, actionType: "RegisterAgent", risk: "R2", registrationInput }, operationId: null };
    authorize("R2");
    const platform = await this.chainConfig();
    const contracts = asObject(platform.contracts, "contracts");
    const registry = asObject(contracts.agentDidRegistry, "agentDidRegistry");
    const managementRegistry = asObject(contracts.agentManagementRegistry, "agentManagementRegistry");
    if (Number(platform.chainId) !== this.config.expectedChainId || String(identity.agent_did).split(":")[3] !== String(platform.chainId)) {
      this.store.db.prepare("UPDATE installations SET state='QUARANTINED' WHERE installation_id=?").run(this.config.installationId);
      throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Local DID and platform chain do not match");
    }
    if ((identity.registry_address && String(identity.registry_address).toLowerCase() !== String(registry.address).toLowerCase())
      || (identity.management_registry_address && String(identity.management_registry_address).toLowerCase() !== String(managementRegistry.address).toLowerCase())) {
      this.store.db.prepare("UPDATE installations SET state='QUARANTINED' WHERE installation_id=?").run(this.config.installationId);
      throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Persisted Registry addresses do not match the platform");
    }
    this.store.db.prepare(`UPDATE installations SET registry_address=?,management_registry_address=?,api_url=?,deployment_environment=?,state='REGISTRATION_SUBMITTED' WHERE installation_id=?`)
      .run(String(registry.address), String(managementRegistry.address), this.config.apiUrl, this.config.deploymentEnvironment, this.config.installationId);
    identity = this.installation()!;
    const intent = await this.api("/api/v1/registration-intents", { method: "POST", body: JSON.stringify(registrationInput) });
    const signed = await this.signer.signTypedAction(String(identity.identity_key_handle), String(intent.actionType), asObject(intent.message, "message"), this.assertRegistryDomain(identity, intent.domain));
    if (signed.digest !== intent.digest) throw new AgentError("ACTION_DIGEST_MISMATCH", "Platform intent digest does not match local reconstruction");
    const submitted = await this.api("/api/v1/agent-dids", { method: "POST", headers: { "idempotency-key": signed.digest }, body: JSON.stringify({ intentId: intent.intentId, signature: signed.signature }) });
    const operationId = asString(submitted.operationId, "operationId");
    const confirmed = await this.waitOperation(operationId);
    const data: Record<string, unknown> = { agentDid: identity.agent_did, status: "active", identityRevision: confirmed.resultingRevision, profileHash, registry: identity.registry_address, signature: signed.signature, digest: signed.digest, txHash: confirmed.txHash, blockNumber: confirmed.blockNumber, blockHash: confirmed.blockHash, confirmations: confirmed.confirmations, gasUsed: confirmed.gasUsed, feeWei: confirmed.feeWei };
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR REPLACE INTO operations
        (operation_id,idempotency_key,action_type,action_digest,tx_hash,block_number,block_hash,state,data_json,updated_at)
        VALUES (?, ?, 'RegisterAgent', ?, ?, ?, ?, 'CONFIRMED', ?, ?)`)
        .run(operationId, signed.digest, signed.digest, String(confirmed.txHash), Number(confirmed.blockNumber), String(confirmed.blockHash), JSON.stringify(data), now());
      this.store.db.prepare("UPDATE installations SET state = 'ACTIVE', profile_hash = ?, last_identity_revision = ? WHERE installation_id = ?").run(profileHash, Number(confirmed.resultingRevision), this.config.installationId);
    });
    try {
      const existingDefault = this.store.db.prepare("SELECT instance_id FROM instance_keys WHERE name='default' LIMIT 1").get();
      if (!existingDefault) await this.createInstance("default", "30d");
      this.store.db.prepare("UPDATE installations SET default_instance_state='ACTIVE' WHERE installation_id=?").run(this.config.installationId);
      data.defaultInstanceState = "ACTIVE";
    } catch {
      this.store.db.prepare("UPDATE installations SET default_instance_state='DEFAULT_INSTANCE_PENDING' WHERE installation_id=?").run(this.config.installationId);
      data.defaultInstanceState = "DEFAULT_INSTANCE_PENDING";
    }
    return { data, operationId };
  }

  async resolve(did: string, verify: boolean): Promise<Record<string, unknown>> {
    const match = DID_PATTERN.exec(did);
    if (!match || Number(match[1]) !== this.config.expectedChainId) throw new AgentError("INVALID_DID", "DID is not a canonical MEMO AgentDID for this network");
    const identity = this.installation()!;
    const derived = `did:memo:agent:${this.config.expectedChainId}:${this.signer.getPublic(String(identity.identity_key_handle)).address}`;
    if (verify && derived !== did) throw new AgentError("DID_KEY_MISMATCH", "Local identity key does not match the DID");
    return this.api(`/api/v1/agent-dids/${encodeURIComponent(did)}`, {}, false);
  }

  async createInstance(name: string, ttl: string): Promise<Record<string, unknown>> {
    authorize("R2");
    const identity = this.installation()!;
    if (identity.state !== "ACTIVE") throw new AgentError("IDENTITY_NOT_ACTIVE", "Register the identity before creating an instance");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new AgentError("INVALID_INSTANCE_NAME", "Instance name is invalid");
    const expiresAt = now() + parseDuration(ttl);
    const instanceId = `inst_${randomUUID()}`;
    const key = this.signer.createKey("instance");
    const payload = { agentDid: identity.agent_did, instanceId, publicKey: key.publicKey, audiencesHash: canonicalHash(["local-mvp"]), actionsHash: canonicalHash(["auth.sign"]), expiresAt, identityRevision: Number(identity.last_identity_revision) };
    const signed = await this.signer.signTypedAction(String(identity.identity_key_handle), "IssueInstance", payload);
    const credential = { schema: "memo.instance-credential/1", ...payload, signature: signed.signature, digest: signed.digest };
    this.store.db.prepare("INSERT INTO instance_keys VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)").run(instanceId, name, key.handle, key.publicKey, JSON.stringify(credential), expiresAt);
    return { instanceId, name, publicKey: key.publicKey, credential, state: "ACTIVE", expiresAt };
  }

  async reconcileDefaultInstance(): Promise<Record<string, unknown>> {
    authorize("R2");
    const identity = this.installation()!;
    if (identity.state !== "ACTIVE") throw new AgentError("IDENTITY_NOT_ACTIVE", "Register the identity before reconciling the default instance");
    const existing = this.store.db.prepare("SELECT instance_id,name,public_key,credential_json,state,expires_at FROM instance_keys WHERE name='default' AND state='ACTIVE' AND expires_at>? ORDER BY expires_at DESC LIMIT 1").get(now()) as Row | undefined;
    if (existing) {
      this.store.db.prepare("UPDATE installations SET default_instance_state='ACTIVE' WHERE installation_id=?").run(this.config.installationId);
      return { instanceId: existing.instance_id, name: existing.name, publicKey: existing.public_key, credential: JSON.parse(String(existing.credential_json)), state: existing.state, expiresAt: existing.expires_at, reused: true };
    }
    try {
      const created = await this.createInstance("default", "30d");
      this.store.db.prepare("UPDATE installations SET default_instance_state='ACTIVE' WHERE installation_id=?").run(this.config.installationId);
      return { ...created, reused: false };
    } catch (error) {
      this.store.db.prepare("UPDATE installations SET default_instance_state='DEFAULT_INSTANCE_PENDING' WHERE installation_id=?").run(this.config.installationId);
      throw error;
    }
  }

  listInstances(): Record<string, unknown> {
    const rows = this.store.db.prepare("SELECT instance_id, name, public_key, credential_json, state, expires_at FROM instance_keys ORDER BY instance_id").all() as Row[];
    return { instances: rows.map((row) => ({ instanceId: row.instance_id, name: row.name, publicKey: row.public_key, credential: JSON.parse(String(row.credential_json)), state: row.state, expiresAt: row.expires_at })) };
  }

  private async registryAction(actionType: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    authorize(actionType === "RevokeAgent" || actionType === "DeclareSuccessor" ? "R4" : "R2");
    const identity = this.installation()!;
    const intent = await this.api("/api/v1/registry-action-intents", {
      method: "POST",
      body: JSON.stringify({ actionType, identityAccount: identity.identity_account, ...extra }),
    });
    const signed = await this.signer.signTypedAction(
      String(identity.identity_key_handle),
      String(intent.actionType),
      asObject(intent.message, "message"),
      this.assertRegistryDomain(identity, intent.domain),
    );
    if (signed.digest !== intent.digest) throw new AgentError("ACTION_DIGEST_MISMATCH", "Platform intent digest does not match local reconstruction");
    const submitted = await this.api("/api/v1/registry-actions", {
      method: "POST", headers: { "idempotency-key": signed.digest },
      body: JSON.stringify({ intentId: intent.intentId, signature: signed.signature }),
    });
    const operationId = asString(submitted.operationId, "operationId");
    const confirmed = await this.waitOperation(operationId);
    const stateByAction: Record<string, string> = { SuspendAgent: "SUSPENDED", ResumeAgent: "ACTIVE", RevokeAgent: "REVOKED", DeclareSuccessor: "SUPERSEDED" };
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR REPLACE INTO operations
        (operation_id,idempotency_key,action_type,action_digest,tx_hash,block_number,block_hash,state,data_json,updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`)
        .run(operationId, signed.digest, actionType, signed.digest, String(confirmed.txHash), Number(confirmed.blockNumber), String(confirmed.blockHash), JSON.stringify(confirmed), now());
      this.store.db.prepare(`UPDATE installations SET last_identity_revision = ?, state = COALESCE(?, state),
        profile_hash = COALESCE(?, profile_hash) WHERE installation_id = ?`)
        .run(Number(confirmed.resultingRevision), stateByAction[actionType] || null, intent.message ? String(asObject(intent.message).profileHash || "") || null : null, this.config.installationId);
    });
    return {
      actionType, operationId, digest: signed.digest, signature: signed.signature,
      ...(intent.message && asObject(intent.message).profileHash ? { profileHash: asObject(intent.message).profileHash } : {}),
      ...(intent.message && asObject(intent.message).documentHash ? { documentHash: asObject(intent.message).documentHash } : {}),
      ...confirmed,
    };
  }

  async updateProfile(profile: unknown): Promise<Record<string, unknown>> {
    return this.registryAction("UpdateProfile", { profile: asObject(profile, "profile") });
  }

  async updateDocument(document: unknown): Promise<Record<string, unknown>> {
    return this.registryAction("UpdateDocument", { document: asObject(document, "document") });
  }

  async changeIdentityState(action: "suspend" | "resume" | "revoke"): Promise<Record<string, unknown>> {
    const map = { suspend: "SuspendAgent", resume: "ResumeAgent", revoke: "RevokeAgent" } as const;
    return this.registryAction(map[action]);
  }

  async declareSuccessor(successorDid: string): Promise<Record<string, unknown>> {
    return this.registryAction("DeclareSuccessor", { successorDid });
  }

  async revokeInstance(id: string, reason: string): Promise<Record<string, unknown>> {
    authorize("R2");
    const row = this.store.db.prepare("SELECT * FROM instance_keys WHERE instance_id = ?").get(id) as Row | undefined;
    if (!row) throw new AgentError("INSTANCE_NOT_FOUND", "Instance was not found");
    if (row.state === "REVOKED") return { instanceId: id, state: "REVOKED", reused: true };
    const operation = await this.registryAction("RevokeInstanceCredential", { credentialId: id });
    this.store.db.prepare("UPDATE instance_keys SET state = 'REVOKED' WHERE instance_id = ?").run(id);
    return { instanceId: id, state: "REVOKED", reason, operation };
  }

  async signChallenge(challengeValue: unknown): Promise<Record<string, unknown>> {
    const challenge = asObject(challengeValue, "challenge");
    assertExactFields(challenge, ["issuer", "audience", "action", "nonce", "issuedAt", "expiresAt"]);
    const issuer = asString(challenge.issuer, "issuer");
    const audience = asString(challenge.audience, "audience");
    const action = asString(challenge.action, "action");
    const nonce = asString(challenge.nonce, "nonce");
    const issuedAt = asInteger(challenge.issuedAt, "issuedAt");
    const expiresAt = asInteger(challenge.expiresAt, "expiresAt");
    if (expiresAt <= now() || issuedAt > now() + 60 || expiresAt - issuedAt > 900) throw new AgentError("INVALID_CHALLENGE", "Challenge time window is invalid");
    const identity = this.installation()!;
    if (identity.state !== "ACTIVE") throw new AgentError("IDENTITY_NOT_ACTIVE", "Identity is not active");
    const instance = this.store.db.prepare("SELECT * FROM instance_keys WHERE state = 'ACTIVE' AND expires_at > ? ORDER BY instance_id LIMIT 1").get(now()) as Row | undefined;
    if (!instance) throw new AgentError("INSTANCE_NOT_FOUND", "No active instance is available");
    const nonceHash = sha256(nonce);
    try {
      this.store.db.prepare("INSERT INTO consumed_challenges VALUES (?, ?, ?)").run(issuer, nonceHash, expiresAt);
    } catch {
      throw new AgentError("NONCE_REPLAYED", "Challenge nonce has already been consumed");
    }
    const payload = { agentDid: identity.agent_did, instanceId: instance.instance_id, issuer, audience, action, nonceHash, issuedAt, expiresAt };
    const signed = await this.signer.signTypedAction(String(instance.key_handle), "AuthChallenge", payload);
    return { schema: "memo.agent-auth-response/1", ...payload, publicKey: signed.publicKey, signature: signed.signature, digest: signed.digest };
  }

  async selfTest(): Promise<Record<string, unknown>> {
    const instant = now();
    const result = await this.signChallenge({ issuer: "memo-agent-self-test", audience: "local-mvp", action: "identity.self-test", nonce: randomBytes(32).toString("hex"), issuedAt: instant, expiresAt: instant + 60 });
    return { passed: true, instanceId: result.instanceId, digest: result.digest };
  }

  async acceptPairingInvitation(packageValue: unknown, profile?: unknown): Promise<Record<string, unknown>> {
    authorize("R2");
    this.ensureIdentity();
    const pairingPackage = this.validatePairingPackage(packageValue, "platform-invitation");
    await this.assertPairingPlatform(pairingPackage);
    const inspected = await this.api("/api/v1/pairing-invitations/inspect", {
      method: "POST",
      body: JSON.stringify({ exchangeId: pairingPackage.exchangeId, handle: pairingPackage.handle }),
    });
    this.assertPairingView(inspected, pairingPackage);
    this.saveLocalPairing(pairingPackage, "CREATED");
    const claimed = await this.api(`/api/v1/pairing-invitations/${encodeURIComponent(String(pairingPackage.exchangeId))}/claim`, {
      method: "POST",
      headers: { "idempotency-key": `pairing:${pairingPackage.exchangeId}:claim` },
      body: JSON.stringify({ handle: pairingPackage.handle }),
    });
    this.assertPairingView(claimed, pairingPackage);
    this.updateLocalPairing(String(pairingPackage.exchangeId), String(claimed.state || "CLAIMED"));
    this.updateLocalPairing(String(pairingPackage.exchangeId), "REGISTRATION_PENDING");
    const registration = await this.ensureRegisteredForPairing(profile);
    const completed = await this.api(`/api/v1/pairing-invitations/${encodeURIComponent(String(pairingPackage.exchangeId))}/complete`, {
      method: "POST",
      headers: { "idempotency-key": `pairing:${pairingPackage.exchangeId}:complete` },
    });
    this.assertPairingView(completed, pairingPackage);
    this.updateLocalPairing(String(pairingPackage.exchangeId), "PAIRED", registration.operationId);
    this.destroyPairingSecret(String(pairingPackage.exchangeId));
    return this.publicPairing(completed, registration.operationId);
  }

  async createPairingOffer(maxScopesCsv: string, maxTerm: string, ttl: string, profile?: unknown): Promise<Record<string, unknown>> {
    authorize("R2");
    this.ensureIdentity();
    const scopes = this.pairingScopes(maxScopesCsv);
    const ttlSeconds = this.pairingDuration(ttl, "PAIRING_TTL", 86_400);
    const maxTermSeconds = this.pairingDuration(maxTerm, "RELATIONSHIP_TERM", 365 * 24 * 60 * 60);
    const registration = await this.ensureRegisteredForPairing(profile);
    const identity = this.installation()!;
    const exchangeId = `poff_${randomBytes(18).toString("base64url")}`;
    const handle = `memo-pair-v2.${exchangeId}.${randomBytes(32).toString("base64url")}`;
    const remote = await this.api("/api/v1/pairing-offers", {
      method: "POST",
      headers: { "idempotency-key": `pairing:${exchangeId}:create` },
      body: JSON.stringify({
        exchangeId,
        tokenHash: pairingTokenHash(handle),
        platformOrigin: this.config.apiOrigin,
        maxScopes: scopes,
        maxTermSeconds,
        ttlSeconds,
      }),
    });
    const pairingPackage: Record<string, unknown> = {
      schema: PAIRING_SCHEMA,
      kind: "agent-offer",
      exchangeId,
      platformOrigin: this.config.apiOrigin,
      environment: this.config.deploymentEnvironment,
      chainId: this.config.expectedChainId,
      didRegistry: identity.registry_address,
      managementRegistry: identity.management_registry_address,
      handle,
      issuedAt: remote.issuedAt,
      expiresAt: remote.expiresAt,
      agentDid: identity.agent_did,
      identityAccount: identity.identity_account,
      profileHash: identity.profile_hash,
      maxScopes: scopes,
      maxTermSeconds,
    };
    const validated = this.validatePairingPackage(pairingPackage, "agent-offer");
    this.assertPairingView(remote, validated);
    this.saveLocalPairing(validated, "CREATED");
    return {
      ...this.publicPairing(remote, registration.operationId),
      pairingPackage: validated,
    };
  }

  async pairingStatus(id: string): Promise<Record<string, unknown>> {
    const row = this.localPairing(id);
    const remote = await this.api(`/api/v1/pairing-exchanges/${encodeURIComponent(id)}`);
    const state = String(remote.state);
    this.updateLocalPairing(id, state, row.registration_operation_id ? String(row.registration_operation_id) : undefined);
    if (["PAIRED", "CANCELLED", "EXPIRED", "FAILED"].includes(state)) this.destroyPairingSecret(id);
    return this.publicPairing(remote, row.registration_operation_id ? String(row.registration_operation_id) : null);
  }

  async resumePairing(id: string, profile?: unknown): Promise<Record<string, unknown>> {
    authorize("R2");
    const row = this.localPairing(id);
    if (row.kind === "agent-offer") return this.pairingStatus(id);
    if (["PAIRED", "CANCELLED", "EXPIRED", "FAILED"].includes(String(row.state))) return this.pairingStatus(id);
    const pairingPackage = { ...JSON.parse(String(row.package_json)), handle: this.signer.readSecret(String(row.secret_handle)) };
    return this.acceptPairingInvitation(pairingPackage, profile);
  }

  async cancelPairing(id: string): Promise<Record<string, unknown>> {
    authorize("R2");
    const row = this.localPairing(id);
    if (row.state !== "CANCELLED") {
      const remote = await this.api(`/api/v1/pairing-exchanges/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `pairing:${id}:cancel` },
      });
      this.updateLocalPairing(id, String(remote.state || "CANCELLED"), row.registration_operation_id ? String(row.registration_operation_id) : undefined);
      this.destroyPairingSecret(id);
      return this.publicPairing(remote, row.registration_operation_id ? String(row.registration_operation_id) : null);
    }
    return this.publicPairing({ ...JSON.parse(String(row.package_json)), exchangeId: id, kind: row.kind, state: "CANCELLED" }, row.registration_operation_id ? String(row.registration_operation_id) : null);
  }

  private retireV1PairingSecrets(): void {
    const rows = this.store.db.prepare("SELECT pairing_grant_id,token_secret_handle FROM pairing_grants WHERE state!='LEGACY_INVALIDATED'").all() as Row[];
    for (const row of rows) {
      try {
        if (row.token_secret_handle !== "destroyed") this.signer.destroy(String(row.token_secret_handle));
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== "KEY_NOT_FOUND") throw error;
      }
      this.store.db.prepare("UPDATE pairing_grants SET token_secret_handle='destroyed',state='LEGACY_INVALIDATED',updated_at=? WHERE pairing_grant_id=?")
        .run(now(), String(row.pairing_grant_id));
    }
  }

  private async ensureRegisteredForPairing(profile?: unknown): Promise<{ operationId: string | null }> {
    const identity = this.installation()!;
    if (identity.state === "ACTIVE") {
      const prior = this.store.db.prepare("SELECT operation_id FROM operations WHERE action_type='RegisterAgent' ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined;
      return { operationId: prior ? String(prior.operation_id) : null };
    }
    if (!["LOCAL_IDENTITY_READY", "REGISTRATION_SUBMITTED"].includes(String(identity.state))) {
      throw new AgentError("IDENTITY_NOT_ACTIVE", "This identity state cannot be registered through Pairing");
    }
    let selected = profile;
    if (selected === undefined && identity.local_profile_json) selected = JSON.parse(String(identity.local_profile_json));
    if (selected === undefined) {
      selected = {
        name: "Unnamed Agent",
        description: "Registered through MEMO Agent DID pairing",
        endpoints: [],
      };
    }
    const result = await this.register(selected, false);
    return { operationId: result.operationId };
  }

  private validatePairingPackage(value: unknown, kind: "platform-invitation" | "agent-offer"): Record<string, unknown> {
    const object = asObject(value, "pairing package");
    const expected = kind === "platform-invitation" ? INVITATION_FIELDS : OFFER_FIELDS;
    const actual = Object.keys(object).sort();
    const required = [...expected].sort();
    if (actual.length !== required.length || actual.some((field, index) => field !== required[index])) {
      throw new AgentError("INVALID_PAIRING_PACKAGE", "Pairing package contains unknown or missing fields");
    }
    if (object.schema !== PAIRING_SCHEMA || object.kind !== kind) throw new AgentError("INVALID_PAIRING_PACKAGE", "Pairing package schema or kind is invalid");
    const exchangeId = asString(object.exchangeId, "exchangeId");
    const expectedPrefix = kind === "platform-invitation" ? "pinv_" : "poff_";
    if (!exchangeId.startsWith(expectedPrefix) || !/^(pinv|poff)_[A-Za-z0-9_-]{12,100}$/.test(exchangeId)) {
      throw new AgentError("INVALID_PAIRING_PACKAGE", "Pairing exchange ID is invalid");
    }
    const handle = asString(object.handle, "handle");
    const handleMatch = PAIRING_HANDLE.exec(handle);
    if (!handleMatch || handleMatch[1] !== exchangeId) throw new AgentError("INVALID_PAIRING_PACKAGE", "Pairing handle does not match the exchange");
    if (object.platformOrigin !== this.config.apiOrigin || object.environment !== this.config.deploymentEnvironment || Number(object.chainId) !== this.config.expectedChainId) {
      throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Pairing package targets another platform, environment, or chain");
    }
    for (const field of ["didRegistry", "managementRegistry"] as const) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(asString(object[field], field)) || /^0x0{40}$/i.test(String(object[field]))) {
        throw new AgentError("INVALID_PAIRING_PACKAGE", `${field} is invalid`);
      }
    }
    const issuedAt = asString(object.issuedAt, "issuedAt");
    const expiresAt = asString(object.expiresAt, "expiresAt");
    const issuedMs = Date.parse(issuedAt);
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)
      || new Date(issuedMs).toISOString() !== issuedAt || new Date(expiresMs).toISOString() !== expiresAt
      || issuedMs > Date.now() + 60_000 || expiresMs <= Date.now() || expiresMs - issuedMs > 86_400_000) {
      throw new AgentError("PAIRING_INVALID_OR_EXPIRED", "Pairing package time window is invalid or expired");
    }
    if (kind === "platform-invitation") {
      try { getAddress(asString(object.managerAccount, "managerAccount")); } catch { throw new AgentError("INVALID_PAIRING_PACKAGE", "Manager account is invalid"); }
      this.validatePairingScopes(object.requestedScopes, "requestedScopes");
      this.validatePairingTerm(object.requestedTermSeconds, "requestedTermSeconds");
      if (!["private", "public"].includes(String(object.visibility))) throw new AgentError("INVALID_PAIRING_PACKAGE", "Pairing visibility is invalid");
    } else {
      const agentDid = asString(object.agentDid, "agentDid");
      const identityAccount = asString(object.identityAccount, "identityAccount");
      if (agentDid !== `did:memo:agent:${this.config.expectedChainId}:${identityAccount.toLowerCase()}`) {
        throw new AgentError("DID_KEY_MISMATCH", "Offer identity account does not match its AgentDID");
      }
      try { getAddress(identityAccount); } catch { throw new AgentError("INVALID_PAIRING_PACKAGE", "Offer identity account is invalid"); }
      if (!/^0x[0-9a-f]{64}$/.test(asString(object.profileHash, "profileHash"))) throw new AgentError("INVALID_PAIRING_PACKAGE", "Offer profile hash is invalid");
      this.validatePairingScopes(object.maxScopes, "maxScopes");
      this.validatePairingTerm(object.maxTermSeconds, "maxTermSeconds");
    }
    return { ...object };
  }

  private async assertPairingPlatform(pairingPackage: Record<string, unknown>): Promise<void> {
    const chain = await this.chainConfig();
    const contracts = asObject(chain.contracts, "contracts");
    const didRegistry = asObject(contracts.agentDidRegistry, "agentDidRegistry");
    const managementRegistry = asObject(contracts.agentManagementRegistry, "agentManagementRegistry");
    if (String(pairingPackage.didRegistry).toLowerCase() !== String(didRegistry.address).toLowerCase()
      || String(pairingPackage.managementRegistry).toLowerCase() !== String(managementRegistry.address).toLowerCase()) {
      throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "Pairing package Registry addresses do not match the platform");
    }
  }

  private assertPairingView(remote: Record<string, unknown>, pairingPackage: Record<string, unknown>): void {
    const equal = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
    for (const field of ["schema", "kind", "exchangeId", "platformOrigin", "environment", "chainId", "issuedAt", "expiresAt"] as const) {
      if (!equal(remote[field], pairingPackage[field])) throw new AgentError("PAIRING_PACKAGE_MISMATCH", `Platform ${field} does not match the Pairing file`);
    }
    if (String(remote.didRegistry).toLowerCase() !== String(pairingPackage.didRegistry).toLowerCase()
      || String(remote.managementRegistry).toLowerCase() !== String(pairingPackage.managementRegistry).toLowerCase()) {
      throw new AgentError("PAIRING_PACKAGE_MISMATCH", "Platform Registry metadata does not match the Pairing file");
    }
    if (pairingPackage.kind === "platform-invitation") {
      if (String(remote.managerAccount).toLowerCase() !== String(pairingPackage.managerAccount).toLowerCase()
        || !equal(remote.requestedScopes, pairingPackage.requestedScopes)
        || !equal(remote.requestedTermSeconds, pairingPackage.requestedTermSeconds)
        || !equal(remote.visibility, pairingPackage.visibility)) {
        throw new AgentError("PAIRING_PACKAGE_MISMATCH", "Invitation terms do not match the platform");
      }
    } else if (remote.agentDid !== pairingPackage.agentDid
      || String(remote.identityAccount).toLowerCase() !== String(pairingPackage.identityAccount).toLowerCase()
      || remote.profileHash !== pairingPackage.profileHash
      || !equal(remote.maxScopes, pairingPackage.maxScopes)
      || !equal(remote.maxTermSeconds, pairingPackage.maxTermSeconds)) {
      throw new AgentError("PAIRING_PACKAGE_MISMATCH", "Offer terms do not match the platform");
    }
  }

  private pairingScopes(csv: string): string[] {
    const result = [...new Set(csv.split(",").map((item) => item.trim()).filter(Boolean))].sort();
    return this.validatePairingScopes(result, "maxScopes");
  }

  private validatePairingScopes(value: unknown, name: string): string[] {
    const scopes = asStringArray(value, name);
    if (scopes.length > 32 || scopes.some((scope) => !/^[a-z][a-z0-9_.:-]{1,63}$/.test(scope))) {
      throw new AgentError("INVALID_SCOPE", `${name} contains an invalid scope`);
    }
    if (canonicalize(value) !== canonicalize(scopes)) throw new AgentError("INVALID_PAIRING_PACKAGE", `${name} must be unique and sorted`);
    return scopes;
  }

  private pairingDuration(value: string, name: string, maximum: number): number {
    const seconds = parseDuration(value);
    if (seconds < 60 || seconds > maximum) throw new AgentError(`INVALID_${name}`, `${name} must be between 60 and ${maximum} seconds`);
    return seconds;
  }

  private validatePairingTerm(value: unknown, name: string): number {
    const term = asInteger(value, name);
    if (term < 60 || term > 365 * 24 * 60 * 60) throw new AgentError("INVALID_RELATIONSHIP_TERM", `${name} is outside the supported range`);
    return term;
  }

  private saveLocalPairing(pairingPackage: Record<string, unknown>, state: string): void {
    const exchangeId = String(pairingPackage.exchangeId);
    const redacted = { ...pairingPackage };
    delete redacted.handle;
    const existing = this.store.db.prepare("SELECT * FROM pairing_exchanges WHERE exchange_id=?").get(exchangeId) as Row | undefined;
    if (existing) {
      if (existing.kind !== pairingPackage.kind || canonicalize(JSON.parse(String(existing.package_json))) !== canonicalize(redacted)) {
        throw new AgentError("PAIRING_PACKAGE_MISMATCH", "Local Pairing exchange metadata changed");
      }
      if (!["PAIRED", "CANCELLED", "EXPIRED", "FAILED"].includes(String(existing.state))
        && this.signer.readSecret(String(existing.secret_handle)) !== pairingPackage.handle) {
        throw new AgentError("PAIRING_PACKAGE_MISMATCH", "Local Pairing handle changed");
      }
      return;
    }
    const secretHandle = this.signer.putSecret(String(pairingPackage.handle));
    this.store.db.prepare(`INSERT INTO pairing_exchanges(
      exchange_id,kind,secret_handle,package_json,state,registration_operation_id,expires_at,updated_at
    ) VALUES(?,?,?,?,?,NULL,?,?)`).run(
      exchangeId,
      String(pairingPackage.kind),
      secretHandle,
      JSON.stringify(redacted),
      state,
      Math.floor(Date.parse(String(pairingPackage.expiresAt)) / 1000),
      now(),
    );
  }

  private localPairing(id: string): Row {
    if (!/^(pinv|poff)_[A-Za-z0-9_-]{12,100}$/.test(id)) throw new AgentError("INVALID_PAIRING_EXCHANGE_ID", "Pairing exchange ID is invalid");
    const row = this.store.db.prepare("SELECT * FROM pairing_exchanges WHERE exchange_id=?").get(id) as Row | undefined;
    if (!row) throw new AgentError("PAIRING_NOT_FOUND", "Pairing exchange was not found locally");
    return row;
  }

  private updateLocalPairing(id: string, state: string, operationId?: string | null): void {
    this.store.db.prepare("UPDATE pairing_exchanges SET state=?,registration_operation_id=COALESCE(?,registration_operation_id),updated_at=? WHERE exchange_id=?")
      .run(state, operationId || null, now(), id);
  }

  private destroyPairingSecret(id: string): void {
    const row = this.store.db.prepare("SELECT secret_handle FROM pairing_exchanges WHERE exchange_id=?").get(id) as Row | undefined;
    if (!row || row.secret_handle === "destroyed") return;
    try { this.signer.destroy(String(row.secret_handle)); } catch (error) {
      if (!(error instanceof AgentError) || error.code !== "KEY_NOT_FOUND") throw error;
    }
    this.store.db.prepare("UPDATE pairing_exchanges SET secret_handle='destroyed',updated_at=? WHERE exchange_id=?").run(now(), id);
  }

  private publicPairing(remote: Record<string, unknown>, operationId: string | null): Record<string, unknown> {
    let confirmation: Record<string, unknown> = {};
    if (operationId) {
      const operation = this.store.db.prepare("SELECT data_json FROM operations WHERE operation_id=?").get(operationId) as Row | undefined;
      if (operation) {
        const data = JSON.parse(String(operation.data_json)) as Record<string, unknown>;
        confirmation = {
          operationId,
          confirmations: data.confirmations,
          txHash: data.txHash,
          blockNumber: data.blockNumber,
          blockHash: data.blockHash,
        };
      } else confirmation = { operationId };
    }
    return {
      exchangeId: remote.exchangeId,
      kind: remote.kind,
      state: remote.state,
      agentDid: remote.agentDid || this.installation(false)?.agent_did,
      expiresAt: remote.expiresAt,
      completionDeadline: remote.completionDeadline,
      bindingId: remote.bindingId || asObject(remote.binding || {}, "binding").bindingId,
      managementDraftId: remote.managementDraftId || asObject(remote.managementDraft || {}, "managementDraft").draftId,
      ...confirmation,
    };
  }

  async nextAgentRequest(waitSeconds = 20): Promise<Record<string, unknown>> {
    const boundedWait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
    const result = await this.api(`/api/v1/agent-requests/next?waitSeconds=${boundedWait}`);
    if (!result.request) return { request: null };
    const request = asObject(result.request, "agent request");
    const payload = asObject(request.payload, "agent request payload");
    const identity = this.installation()!;
    const domain = asObject(payload.domain, "domain");
    const message = asObject(payload.message, "message");
    const actionType = asString(payload.actionType, "actionType");
    if (!ACTION_REGISTRY[actionType] || !["ActivateRelationship", "RenewRelationship", "EndRelationship", "TransferRelationship"].includes(actionType)) {
      throw new AgentError("UNSUPPORTED_ACTION", "Queued request has an unsupported management action");
    }
    if (Number(domain.chainId) !== CHAIN_ID
      || domain.name !== "MEMO Agent DID Management"
      || String(domain.version) !== "1"
      || String(domain.verifyingContract).toLowerCase() !== String(identity.management_registry_address || "").toLowerCase()) {
      throw new AgentError("INVALID_SIGNING_DOMAIN", "Queued request has an unexpected management domain");
    }
    if (String(message.agent).toLowerCase() !== String(identity.identity_account).toLowerCase()) {
      throw new AgentError("DID_KEY_MISMATCH", "Queued request targets another Agent identity");
    }
    const expectedFields = ACTION_REGISTRY[actionType]!.map((field) => field.name);
    assertExactFields(message, expectedFields);
    const reconstructed = TypedDataEncoder.hash(domain, { [actionType]: ACTION_REGISTRY[actionType]! }, message);
    if (reconstructed !== payload.digest) throw new AgentError("ACTION_DIGEST_MISMATCH", "Queued request digest is invalid");
    return {
      request: {
        requestId: request.requestId,
        type: request.type,
        expiresAt: request.expiresAt,
        actionType,
        digest: payload.digest,
        managerAccount: message.manager || message.oldManager || message.actor,
        newManager: message.newManager,
        scopesHash: message.scopesHash,
        termEndsAt: message.expiresAt,
        discoverable: message.discoverable,
        expectedRevision: message.expectedRevision,
      },
    };
  }

  async decideAgentRequest(requestId: string, decision: "approve" | "reject", reason = "declined"): Promise<Record<string, unknown>> {
    const queued = await this.api("/api/v1/agent-requests/next?waitSeconds=0");
    const request = asObject(queued.request, "agent request");
    if (request.requestId !== requestId) throw new AgentError("MANAGEMENT_REQUEST_CHANGED", "The requested item is no longer next in the signed queue");
    if (decision === "reject") {
      authorize("R2");
      return this.api(`/api/v1/agent-requests/${encodeURIComponent(requestId)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, reason }),
      });
    }
    authorize("R2");
    const payload = asObject(request.payload, "agent request payload");
    const identity = this.installation()!;
    const domain = asObject(payload.domain, "domain");
    const message = asObject(payload.message, "message");
    const actionType = asString(payload.actionType, "actionType");
    if (Number(domain.chainId) !== CHAIN_ID
      || domain.name !== "MEMO Agent DID Management"
      || String(domain.verifyingContract).toLowerCase() !== String(identity.management_registry_address || "").toLowerCase()
      || String(message.agent).toLowerCase() !== String(identity.identity_account).toLowerCase()) {
      throw new AgentError("INVALID_SIGNING_DOMAIN", "The queued management intent does not match this installation");
    }
    const signed = await this.signer.signTypedAction(String(identity.identity_key_handle), actionType, message, domain);
    if (signed.digest !== payload.digest) throw new AgentError("ACTION_DIGEST_MISMATCH", "The queued management digest changed");
    const decisionResult = await this.api(`/api/v1/agent-requests/${encodeURIComponent(requestId)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, agentSignature: signed.signature, idempotencyKey: signed.digest }),
    });
    const operation = asObject(decisionResult.operation, "management operation");
    const operationId = asString(operation.operationId, "operationId");
    const confirmed = await this.waitOperation(operationId);
    return { ...decisionResult, operation: confirmed };
  }

  async acceptChainManagement(inputValue: unknown): Promise<Record<string, unknown>> {
    authorize("R2");
    const input = asObject(inputValue, "chain management acceptance");
    const intent = asObject(input.intent, "intent");
    const domain = asObject(intent.domain, "domain");
    const message = asObject(intent.message, "message");
    const identity = this.installation()!;
    if (Number(domain.chainId) !== this.config.expectedChainId
      || String(domain.verifyingContract).toLowerCase() !== String(identity.management_registry_address).toLowerCase()
      || domain.name !== "MEMO Agent DID Management" || String(domain.version) !== "1") {
      throw new AgentError("INVALID_SIGNING_DOMAIN", "Management intent domain does not match local configuration");
    }
    if (String(message.agent).toLowerCase() !== String(identity.identity_account).toLowerCase()) {
      throw new AgentError("DID_KEY_MISMATCH", "Management intent targets a different Agent identity");
    }
    const actionType = asString(intent.actionType, "actionType");
    const signatures = asObject(input.signatures || {}, "signatures");
    if (["ActivateRelationship", "RenewRelationship"].includes(actionType)) {
      const managerSignature = asString(signatures.managerSignature, "managerSignature");
      const recovered = verifyTypedData(domain, { [actionType]: ACTION_REGISTRY[actionType]! }, message, managerSignature).toLowerCase();
      if (recovered !== String(message.manager).toLowerCase()) throw new AgentError("INVALID_MANAGER_PROOF", "Manager proof does not match manager address");
    }
    if (actionType === "TransferRelationship") {
      for (const [field, signerField] of [["oldManagerSignature", "oldManager"], ["newManagerSignature", "newManager"]] as const) {
        const proof = asString(signatures[field], field);
        const recovered = verifyTypedData(domain, { [actionType]: ACTION_REGISTRY[actionType]! }, message, proof).toLowerCase();
        if (recovered !== String(message[signerField]).toLowerCase()) throw new AgentError("INVALID_MANAGER_PROOF", `${signerField} proof does not match`);
      }
    }
    if (actionType === "EndRelationship" && String(message.actor).toLowerCase() !== String(identity.identity_account).toLowerCase()) {
      const actorSignature = asString(signatures.actorSignature, "actorSignature");
      const recovered = verifyTypedData(domain, { [actionType]: ACTION_REGISTRY[actionType]! }, message, actorSignature).toLowerCase();
      if (recovered !== String(message.actor).toLowerCase()) throw new AgentError("INVALID_MANAGER_PROOF", "End actor proof does not match actor");
    }
    const signed = await this.signer.signTypedAction(String(identity.identity_key_handle), actionType, message, domain);
    if (signed.digest !== intent.digest) throw new AgentError("ACTION_DIGEST_MISMATCH", "Management intent digest does not match local reconstruction");
    if (["ActivateRelationship", "RenewRelationship", "TransferRelationship"].includes(actionType)) signatures.agentSignature = signed.signature;
    if (actionType === "EndRelationship" && String(message.actor).toLowerCase() === String(identity.identity_account).toLowerCase()) signatures.actorSignature = signed.signature;
    const submitted = await this.api("/api/v1/management-actions", {
      method: "POST", headers: { "idempotency-key": signed.digest },
      body: JSON.stringify({ intentId: intent.intentId, signatures }),
    });
    const operationId = asString(submitted.operationId, "operationId");
    const confirmed = await this.waitOperation(operationId);
    const relationshipState = actionType === "EndRelationship" ? "ENDED" : "ACTIVE";
    return { ...confirmed, operationId, relationshipState, agentSignature: signed.signature, digest: signed.digest };
  }

  inspectManagement(requestValue: unknown): Record<string, unknown> {
    const request = asObject(requestValue, "management request");
    assertExactFields(request, MANAGEMENT_FIELDS);
    const identity = this.installation()!;
    const requestId = asString(request.requestId, "requestId");
    const relationshipId = asString(request.relationshipId, "relationshipId");
    const agentDid = asString(request.agentDid, "agentDid");
    const managerAccount = asString(request.managerAccount, "managerAccount");
    if (agentDid !== identity.agent_did) throw new AgentError("DID_KEY_MISMATCH", "Management request targets a different AgentDID");
    const manager = MANAGER_PATTERN.exec(managerAccount);
    if (!manager || managerAccount !== managerAccount.toLowerCase()) throw new AgentError("INVALID_MANAGER_ACCOUNT", "managerAccount must be canonical CAIP-10");
    const scopes = asStringArray(request.managementScopes, "managementScopes");
    const issuedAt = asInteger(request.issuedAt, "issuedAt");
    const expiresAt = asInteger(request.expiresAt, "expiresAt");
    const termEndsAt = asInteger(request.termEndsAt, "termEndsAt");
    const requestVersion = asInteger(request.requestVersion, "requestVersion");
    const relationshipRevision = asInteger(request.relationshipRevision, "relationshipRevision");
    const visibility = asString(request.visibility, "visibility");
    const source = asString(request.source, "source");
    const managerSignature = asString(request.managerSignature, "managerSignature");
    if (!['public', 'private'].includes(visibility)) throw new AgentError("INVALID_REQUEST", "visibility must be public or private");
    if (expiresAt <= now() || issuedAt > now() + 60 || termEndsAt <= expiresAt) throw new AgentError("INVALID_REQUEST", "Management request time window is invalid");
    const normalized = { requestId, relationshipId, agentDid, managerAccount, managementScopes: scopes, issuedAt, expiresAt, termEndsAt, visibility, requestVersion, relationshipRevision, source, managerSignature };
    const proofPayload = managementProofPayload(normalized);
    let recovered: string;
    try {
      recovered = verifyTypedData(TYPED_DOMAIN, { ManagementRequest: ACTION_REGISTRY.ManagementRequest! }, proofPayload, managerSignature).toLowerCase();
    } catch {
      throw new AgentError("INVALID_MANAGER_PROOF", "Manager Wallet proof is invalid");
    }
    if (recovered !== manager[2]) throw new AgentError("INVALID_MANAGER_PROOF", "Manager Wallet proof does not match managerAccount");
    const hash = canonicalHash(proofPayload);
    const existing = this.store.db.prepare("SELECT * FROM management_requests WHERE request_id = ?").get(requestId) as Row | undefined;
    if (existing && (existing.canonical_payload_hash !== hash || Number(existing.request_version) !== requestVersion)) throw new AgentError("MANAGEMENT_REQUEST_CHANGED", "Request changed after inspection");
    this.store.db.prepare(`INSERT INTO management_requests VALUES (?, ?, ?, ?, ?, 'INSPECTED', ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(requestId, managerAccount, hash, requestVersion, JSON.stringify(normalized), expiresAt, now());
    return { ...normalized, managerSignature: undefined, canonicalPayloadHash: hash, state: "INSPECTED", risk: "R2", managerProof: { verified: true, recoveredAddress: recovered } };
  }

  async acceptManagement(requestId: string): Promise<Record<string, unknown>> {
    authorize("R2");
    const row = this.store.db.prepare("SELECT * FROM management_requests WHERE request_id = ?").get(requestId) as Row | undefined;
    if (!row) throw new AgentError("MANAGEMENT_REQUEST_NOT_FOUND", "Management request was not inspected");
    if (row.state === "ACCEPTED") {
      const rel = this.store.db.prepare("SELECT * FROM management_relationships WHERE request_id = ?").get(requestId) as Row;
      return { ...JSON.parse(String(rel.payload_json)), state: "ACTIVE", reused: true };
    }
    if (row.state !== "INSPECTED") throw new AgentError("MANAGEMENT_REQUEST_CHANGED", "Management request is no longer inspectable");
    if (Number(row.expires_at) <= now()) throw new AgentError("MANAGEMENT_REQUEST_EXPIRED", "Management request expired");
    const request = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    if (canonicalHash(managementProofPayload(request)) !== row.canonical_payload_hash) throw new AgentError("MANAGEMENT_REQUEST_CHANGED", "Stored request payload changed");
    const identity = this.installation()!;
    const payload = {
      relationshipId: request.relationshipId,
      agentDid: request.agentDid,
      managerAccount: request.managerAccount,
      scopesHash: canonicalHash(request.managementScopes),
      termEndsAt: request.termEndsAt,
      visibility: request.visibility,
      relationshipRevision: request.relationshipRevision,
      requestVersion: request.requestVersion,
    };
    const signed = await this.signer.signTypedAction(String(identity.identity_key_handle), "ManagementRelationship", payload);
    const relationship = { schema: "memo.management-relationship/3", ...payload, signature: signed.signature, digest: signed.digest };
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO management_relationships VALUES (?, ?, ?, ?, 'ACTIVE', ?)").run(String(request.relationshipId), requestId, JSON.stringify(relationship), signed.signature, now());
      this.store.db.prepare("UPDATE management_requests SET state = 'ACCEPTED', updated_at = ? WHERE request_id = ?").run(now(), requestId);
    });
    return { ...relationship, state: "ACTIVE", localRegistry: true };
  }

  rejectManagement(requestId: string, reason: string): Record<string, unknown> {
    authorize("R2");
    const row = this.store.db.prepare("SELECT * FROM management_requests WHERE request_id = ?").get(requestId) as Row | undefined;
    if (!row) throw new AgentError("MANAGEMENT_REQUEST_NOT_FOUND", "Management request was not inspected");
    if (row.state === "ACCEPTED") throw new AgentError("MANAGEMENT_REQUEST_CHANGED", "An accepted request cannot be rejected");
    this.store.db.prepare("UPDATE management_requests SET state = 'REJECTED', updated_at = ? WHERE request_id = ?").run(now(), requestId);
    return { requestId, state: "REJECTED", reason };
  }

  operation(id: string): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(id) as Row | undefined;
    if (!row) throw new AgentError("OPERATION_NOT_FOUND", "Operation was not found");
    return { operationId: row.operation_id, actionType: row.action_type, digest: row.action_digest, state: row.state, data: JSON.parse(String(row.data_json)), updatedAt: row.updated_at };
  }

  async reconcileOperation(id: string): Promise<Record<string, unknown>> {
    const local = this.operation(id);
    const remote = await this.api(`/api/v1/operations/${encodeURIComponent(id)}`);
    this.store.db.prepare(`UPDATE operations SET tx_hash=?,block_number=?,block_hash=?,state=?,data_json=?,updated_at=? WHERE operation_id=?`)
      .run(String(remote.txHash || local.txHash || "") || null, remote.blockNumber == null ? null : Number(remote.blockNumber), String(remote.blockHash || "") || null, String(remote.state), JSON.stringify(remote), now(), id);
    return remote;
  }

  readJson(path: string): unknown {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content) > 65_536) throw new AgentError("INPUT_TOO_LARGE", "Input file exceeds 64 KiB");
    return JSON.parse(content) as unknown;
  }
}
