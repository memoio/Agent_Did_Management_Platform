import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Wallet, SigningKey, TypedDataEncoder } from "ethers";
import { Entry } from "@napi-rs/keyring";
import { CHAIN_ID, KEYRING_SERVICE, type Config } from "./config.js";
import { AgentError } from "./errors.js";

type Field = { name: string; type: string };

export const ACTION_REGISTRY: Record<string, Field[]> = {
  RegisterAgent: [
    { name: "identityAccount", type: "address" },
    { name: "identityPublicKeyHash", type: "bytes32" },
    { name: "documentHash", type: "bytes32" },
    { name: "profileHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  UpdateProfile: [
    { name: "identityAccount", type: "address" }, { name: "profileHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  UpdateDocument: [
    { name: "identityAccount", type: "address" }, { name: "documentHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  SuspendAgent: lifecycleFields(),
  ResumeAgent: lifecycleFields(),
  RevokeAgent: lifecycleFields(),
  DeclareSuccessor: [
    { name: "identityAccount", type: "address" }, { name: "successorDidHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  RevokeInstanceCredential: [
    { name: "identityAccount", type: "address" }, { name: "credentialIdHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  ActivateRelationship: [
    { name: "agent", type: "address" }, { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" }, { name: "scopesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
    { name: "discoverable", type: "bool" }, { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  RenewRelationship: [
    { name: "agent", type: "address" }, { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" }, { name: "scopesHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" }, { name: "discoverable", type: "bool" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  EndRelationship: [
    { name: "agent", type: "address" }, { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" }, { name: "actor", type: "address" },
    { name: "reasonHash", type: "bytes32" }, { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  TransferRelationship: [
    { name: "agent", type: "address" }, { name: "oldManager", type: "address" }, { name: "newManager", type: "address" },
    { name: "oldRelationshipIdHash", type: "bytes32" }, { name: "newRelationshipIdHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" }, { name: "expiresAt", type: "uint64" }, { name: "discoverable", type: "bool" },
    { name: "expectedRevision", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
  IssueInstance: [
    { name: "agentDid", type: "string" },
    { name: "instanceId", type: "string" },
    { name: "publicKey", type: "bytes" },
    { name: "audiencesHash", type: "bytes32" },
    { name: "actionsHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "identityRevision", type: "uint64" },
  ],
  AuthChallenge: [
    { name: "agentDid", type: "string" },
    { name: "instanceId", type: "string" },
    { name: "issuer", type: "string" },
    { name: "audience", type: "string" },
    { name: "action", type: "string" },
    { name: "nonceHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
  ManagementRequest: [
    { name: "requestId", type: "string" },
    { name: "relationshipId", type: "string" },
    { name: "agentDid", type: "string" },
    { name: "managerAccount", type: "string" },
    { name: "scopesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "termEndsAt", type: "uint64" },
    { name: "visibility", type: "string" },
    { name: "requestVersion", type: "uint64" },
    { name: "relationshipRevision", type: "uint64" },
    { name: "source", type: "string" },
  ],
  ManagementRelationship: [
    { name: "relationshipId", type: "string" },
    { name: "agentDid", type: "string" },
    { name: "managerAccount", type: "string" },
    { name: "scopesHash", type: "bytes32" },
    { name: "termEndsAt", type: "uint64" },
    { name: "visibility", type: "string" },
    { name: "relationshipRevision", type: "uint64" },
    { name: "requestVersion", type: "uint64" },
  ],
};

function lifecycleFields(): Field[] {
  return [
    { name: "identityAccount", type: "address" }, { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ];
}

export const TYPED_DOMAIN = { name: "MEMO Agent DID Offchain", version: "2", chainId: CHAIN_ID } as const;

interface EncryptedEntry {
  handle: string;
  kind: "identity" | "instance" | "secret";
  publicKey?: string;
  address?: string;
  salt?: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
}

interface LegacyKeyFile { version: 1; entries: EncryptedEntry[] }
interface CurrentKeyFile { version: 2; provider: "os-keyring" | "env-master-key"; wrappingKeyVersion: 1; entries: EncryptedEntry[] }
type KeyFile = LegacyKeyFile | CurrentKeyFile;

export interface SignerKms {
  readonly providerName: "os-keyring" | "env-master-key";
  ensureKey(kind: "identity" | "instance", handle: string): { handle: string; publicKey: string; address: string };
  createKey(kind: "identity" | "instance"): { handle: string; publicKey: string; address: string };
  putSecret(value: string): string;
  readSecret(handle: string): string;
  destroy(handle: string): void;
  getPublic(handle: string): { publicKey: string; address: string };
  signTypedAction(handle: string, actionType: string, payload: Record<string, unknown>, domain?: Record<string, unknown>): Promise<{ signature: string; digest: string; publicKey: string; address: string; auditId: string }>;
  signSessionChallenge(handle: string, message: string, expectedDid: string, expectedChallengeId: string): Promise<string>;
}

function masterKey(): string {
  const value = process.env.MEMO_AGENT_MAINNET_MASTER_KEY;
  if (!value || value.length < 32) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "MEMO_AGENT_MAINNET_MASTER_KEY must contain at least 32 characters");
  return value;
}

function encryptLegacy(value: string): Pick<EncryptedEntry, "salt" | "iv" | "tag" | "ciphertext"> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(masterKey(), salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

function decryptLegacy(entry: EncryptedEntry): string {
  try {
    if (!entry.salt) throw new Error("missing salt");
    const key = scryptSync(masterKey(), Buffer.from(entry.salt, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Unable to decrypt key store");
  }
}

function seal(value: string, key: Buffer): Pick<EncryptedEntry, "iv" | "tag" | "ciphertext"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

function open(entry: EncryptedEntry, key: Buffer): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Unable to decrypt key store");
  }
}

export class LocalKmsSigner implements SignerKms {
  constructor(private readonly config: Config) {}

  private keyringEntry(): Entry {
    const options = process.platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
    return new Entry(KEYRING_SERVICE, `${this.config.installationId}:wrapping-key:v1`, options);
  }

  keyringAvailable(): boolean {
    try { this.keyringEntry().getSecret(); return true; } catch { return false; }
  }

  private selectNewProvider(): "os-keyring" | "env-master-key" {
    if (this.config.keyProvider === "env-master-key") { masterKey(); return "env-master-key"; }
    if (this.keyringAvailable()) return "os-keyring";
    if (this.config.keyProvider === "auto" && process.env.MEMO_AGENT_MAINNET_MASTER_KEY) { masterKey(); return "env-master-key"; }
    throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "OS keyring is unavailable and no environment master key fallback is configured");
  }

  get providerName(): "os-keyring" | "env-master-key" {
    const file = this.readExisting();
    return file ? (file.version === 1 ? "env-master-key" : file.provider) : this.selectNewProvider();
  }

  secureStorageReady(): boolean {
    try {
      const file = this.readExisting();
      if (!file) { void this.selectNewProvider(); return true; }
      if (file.version === 1) { masterKey(); return true; }
      this.wrappingKey(file.provider, false);
      return true;
    } catch { return false; }
  }

  private wrappingKey(provider: "os-keyring" | "env-master-key", create: boolean): Buffer {
    if (provider === "env-master-key") return scryptSync(masterKey(), `memo-agent-mainnet:${this.config.installationId}:v2`, 32);
    try {
      const entry = this.keyringEntry();
      const existing = entry.getSecret();
      if (existing) return Buffer.from(existing);
      if (!create) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "The OS keyring wrapping key is missing");
      const generated = randomBytes(32);
      entry.setSecret(generated);
      const stored = entry.getSecret();
      if (!stored || !Buffer.from(stored).equals(generated)) throw new Error("keyring verification failed");
      return generated;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "OS keyring is locked or unavailable");
    }
  }

  private readExisting(): KeyFile | undefined {
    if (!existsSync(this.config.keyStorePath)) return undefined;
    const parsed = JSON.parse(readFileSync(this.config.keyStorePath, "utf8")) as KeyFile;
    if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.entries)) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Key store format is invalid");
    return parsed;
  }

  private read(): KeyFile {
    return this.readExisting() || { version: 2, provider: this.selectNewProvider(), wrappingKeyVersion: 1, entries: [] };
  }

  private write(file: KeyFile): void {
    const temporary = `${this.config.keyStorePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.keyStorePath);
    chmodSync(this.config.keyStorePath, 0o600);
  }

  private encryptFor(file: KeyFile, value: string): Pick<EncryptedEntry, "salt" | "iv" | "tag" | "ciphertext"> {
    return file.version === 1 ? encryptLegacy(value) : seal(value, this.wrappingKey(file.provider, !existsSync(this.config.keyStorePath)));
  }

  private decryptFrom(file: KeyFile, entry: EncryptedEntry): string {
    return file.version === 1 ? decryptLegacy(entry) : open(entry, this.wrappingKey(file.provider, false));
  }

  ensureKey(kind: "identity" | "instance", handle: string): { handle: string; publicKey: string; address: string } {
    const file = this.read();
    const existing = file.entries.find((entry) => entry.handle === handle);
    if (existing) {
      if (existing.kind !== kind || !existing.publicKey || !existing.address) throw new AgentError("KEY_NOT_FOUND", "Deterministic key handle is invalid");
      // Decrypt once so a missing/locked wrapping key fails before identity reuse.
      this.decryptFrom(file, existing);
      return { handle, publicKey: existing.publicKey, address: existing.address };
    }
    const wallet = Wallet.createRandom();
    const publicKey = SigningKey.computePublicKey(wallet.privateKey, true);
    const entry: EncryptedEntry = { handle, kind, publicKey, address: wallet.address.toLowerCase(), ...this.encryptFor(file, wallet.privateKey), createdAt: new Date().toISOString() };
    file.entries.push(entry);
    this.write(file);
    return { handle, publicKey, address: wallet.address.toLowerCase() };
  }

  createKey(kind: "identity" | "instance"): { handle: string; publicKey: string; address: string } {
    return this.ensureKey(kind, `${kind}_${randomUUID()}`);
  }

  putSecret(value: string): string {
    const handle = `secret_${randomUUID()}`;
    const file = this.read();
    file.entries.push({ handle, kind: "secret", ...this.encryptFor(file, value), createdAt: new Date().toISOString() });
    this.write(file);
    return handle;
  }

  readSecret(handle: string): string {
    const file = this.read();
    const entry = file.entries.find((item) => item.handle === handle && item.kind === "secret");
    if (!entry) throw new AgentError("KEY_NOT_FOUND", "Secret handle was not found");
    return this.decryptFrom(file, entry);
  }

  destroy(handle: string): void {
    const file = this.read();
    const length = file.entries.length;
    file.entries = file.entries.filter((entry) => entry.handle !== handle);
    if (file.entries.length === length) throw new AgentError("KEY_NOT_FOUND", "Key handle was not found");
    this.write(file);
  }

  getPublic(handle: string): { publicKey: string; address: string } {
    const file = this.read();
    const entry = file.entries.find((item) => item.handle === handle && item.kind !== "secret");
    if (!entry?.publicKey || !entry.address) throw new AgentError("KEY_NOT_FOUND", "Key handle was not found");
    this.decryptFrom(file, entry);
    return { publicKey: entry.publicKey, address: entry.address };
  }

  migrateToOsKeyring(): { from: string; to: "os-keyring"; migratedEntries: number } {
    const source = this.read();
    if (source.version === 2 && source.provider === "os-keyring") return { from: "os-keyring", to: "os-keyring", migratedEntries: 0 };
    if (!this.keyringAvailable()) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "OS keyring is unavailable");
    const plaintext = source.entries.map((entry) => ({ entry, value: this.decryptFrom(source, entry) }));
    const target: CurrentKeyFile = { version: 2, provider: "os-keyring", wrappingKeyVersion: 1, entries: [] };
    const key = this.wrappingKey("os-keyring", true);
    target.entries = plaintext.map(({ entry, value }) => ({
      handle: entry.handle, kind: entry.kind, publicKey: entry.publicKey, address: entry.address,
      ...seal(value, key), createdAt: entry.createdAt,
    }));
    this.write(target);
    return { from: source.version === 1 ? "encrypted-file-v1" : source.provider, to: "os-keyring", migratedEntries: target.entries.length };
  }

  async signTypedAction(
    handle: string,
    actionType: string,
    payload: Record<string, unknown>,
    domain: Record<string, unknown> = TYPED_DOMAIN,
  ): Promise<{ signature: string; digest: string; publicKey: string; address: string; auditId: string }> {
    const fields = ACTION_REGISTRY[actionType];
    if (!fields) throw new AgentError("UNSUPPORTED_ACTION", `Action is not registered: ${actionType}`);
    const expected = fields.map((field) => field.name).sort();
    const actual = Object.keys(payload).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new AgentError("UNSUPPORTED_SIGNED_FIELD", "Typed action fields do not match the registry");
    const file = this.read();
    const entry = file.entries.find((item) => item.handle === handle && item.kind !== "secret");
    if (!entry?.publicKey || !entry.address) throw new AgentError("KEY_NOT_FOUND", "Key handle was not found");
    const wallet = new Wallet(this.decryptFrom(file, entry));
    const types = { [actionType]: fields };
    if (domain.verifyingContract === "0x0000000000000000000000000000000000000000") throw new AgentError("INVALID_SIGNING_DOMAIN", "Zero verifyingContract is forbidden");
    const digest = TypedDataEncoder.hash(domain, types, payload);
    const signature = await wallet.signTypedData(domain, types, payload);
    return { signature, digest, publicKey: entry.publicKey, address: entry.address, auditId: `audit_${randomUUID()}` };
  }

  async signSessionChallenge(
    handle: string,
    message: string,
    expectedDid: string,
    expectedChallengeId: string,
  ): Promise<string> {
    const lines = message.split("\n");
    const fields = new Map(lines.slice(1).map((line) => {
      const separator = line.indexOf(": ");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 2)];
    }));
    if (lines.length !== 8
      || lines[0] !== "MEMO Agent DID Mainnet session"
      || fields.get("DID") !== expectedDid
      || fields.get("Chain ID") !== String(CHAIN_ID)
      || fields.get("Challenge") !== expectedChallengeId
      || !/^ach_[A-Za-z0-9-]+$/.test(fields.get("Challenge") || "")
      || !/^[A-Za-z0-9_-]{32,}$/.test(fields.get("Nonce") || "")) {
      throw new AgentError("INVALID_SESSION_CHALLENGE", "The platform returned an unexpected Agent session challenge");
    }
    const publicEntry = this.getPublic(handle);
    if ((fields.get("Address") || "").toLowerCase() !== publicEntry.address.toLowerCase()) {
      throw new AgentError("DID_KEY_MISMATCH", "The Agent session challenge targets another identity key");
    }
    const issuedAt = Date.parse(fields.get("Issued At") || "");
    const expiresAt = Date.parse(fields.get("Expires At") || "");
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now() || issuedAt > Date.now() + 60_000
      || expiresAt - issuedAt > 5 * 60_000 + 5_000) {
      throw new AgentError("INVALID_SESSION_CHALLENGE", "The Agent session challenge time window is invalid");
    }
    const file = this.read();
    const entry = file.entries.find((item) => item.handle === handle && item.kind === "identity");
    if (!entry) throw new AgentError("KEY_NOT_FOUND", "Identity key handle was not found");
    const wallet = new Wallet(this.decryptFrom(file, entry));
    return wallet.signMessage(message);
  }
}

/** @deprecated Use LocalKmsSigner. Kept for source compatibility with 0.2 clients. */
export class EncryptedFileSigner extends LocalKmsSigner {}
