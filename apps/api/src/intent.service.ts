import { Injectable } from "@nestjs/common";
import { Contract, Interface, JsonRpcProvider, getAddress, isAddress } from "ethers";
import { randomUUID } from "node:crypto";
import {
  CHAIN_ID,
  DID_ACTION_TYPES,
  ENTRY_POINT_V07,
  MANAGEMENT_ACTION_TYPES,
  actionTypes,
  addressFromDid,
  didDomain,
  digestTypedAction,
  hashText,
  managementDomain,
  nonZeroAddress,
  nowSeconds,
  recoverTypedActionSigner,
  sha256Canonical,
  type ActionIntent,
  type ActionType,
  type DidActionType,
  type ManagementActionType,
  type TypedDomain,
} from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";
import { ChainStore, type StoreRow } from "./store.service.js";
import { ContentAddressedObjectStore } from "./object-store.service.js";
import type { Principal } from "./session.service.js";

const DID_READER_ABI = [
  "function nonces(address) view returns (uint256)",
  "function recordOf(address) view returns (address identityAccount,bytes32 identityPublicKeyHash,bytes32 documentHash,bytes32 profileHash,uint64 revision,uint8 status,bytes32 successorDidHash)",
];
const MANAGEMENT_READER_ABI = [
  "function nonces(address) view returns (uint256)",
  "function relationshipOf(address) view returns ((bytes32 relationshipIdHash,address manager,bytes32 scopesHash,uint64 issuedAt,uint64 expiresAt,uint64 revision,bool discoverable,uint8 status),bool live)",
];
const ERC1271 = new Interface(["function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)"]);
const ERC1271_MAGIC = "0x1626ba7e";
const REGISTRY_INPUT_FIELDS: Record<Exclude<DidActionType, "RegisterAgent">, string[]> = {
  UpdateProfile: ["actionType", "identityAccount", "profile"],
  UpdateDocument: ["actionType", "identityAccount", "document"],
  SuspendAgent: ["actionType", "identityAccount"],
  ResumeAgent: ["actionType", "identityAccount"],
  RevokeAgent: ["actionType", "identityAccount"],
  DeclareSuccessor: ["actionType", "identityAccount", "successorDid"],
  RevokeInstanceCredential: ["actionType", "identityAccount", "credentialId"],
};
const MANAGEMENT_INPUT_FIELDS: Record<ManagementActionType, string[]> = {
  ActivateRelationship: [
    "actionType", "agentDid", "managerAccount", "relationshipId", "managementScopes",
    "issuedAt", "expiresAt", "visibility",
  ],
  RenewRelationship: [
    "actionType", "agentDid", "managerAccount", "managementScopes", "expiresAt", "visibility",
  ],
  EndRelationship: ["actionType", "agentDid", "managerAccount", "actor", "reason"],
  TransferRelationship: [
    "actionType", "agentDid", "managerAccount", "newManager", "newRelationshipId",
    "managementScopes", "expiresAt", "visibility",
  ],
};

@Injectable()
export class IntentService {
  private readonly provider: JsonRpcProvider;
  private readonly didRegistry: Contract;
  private readonly managementRegistry: Contract;

  constructor(
    private readonly config: RuntimeConfigService,
    private readonly store: ChainStore,
    private readonly objects: ContentAddressedObjectStore,
  ) {
    this.provider = new JsonRpcProvider(config.value.primaryRpcUrl, CHAIN_ID, { staticNetwork: true });
    this.didRegistry = new Contract(config.value.manifest.didRegistry.address, DID_READER_ABI, this.provider);
    this.managementRegistry = new Contract(config.value.manifest.managementRegistry.address, MANAGEMENT_READER_ABI, this.provider);
  }

  async createRegistration(principal: Principal, input: Record<string, unknown>): Promise<ActionIntent> {
    if (principal.kind !== "agent") throw new Error("AGENT_SESSION_REQUIRED");
    exact(input, ["identityAccount", "identityPublicKeyHash", "document", "profile"]);
    const identityAccount = nonZeroAddress(asString(input.identityAccount, "identityAccount"));
    if (principal.subject !== "did:memo:agent:985:" + identityAccount.toLowerCase()) throw new Error("SESSION_DID_MISMATCH");
    const [nonce, record, latestBlock] = await Promise.all([
      this.didRegistry.getFunction("nonces").staticCall(identityAccount) as Promise<bigint>,
      this.didRegistry.getFunction("recordOf").staticCall(identityAccount) as Promise<{ revision: bigint; status: bigint }>,
      this.provider.getBlock("latest"),
    ]);
    if (!latestBlock) throw new Error("CHAIN_HEAD_UNAVAILABLE");
    if (Number(record.status) !== 0 || Number(record.revision) !== 0) throw new Error("IDENTITY_ALREADY_REGISTERED");
    const profile = asObject(input.profile, "profile");
    const document = asObject(input.document, "document");
    const profileHash = this.objects.put(profile);
    const documentHash = this.objects.put(document);
    const publicKeyHash = bytes32(input.identityPublicKeyHash, "identityPublicKeyHash");
    return this.buildAndSave(
      principal,
      "RegisterAgent",
      didDomain(this.config.value.manifest.didRegistry.address),
      {
        identityAccount,
        identityPublicKeyHash: publicKeyHash,
        documentHash,
        profileHash,
        expectedRevision: "0",
        nonce: nonce.toString(),
        deadline: String(intentDeadline(latestBlock.timestamp)),
      },
    );
  }

  async createRegistryAction(principal: Principal, input: Record<string, unknown>): Promise<ActionIntent> {
    if (principal.kind !== "agent") throw new Error("AGENT_SESSION_REQUIRED");
    const actionType = asString(input.actionType, "actionType") as DidActionType;
    if (!(actionType in DID_ACTION_TYPES) || actionType === "RegisterAgent") throw new Error("INVALID_DID_ACTION");
    exact(input, REGISTRY_INPUT_FIELDS[actionType]);
    const identityAccount = addressFromDid(principal.subject);
    if (input.identityAccount && getAddress(asString(input.identityAccount, "identityAccount")) !== identityAccount) {
      throw new Error("SESSION_DID_MISMATCH");
    }
    const [nonce, record, latestBlock] = await Promise.all([
      this.didRegistry.getFunction("nonces").staticCall(identityAccount) as Promise<bigint>,
      this.didRegistry.getFunction("recordOf").staticCall(identityAccount) as Promise<{ revision: bigint; status: bigint }>,
      this.provider.getBlock("latest"),
    ]);
    if (!latestBlock) throw new Error("CHAIN_HEAD_UNAVAILABLE");
    if (Number(record.status) === 0) throw new Error("IDENTITY_NOT_REGISTERED");
    const message: Record<string, unknown> = {
      identityAccount,
      expectedRevision: record.revision.toString(),
      nonce: nonce.toString(),
      deadline: String(intentDeadline(latestBlock.timestamp)),
    };
    if (actionType === "UpdateProfile") {
      const content = asObject(input.profile, "profile");
      message.profileHash = this.objects.put(content);
    } else if (actionType === "UpdateDocument") {
      const content = asObject(input.document, "document");
      message.documentHash = this.objects.put(content);
    } else if (actionType === "DeclareSuccessor") {
      message.successorDidHash = hashText(asString(input.successorDid, "successorDid"));
    } else if (actionType === "RevokeInstanceCredential") {
      message.credentialIdHash = hashText(asString(input.credentialId, "credentialId"));
    }
    return this.buildAndSave(
      principal,
      actionType,
      didDomain(this.config.value.manifest.didRegistry.address),
      message,
    );
  }

  async createManagementAction(principal: Principal, input: Record<string, unknown>): Promise<ActionIntent> {
    if (principal.kind !== "wallet") throw new Error("WALLET_SESSION_REQUIRED");
    const actionType = asString(input.actionType, "actionType") as ManagementActionType;
    if (!(actionType in MANAGEMENT_ACTION_TYPES)) throw new Error("INVALID_MANAGEMENT_ACTION");
    exact(input, MANAGEMENT_INPUT_FIELDS[actionType]);
    const agentDid = asString(input.agentDid, "agentDid");
    if (this.store.agentTenant(agentDid) !== principal.tenantId) throw new Error("TENANT_AGENT_ACCESS_DENIED");
    const binding = this.store.agentBinding(agentDid, principal.tenantId);
    if (!binding) throw new Error("TENANT_AGENT_ACCESS_DENIED");
    const agent = addressFromDid(agentDid);
    const [nonce, relationResult, latestBlock] = await Promise.all([
      this.managementRegistry.getFunction("nonces").staticCall(agent) as Promise<bigint>,
      this.managementRegistry.getFunction("relationshipOf").staticCall(agent) as Promise<[{ relationshipIdHash: string; manager: string; revision: bigint }, boolean]>,
      this.provider.getBlock("latest"),
    ]);
    if (!latestBlock) throw new Error("CHAIN_HEAD_UNAVAILABLE");
    const relationship = relationResult[0];
    const currentRevision = relationship.revision;
    const chainNow = latestBlock.timestamp;
    const deadline = String(intentDeadline(chainNow));
    const manager = accountAddress(input.managerAccount || principal.subject);
    // The wallet session is the tenant/operator boundary. The on-chain Manager may
    // be a different EOA or an ERC-1271 smart wallet; its authority is established
    // by the action signature below, not by equating it with the login account.
    let message: Record<string, unknown>;
    if (actionType === "ActivateRelationship") {
      const issuedAt = integer(input.issuedAt ?? chainNow, "issuedAt");
      if (issuedAt > chainNow) throw new Error("ISSUED_AT_IN_FUTURE");
      const expiresAt = integer(input.expiresAt, "expiresAt");
      validateTerm(issuedAt, expiresAt);
      const scopes = stringArray(input.managementScopes, "managementScopes");
      assertPairingBounds(binding, scopes, expiresAt - issuedAt);
      message = {
        agent,
        manager,
        relationshipIdHash: hashText(asString(input.relationshipId, "relationshipId")),
        scopesHash: sha256Canonical(scopes),
        issuedAt: String(issuedAt),
        expiresAt: String(expiresAt),
        discoverable: visibility(input.visibility) === "public",
        expectedRevision: currentRevision.toString(),
        nonce: nonce.toString(),
        deadline,
      };
    } else if (actionType === "RenewRelationship") {
      const expiresAt = integer(input.expiresAt, "expiresAt");
      validateTerm(chainNow, expiresAt);
      const scopes = stringArray(input.managementScopes, "managementScopes");
      assertPairingBounds(binding, scopes, expiresAt - chainNow);
      message = {
        agent,
        manager,
        relationshipIdHash: relationship.relationshipIdHash,
        scopesHash: sha256Canonical(scopes),
        expiresAt: String(expiresAt),
        discoverable: visibility(input.visibility) === "public",
        expectedRevision: currentRevision.toString(),
        nonce: nonce.toString(),
        deadline,
      };
    } else if (actionType === "EndRelationship") {
      const actor = accountAddress(input.actor || principal.subject);
      message = {
        agent,
        manager: getAddress(relationship.manager),
        relationshipIdHash: relationship.relationshipIdHash,
        actor,
        reasonHash: hashText(asString(input.reason || "ended", "reason")),
        expectedRevision: currentRevision.toString(),
        nonce: nonce.toString(),
        deadline,
      };
    } else {
      const expiresAt = integer(input.expiresAt, "expiresAt");
      validateTerm(chainNow, expiresAt);
      const scopes = stringArray(input.managementScopes, "managementScopes");
      assertPairingBounds(binding, scopes, expiresAt - chainNow);
      message = {
        agent,
        oldManager: getAddress(relationship.manager),
        newManager: nonZeroAddress(asString(input.newManager, "newManager")),
        oldRelationshipIdHash: relationship.relationshipIdHash,
        newRelationshipIdHash: hashText(asString(input.newRelationshipId, "newRelationshipId")),
        scopesHash: sha256Canonical(scopes),
        expiresAt: String(expiresAt),
        discoverable: visibility(input.visibility) === "public",
        expectedRevision: currentRevision.toString(),
        nonce: nonce.toString(),
        deadline,
      };
    }
    return this.buildAndSave(
      principal,
      actionType,
      managementDomain(this.config.value.manifest.managementRegistry.address),
      message,
    );
  }

  async submit(
    principal: Principal,
    input: { intentId: string; signature?: string; signatures?: Record<string, string>; idempotencyKey: string },
  ) {
    const row = this.store.intent(input.intentId);
    if (!row || String(row.tenant_id) !== principal.tenantId) throw new Error("INTENT_NOT_FOUND");
    if (Number(row.expires_at) <= Date.now()) throw new Error("INTENT_EXPIRED");
    const actionType = String(row.action_type) as ActionType;
    const domain = JSON.parse(String(row.domain_json)) as TypedDomain;
    const message = JSON.parse(String(row.message_json)) as Record<string, unknown>;
    const digest = digestTypedAction(domain, actionType, message);
    if (digest !== row.digest) throw new Error("PERSISTED_INTENT_DIGEST_MISMATCH");
    if (input.idempotencyKey !== digest) throw new Error("IDEMPOTENCY_KEY_MUST_EQUAL_DIGEST");
    const signatures = input.signatures || (input.signature ? { agentSignature: input.signature } : {});
    await this.verifySignatures(actionType, domain, message, signatures);
    return this.store.createOperation({
      tenantId: principal.tenantId,
      intentId: input.intentId,
      actionType,
      digest,
      idempotencyKey: input.idempotencyKey,
      signatures,
      entryPoint: ENTRY_POINT_V07,
      smartAccount: this.config.value.manifest.relayerSmartAccount.address,
      requiredConfirmations: this.config.value.requiredConfirmations,
    });
  }

  async assertManagerProofForQueue(intentId: string, signatures: Record<string, string>): Promise<void> {
    const row = this.store.intent(intentId);
    if (!row) throw new Error("INTENT_NOT_FOUND");
    if (Number(row.expires_at) <= Date.now()) throw new Error("INTENT_EXPIRED");
    const actionType = String(row.action_type) as ManagementActionType;
    if (!(actionType in MANAGEMENT_ACTION_TYPES)) throw new Error("INVALID_MANAGEMENT_ACTION");
    const domain = JSON.parse(String(row.domain_json)) as TypedDomain;
    const message = JSON.parse(String(row.message_json)) as Record<string, unknown>;
    if (actionType === "ActivateRelationship" || actionType === "RenewRelationship") {
      await this.assertManagerSignature(domain, actionType, message, signatures.managerSignature, String(message.manager));
      return;
    }
    if (actionType === "TransferRelationship") {
      await this.assertManagerSignature(domain, actionType, message, signatures.oldManagerSignature, String(message.oldManager));
      await this.assertManagerSignature(domain, actionType, message, signatures.newManagerSignature, String(message.newManager));
      return;
    }
    if (getAddress(String(message.actor)) !== getAddress(String(message.agent))) {
      await this.assertManagerSignature(domain, actionType, message, signatures.actorSignature, String(message.actor));
    }
  }

  private buildAndSave(
    principal: Principal,
    actionType: ActionType,
    domain: TypedDomain,
    message: Record<string, unknown>,
  ): ActionIntent {
    const digest = digestTypedAction(domain, actionType, message);
    const intent: ActionIntent = {
      intentId: "int_" + randomUUID(),
      actionType,
      domain,
      types: actionTypes(actionType),
      primaryType: actionType,
      message,
      digest,
      nonce: String(message.nonce),
      expectedRevision: Number(message.expectedRevision),
      expiresAt: new Date(Number(message.deadline) * 1000).toISOString(),
    };
    this.store.saveIntent(intent, principal.tenantId, principal.subject);
    return intent;
  }

  private async verifySignatures(
    actionType: ActionType,
    domain: TypedDomain,
    message: Record<string, unknown>,
    signatures: Record<string, string>,
  ): Promise<void> {
    if (actionType in DID_ACTION_TYPES) {
      assertRecovered(domain, actionType, message, signatures.agentSignature, String(message.identityAccount));
      return;
    }
    const agent = String(message.agent);
    if (actionType === "ActivateRelationship" || actionType === "RenewRelationship") {
      assertRecovered(domain, actionType, message, signatures.agentSignature, agent);
      await this.assertManagerSignature(domain, actionType, message, signatures.managerSignature, String(message.manager));
    } else if (actionType === "EndRelationship") {
      const actor = String(message.actor);
      if (getAddress(actor) === getAddress(agent)) {
        assertRecovered(domain, actionType, message, signatures.actorSignature || signatures.agentSignature, agent);
      } else {
        await this.assertManagerSignature(domain, actionType, message, signatures.actorSignature || signatures.managerSignature, actor);
      }
    } else {
      assertRecovered(domain, actionType, message, signatures.agentSignature, agent);
      await this.assertManagerSignature(domain, actionType, message, signatures.oldManagerSignature, String(message.oldManager));
      await this.assertManagerSignature(domain, actionType, message, signatures.newManagerSignature, String(message.newManager));
    }
  }

  private async assertManagerSignature(
    domain: TypedDomain,
    actionType: ActionType,
    message: Record<string, unknown>,
    signature: string | undefined,
    expected: string,
  ): Promise<void> {
    if (!signature) throw new Error("MISSING_MANAGER_SIGNATURE");
    const account = nonZeroAddress(expected);
    const code = await this.provider.getCode(account);
    if (code === "0x") {
      assertRecovered(domain, actionType, message, signature, account);
      return;
    }
    const digest = digestTypedAction(domain, actionType, message);
    const result = await this.provider.call({
      to: account,
      data: ERC1271.encodeFunctionData("isValidSignature", [digest, signature]),
    });
    const magic = ERC1271.decodeFunctionResult("isValidSignature", result)[0] as string;
    if (magic.toLowerCase() !== ERC1271_MAGIC) throw new Error("INVALID_ERC1271_SIGNATURE");
  }
}

function assertRecovered(
  domain: TypedDomain,
  actionType: ActionType,
  message: Record<string, unknown>,
  signature: string | undefined,
  expected: string,
): void {
  if (!signature) throw new Error("MISSING_AGENT_SIGNATURE");
  if (recoverTypedActionSigner(domain, actionType, message, signature) !== getAddress(expected)) {
    throw new Error("SIGNATURE_SIGNER_MISMATCH");
  }
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("UNKNOWN_INPUT_FIELD");
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_" + name.toUpperCase());
  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error("INVALID_" + name.toUpperCase());
  return value;
}

function bytes32(value: unknown, name: string): string {
  const text = asString(value, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error("INVALID_" + name.toUpperCase());
  return text.toLowerCase();
}

function accountAddress(value: unknown): string {
  const text = asString(value, "account");
  const address = text.startsWith("eip155:985:") ? text.slice("eip155:985:".length) : text;
  if (!isAddress(address)) throw new Error("INVALID_ACCOUNT");
  return getAddress(address);
}

function integer(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("INVALID_" + name.toUpperCase());
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("INVALID_" + name.toUpperCase());
  const result = [...new Set(value.map((item) => asString(item, name)).sort())];
  return result;
}

function visibility(value: unknown): "public" | "private" {
  const result = asString(value, "visibility");
  if (result !== "public" && result !== "private") throw new Error("INVALID_VISIBILITY");
  return result;
}

function assertPairingBounds(binding: StoreRow, scopes: string[], termSeconds: number): void {
  const allowed = new Set(JSON.parse(String(binding.max_scopes_json)) as string[]);
  if (scopes.some((scope) => !allowed.has(scope))) throw new Error("PAIRING_SCOPE_EXCEEDED");
  if (termSeconds > Number(binding.max_term_seconds)) throw new Error("PAIRING_TERM_EXCEEDED");
}

function validateTerm(issuedAt: number, expiresAt: number): void {
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 365 * 24 * 60 * 60) throw new Error("INVALID_RELATIONSHIP_TERM");
}

function intentDeadline(chainTimestamp: number): number {
  return Math.max(nowSeconds(), chainTimestamp) + 600;
}
