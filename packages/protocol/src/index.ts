import {
  TypedDataEncoder,
  getAddress,
  isAddress,
  keccak256,
  sha256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

export const CHAIN_ID = 985 as const;
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
export const ENTRY_POINT_V07_RUNTIME_CODE_HASH =
  "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58" as const;
export const IDENTITY_PROTOCOL_VERSION = "memo-agent-did/2" as const;
export const MANAGEMENT_PROTOCOL_VERSION = "memo-agent-management/4" as const;
export const PAIRING_PROTOCOL_VERSION = "memo-agent-pairing/2" as const;
export const PAIRING_PACKAGE_SCHEMA = "memo.agent-pairing-package/2" as const;
export const DEFAULT_CONFIRMATIONS = 12;
export const DEFAULT_INTENT_TTL_SECONDS = 600;
export const MAX_MANAGEMENT_TERM_SECONDS = 365 * 24 * 60 * 60;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type Environment = "local" | "preprod" | "production";
export type FinalitySource = "finalized-tag" | "confirmations";
export type BundlerState = "accepted" | "included" | "dropped";
export type PairingKind = "platform-invitation" | "agent-offer";
export type PairingState =
  | "CREATED"
  | "CLAIMED"
  | "REGISTRATION_PENDING"
  | "PAIRED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";
export type ManagementDraftState =
  | "AWAITING_WALLET_SIGNATURE"
  | "WAITING_AGENT"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FROZEN_REORG"
  | "REJECTED"
  | "EXPIRED";

export interface PairingPackageV2 {
  schema: typeof PAIRING_PACKAGE_SCHEMA;
  kind: PairingKind;
  exchangeId: string;
  platformOrigin: string;
  environment: Environment;
  chainId: typeof CHAIN_ID;
  didRegistry: string;
  managementRegistry: string;
  handle: string;
  issuedAt: string;
  expiresAt: string;
  managerAccount?: string;
  agentDid?: string;
  identityAccount?: string;
  profileHash?: string;
  requestedScopes?: string[];
  requestedTermSeconds?: number;
  visibility?: "private" | "public";
  maxScopes?: string[];
  maxTermSeconds?: number;
}

export interface PairingExchangeView {
  exchangeId: string;
  kind: PairingKind;
  state: PairingState;
  agentDid?: string;
  identityAccount?: string;
  profileHash?: string;
  managerAccount?: string;
  maxScopes: string[];
  maxTermSeconds: number;
  requestedScopes: string[];
  requestedTermSeconds: number;
  visibility: "private" | "public";
  issuedAt: string;
  expiresAt: string;
  completionDeadline?: string;
  bindingId?: string;
  managementDraftId?: string;
}
export type OperationState =
  | "CREATED"
  | "SIGNED"
  | "SUBMITTED"
  | "INCLUDED"
  | "CONFIRMED"
  | "REORGED"
  | "FAILED";

export interface FinalityPolicy {
  preferFinalizedTag: boolean;
  fallbackConfirmations: number;
}

export interface DeploymentManifest {
  schema: "memo.agent-did-deployment/1";
  environment: Environment;
  networkName: string;
  chainId: 985;
  publicRpcUrl: string;
  publicWssUrl?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  entryPoint: { address: string; version: "0.7"; runtimeCodeHash: string };
  simpleAccountFactory: { address: string; deploymentBlock: number; runtimeCodeHash: string };
  relayerSmartAccount: {
    address: string;
    ownerAddress: string;
    ownerProvider: "dev-private-key" | "kms" | "hsm";
    runtimeCodeHash: string;
  };
  didRegistry: { address: string; deploymentBlock: number; runtimeCodeHash: string; abiHash: string };
  managementRegistry: { address: string; deploymentBlock: number; runtimeCodeHash: string; abiHash: string };
  finality: FinalityPolicy;
  generatedAt: string;
}

function lifecycleFields() {
  return [
    { name: "identityAccount", type: "address" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ] as const;
}

export const DID_ACTION_TYPES = {
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
    { name: "identityAccount", type: "address" },
    { name: "profileHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  UpdateDocument: [
    { name: "identityAccount", type: "address" },
    { name: "documentHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  SuspendAgent: lifecycleFields(),
  ResumeAgent: lifecycleFields(),
  RevokeAgent: lifecycleFields(),
  DeclareSuccessor: [
    { name: "identityAccount", type: "address" },
    { name: "successorDidHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  RevokeInstanceCredential: [
    { name: "identityAccount", type: "address" },
    { name: "credentialIdHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const MANAGEMENT_ACTION_TYPES = {
  ActivateRelationship: [
    { name: "agent", type: "address" },
    { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "discoverable", type: "bool" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  RenewRelationship: [
    { name: "agent", type: "address" },
    { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "discoverable", type: "bool" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  EndRelationship: [
    { name: "agent", type: "address" },
    { name: "manager", type: "address" },
    { name: "relationshipIdHash", type: "bytes32" },
    { name: "actor", type: "address" },
    { name: "reasonHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  TransferRelationship: [
    { name: "agent", type: "address" },
    { name: "oldManager", type: "address" },
    { name: "newManager", type: "address" },
    { name: "oldRelationshipIdHash", type: "bytes32" },
    { name: "newRelationshipIdHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "discoverable", type: "bool" },
    { name: "expectedRevision", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export type DidActionType = keyof typeof DID_ACTION_TYPES;
export type ManagementActionType = keyof typeof MANAGEMENT_ACTION_TYPES;
export type ActionType = DidActionType | ManagementActionType;
export type TypedField = { name: string; type: string };
export type TypedDomain = { name: string; version: "1"; chainId: 985; verifyingContract: string };

export interface ActionIntent {
  intentId: string;
  actionType: ActionType;
  domain: TypedDomain;
  types: Record<string, readonly TypedField[]>;
  primaryType: ActionType;
  message: Record<string, unknown>;
  digest: string;
  nonce: string;
  expectedRevision: number;
  expiresAt: string;
}

export interface OperationView {
  operationId: string;
  tenantId: string;
  actionType: ActionType;
  digest: string;
  state: OperationState;
  userOpHash?: string;
  entryPoint: string;
  relayerSmartAccount: string;
  bundlerState?: BundlerState;
  txHash?: string;
  blockNumber?: number;
  blockHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  finalitySource?: FinalitySource;
  actualGasUsed?: string;
  actualGasCost?: string;
  resultingRevision?: number;
  errorCode?: string;
  errorMessage?: string;
}

const TRANSITIONS: Record<OperationState, ReadonlySet<OperationState>> = {
  CREATED: new Set(["SIGNED", "FAILED"]),
  SIGNED: new Set(["SUBMITTED", "FAILED"]),
  SUBMITTED: new Set(["INCLUDED", "FAILED", "REORGED"]),
  INCLUDED: new Set(["CONFIRMED", "REORGED", "FAILED"]),
  CONFIRMED: new Set(["REORGED"]),
  REORGED: new Set(["SUBMITTED", "FAILED"]),
  FAILED: new Set(),
};

export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!TRANSITIONS[from].has(to)) throw new Error("INVALID_OPERATION_TRANSITION:" + from + "->" + to);
}

export function didDomain(registryAddress: string): TypedDomain {
  return {
    name: "MEMO Agent DID Registry",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: nonZeroAddress(registryAddress),
  };
}

export function managementDomain(registryAddress: string): TypedDomain {
  return {
    name: "MEMO Agent DID Management",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: nonZeroAddress(registryAddress),
  };
}

export function actionTypes(actionType: ActionType): Record<string, TypedField[]> {
  if (actionType in DID_ACTION_TYPES) return { [actionType]: [...DID_ACTION_TYPES[actionType as DidActionType]] };
  return { [actionType]: [...MANAGEMENT_ACTION_TYPES[actionType as ManagementActionType]] };
}

export function assertExactMessage(actionType: ActionType, message: Record<string, unknown>): void {
  const expected = actionTypes(actionType)[actionType]!.map((field) => field.name).sort();
  const received = Object.keys(message).sort();
  if (expected.length !== received.length || expected.some((key, index) => key !== received[index])) {
    throw new Error("UNKNOWN_OR_MISSING_SIGNED_FIELD:" + actionType);
  }
}

export function digestTypedAction(
  domain: TypedDomain,
  actionType: ActionType,
  message: Record<string, unknown>,
): string {
  assertDomain(domain, actionType);
  assertExactMessage(actionType, message);
  return TypedDataEncoder.hash(domain, actionTypes(actionType), message);
}

export function recoverTypedActionSigner(
  domain: TypedDomain,
  actionType: ActionType,
  message: Record<string, unknown>,
  signature: string,
): string {
  assertExactMessage(actionType, message);
  return getAddress(verifyTypedData(domain, actionTypes(actionType), message, signature));
}

export function assertDomain(domain: TypedDomain, actionType: ActionType): void {
  const expectedName = actionType in DID_ACTION_TYPES ? "MEMO Agent DID Registry" : "MEMO Agent DID Management";
  if (domain.chainId !== CHAIN_ID || domain.version !== "1" || domain.name !== expectedName) {
    throw new Error("INVALID_EIP712_DOMAIN");
  }
  nonZeroAddress(domain.verifyingContract);
}

export function didForAddress(address: string): string {
  return "did:memo:agent:" + CHAIN_ID + ":" + getAddress(address).toLowerCase();
}

export function addressFromDid(did: string): string {
  const match = /^did:memo:agent:985:(0x[0-9a-fA-F]{40})$/.exec(did);
  if (!match) throw new Error("INVALID_AGENT_DID");
  return getAddress(match[1]!);
}

export function nonZeroAddress(value: string): string {
  if (!isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) throw new Error("INVALID_NONZERO_ADDRESS");
  return getAddress(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("NON_CANONICAL_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
  }
  throw new Error("NON_CANONICAL_JSON_VALUE");
}

export function sha256Canonical(value: unknown): string {
  return sha256(toUtf8Bytes(canonicalJson(value)));
}

export function hashText(value: string): string {
  return keccak256(toUtf8Bytes(value));
}

export function assertDeploymentManifest(value: unknown): DeploymentManifest {
  if (!value || typeof value !== "object") throw new Error("INVALID_DEPLOYMENT_MANIFEST");
  const manifest = value as DeploymentManifest;
  if (manifest.schema !== "memo.agent-did-deployment/1" || manifest.chainId !== CHAIN_ID) {
    throw new Error("INVALID_DEPLOYMENT_NETWORK");
  }
  if (!["local", "preprod", "production"].includes(manifest.environment)) {
    throw new Error("INVALID_DEPLOYMENT_ENVIRONMENT");
  }
  if (manifest.entryPoint.version !== "0.7" || getAddress(manifest.entryPoint.address) !== getAddress(ENTRY_POINT_V07)) {
    throw new Error("INVALID_ENTRYPOINT_VERSION_OR_ADDRESS");
  }
  for (const address of [
    manifest.simpleAccountFactory.address,
    manifest.relayerSmartAccount.address,
    manifest.relayerSmartAccount.ownerAddress,
    manifest.didRegistry.address,
    manifest.managementRegistry.address,
  ]) nonZeroAddress(address);
  for (const hash of [
    manifest.entryPoint.runtimeCodeHash,
    manifest.simpleAccountFactory.runtimeCodeHash,
    manifest.relayerSmartAccount.runtimeCodeHash,
    manifest.didRegistry.runtimeCodeHash,
    manifest.managementRegistry.runtimeCodeHash,
  ]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("INVALID_RUNTIME_CODE_HASH");
  }
  if (manifest.entryPoint.runtimeCodeHash.toLowerCase() !== ENTRY_POINT_V07_RUNTIME_CODE_HASH) {
    throw new Error("ENTRYPOINT_CODE_HASH_MISMATCH");
  }
  if (manifest.environment !== "local") {
    if (!/^https:\/\//.test(manifest.publicRpcUrl) || !manifest.publicWssUrl?.startsWith("wss://")) {
      throw new Error("INCOMPLETE_PRODUCTION_NETWORK_ENDPOINTS");
    }
    if (manifest.relayerSmartAccount.ownerProvider === "dev-private-key") {
      throw new Error("PRODUCTION_RELAYER_REQUIRES_KMS_OR_HSM");
    }
  }
  if (!manifest.publicRpcUrl || !manifest.nativeCurrency?.symbol || manifest.nativeCurrency.decimals !== 18) {
    throw new Error("INCOMPLETE_DEPLOYMENT_MANIFEST");
  }
  if (!Number.isSafeInteger(manifest.finality.fallbackConfirmations) || manifest.finality.fallbackConfirmations < 1) {
    throw new Error("INVALID_FINALITY_POLICY");
  }
  return manifest;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
