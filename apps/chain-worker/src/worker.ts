import { HDNodeWallet, Interface, JsonRpcProvider, getAddress } from "ethers";
import {
  BundlerClientV07,
  DevelopmentPrivateKeySigner,
  RemoteKmsDigestSigner,
  RpcEndpoint,
  SimpleAccountV07Client,
  type UserOperationReceiptV07,
  type UserOperationSigner,
} from "../../../packages/aa-client/src/index.js";
import {
  DID_ACTION_TYPES,
  MANAGEMENT_ACTION_TYPES,
  didForAddress,
  type ActionType,
  type DidActionType,
  type ManagementActionType,
} from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "../../api/src/config.service.js";
import { ChainStore, type StoreRow } from "../../api/src/store.service.js";
import { ChainHealthService } from "../../api/src/chain-health.service.js";

const DID = new Interface([
  "function registerAgent(address,bytes32,bytes32,bytes32,uint64,uint256,uint64,bytes)",
  "function updateProfile(address,bytes32,uint64,uint256,uint64,bytes)",
  "function updateDocument(address,bytes32,uint64,uint256,uint64,bytes)",
  "function suspendAgent(address,uint64,uint256,uint64,bytes)",
  "function resumeAgent(address,uint64,uint256,uint64,bytes)",
  "function revokeAgent(address,uint64,uint256,uint64,bytes)",
  "function declareSuccessor(address,bytes32,uint64,uint256,uint64,bytes)",
  "function revokeInstanceCredential(address,bytes32,uint64,uint256,uint64,bytes)",
  "event AgentRegistered(address indexed identityAccount,uint64 revision,uint256 nonce,bytes32 identityPublicKeyHash,bytes32 documentHash,bytes32 profileHash,bytes32 actionDigest)",
  "event ProfileUpdated(address indexed identityAccount,uint64 revision,uint256 nonce,bytes32 profileHash,bytes32 actionDigest)",
  "event DocumentUpdated(address indexed identityAccount,uint64 revision,uint256 nonce,bytes32 documentHash,bytes32 actionDigest)",
  "event AgentStatusChanged(address indexed identityAccount,uint8 status,uint64 revision,uint256 nonce,bytes32 actionDigest)",
  "event SuccessorDeclared(address indexed identityAccount,bytes32 successorDidHash,uint64 revision,uint256 nonce,bytes32 actionDigest)",
  "event InstanceCredentialRevoked(address indexed identityAccount,bytes32 indexed credentialIdHash,uint64 revision,uint256 nonce,bytes32 actionDigest)",
]);

const MANAGEMENT = new Interface([
  "function activateRelationship(address,address,bytes32,bytes32,uint64,uint64,bool,uint64,uint256,uint64,bytes,bytes)",
  "function renewRelationship(address,address,bytes32,bytes32,uint64,bool,uint64,uint256,uint64,bytes,bytes)",
  "function endRelationship(address,address,bytes32,address,bytes32,uint64,uint256,uint64,bytes)",
  "function transferRelationship(address,address,address,bytes32,bytes32,bytes32,uint64,bool,uint64,uint256,uint64,bytes,bytes,bytes)",
  "event RelationshipActivated(address indexed agent,address indexed manager,bytes32 indexed relationshipIdHash,bytes32 scopesHash,uint64 expiresAt,uint64 revision,uint256 nonce,bool discoverable,bytes32 actionDigest)",
  "event RelationshipRenewed(address indexed agent,address indexed manager,bytes32 indexed relationshipIdHash,bytes32 scopesHash,uint64 expiresAt,uint64 revision,uint256 nonce,bool discoverable,bytes32 actionDigest)",
  "event RelationshipEnded(address indexed agent,address indexed manager,bytes32 indexed relationshipIdHash,address actor,bytes32 reasonHash,uint64 revision,uint256 nonce,bytes32 actionDigest)",
  "event RelationshipTransferred(address indexed agent,address indexed oldManager,address indexed newManager,bytes32 oldRelationshipIdHash,bytes32 newRelationshipIdHash,bytes32 scopesHash,uint64 expiresAt,uint64 revision,uint256 nonce,bool discoverable,bytes32 actionDigest)",
]);
const SIMPLE_ACCOUNT_FACTORY = new Interface(["function createAccount(address owner,uint256 salt) returns (address)"]);
const NONCE_READER = new Interface(["function nonces(address) view returns (uint256)"]);
type ParsedArgs = NonNullable<ReturnType<Interface["parseLog"]>>["args"];

export class ChainWorker {
  private readonly provider: JsonRpcProvider;
  private readonly bundler: BundlerClientV07;
  private readonly account: SimpleAccountV07Client;
  private readonly relayerOwner: string;
  private running = false;

  constructor(
    private readonly config: RuntimeConfigService,
    private readonly store: ChainStore,
    private readonly health: ChainHealthService,
  ) {
    if (config.value.environment !== "local" && config.value.manifest.relayerSmartAccount.ownerProvider === "dev-private-key") {
      throw new Error("PRODUCTION_RELAYER_REQUIRES_KMS_OR_HSM");
    }
    const signer = relayerSigner(config);
    this.relayerOwner = signer.address;
    if (getAddress(this.relayerOwner) !== getAddress(config.value.manifest.relayerSmartAccount.ownerAddress)) {
      throw new Error("RELAYER_SIGNER_OWNER_MISMATCH");
    }
    this.bundler = new BundlerClientV07(new RpcEndpoint(config.value.bundlerUrl));
    this.account = new SimpleAccountV07Client(config.value.primaryRpcUrl, this.bundler, signer);
    this.provider = new JsonRpcProvider(config.value.primaryRpcUrl, 985, { staticNetwork: true });
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("WORKER_ALREADY_RUNNING");
    this.running = true;
    await this.health.assertWritable();
    while (!signal?.aborted) {
      try {
        await this.tick();
      } catch (error) {
        process.stderr.write(JSON.stringify({
          level: "error",
          event: "chain_worker_tick_failed",
          code: error instanceof Error ? error.message : "UNKNOWN",
          occurredAt: new Date().toISOString(),
        }) + "\n");
      }
      await delay(Number(process.env.WORKER_POLL_MS || 500), signal);
    }
    this.running = false;
  }

  async tick(): Promise<void> {
    await this.indexCanonicalBlocks();
    const signed = this.store.nextOperation(["SIGNED", "REORGED"]);
    if (signed) {
      await this.submit(signed);
      return;
    }
    const submitted = this.store.nextOperation(["SUBMITTED"]);
    if (submitted) {
      await this.checkReceipt(submitted);
      return;
    }
    const included = this.store.nextOperation(["INCLUDED"]);
    if (included) await this.checkFinality(included);
  }

  private async submit(row: StoreRow): Promise<void> {
    const message = JSON.parse(String(row.message_json)) as Record<string, unknown>;
    if (Number(message.deadline) < Math.floor(Date.now() / 1000)) {
      this.store.transitionOperation(String(row.operation_id), "FAILED", {
        error_code: "ACTION_DEADLINE_EXPIRED",
        error_message: "The original Agent DID action deadline has expired",
      });
      return;
    }
    await this.health.assertWritable();
    const actionType = String(row.action_type) as ActionType;
    const target = actionType in DID_ACTION_TYPES
      ? this.config.value.manifest.didRegistry.address
      : this.config.value.manifest.managementRegistry.address;
    const subject = String(actionType in DID_ACTION_TYPES ? message.identityAccount : message.agent);
    const nonceData = await this.provider.call({ to: target, data: NONCE_READER.encodeFunctionData("nonces", [subject]) });
    const chainNonce = NONCE_READER.decodeFunctionResult("nonces", nonceData)[0] as bigint;
    if (chainNonce !== BigInt(String(message.nonce))) {
      this.store.transitionOperation(String(row.operation_id), "FAILED", {
        error_code: "ACTION_NONCE_ALREADY_CONSUMED",
        error_message: "The canonical Registry nonce no longer matches the original signed action",
      });
      return;
    }
    const signatures = JSON.parse(String(row.signatures_json)) as Record<string, string>;
    const encoded = encodeRegistryCall(actionType, message, signatures);
    const fee = await this.provider.getFeeData();
    const maxFeePerGas = fee.maxFeePerGas || fee.gasPrice;
    if (!maxFeePerGas) throw new Error("FEE_DATA_UNAVAILABLE");
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas || 0n;
    const result = await this.account.send({
      sender: this.config.value.manifest.relayerSmartAccount.address,
      target,
      targetCallData: encoded,
      ...(await this.provider.getCode(this.config.value.manifest.relayerSmartAccount.address) === "0x"
        ? {
            factory: this.config.value.manifest.simpleAccountFactory.address,
            factoryData: SIMPLE_ACCOUNT_FACTORY.encodeFunctionData("createAccount", [this.relayerOwner, 0]),
          }
        : {}),
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    this.store.transitionOperation(String(row.operation_id), "SUBMITTED", {
      user_op_hash: result.userOpHash,
      user_op_json: JSON.stringify(result.operation),
      bundler_state: "accepted",
    });
  }

  private async checkReceipt(row: StoreRow): Promise<void> {
    const receipt = await this.bundler.receipt(String(row.user_op_hash));
    if (!receipt) return;
    if (!receipt.success || receipt.receipt.status === "0x0") {
      this.store.transitionOperation(String(row.operation_id), "FAILED", {
        bundler_state: "included",
        tx_hash: receipt.receipt.transactionHash,
        block_number: Number(BigInt(receipt.receipt.blockNumber)),
        block_hash: receipt.receipt.blockHash,
        actual_gas_used: BigInt(receipt.actualGasUsed).toString(),
        actual_gas_cost: BigInt(receipt.actualGasCost).toString(),
        error_code: "USER_OPERATION_REVERTED",
        error_message: receipt.reason || "EntryPoint included the UserOperation but execution reverted",
      });
      return;
    }
    const resultingRevision = this.assertTargetEvent(row, receipt);
    this.store.transitionOperation(String(row.operation_id), "INCLUDED", {
      bundler_state: "included",
      tx_hash: receipt.receipt.transactionHash,
      block_number: Number(BigInt(receipt.receipt.blockNumber)),
      block_hash: receipt.receipt.blockHash,
      confirmations: 1,
      actual_gas_used: BigInt(receipt.actualGasUsed).toString(),
      actual_gas_cost: BigInt(receipt.actualGasCost).toString(),
      resulting_revision: resultingRevision,
    });
  }

  private async checkFinality(row: StoreRow): Promise<void> {
    const blockNumber = Number(row.block_number);
    const canonical = await this.provider.getBlock(blockNumber);
    if (!canonical || canonical.hash !== row.block_hash) {
      this.store.transitionOperation(String(row.operation_id), "REORGED", {
        confirmations: 0,
        bundler_state: "dropped",
      });
      return;
    }
    let finalizedNumber: number | undefined;
    if (this.config.value.manifest.finality.preferFinalizedTag) {
      try {
        finalizedNumber = (await this.provider.getBlock("finalized"))?.number;
      } catch {
        finalizedNumber = undefined;
      }
    }
    if (finalizedNumber !== undefined && finalizedNumber >= blockNumber) {
      this.store.transitionOperation(String(row.operation_id), "CONFIRMED", {
        confirmations: Math.max(1, finalizedNumber - blockNumber + 1),
        finality_source: "finalized-tag",
      });
      return;
    }
    const head = await this.provider.getBlockNumber();
    const confirmations = Math.max(0, head - blockNumber + 1);
    if (confirmations >= Number(row.required_confirmations)) {
      this.store.transitionOperation(String(row.operation_id), "CONFIRMED", {
        confirmations,
        finality_source: "confirmations",
      });
    } else {
      this.store.transitionOperation(String(row.operation_id), "INCLUDED", { confirmations });
    }
  }

  private assertTargetEvent(row: StoreRow, receipt: UserOperationReceiptV07): number {
    const actionType = String(row.action_type) as ActionType;
    const target = getAddress(actionType in DID_ACTION_TYPES
      ? this.config.value.manifest.didRegistry.address
      : this.config.value.manifest.managementRegistry.address);
    const parser = actionType in DID_ACTION_TYPES ? DID : MANAGEMENT;
    const expectedDigest = String(row.digest).toLowerCase();
    let resultingRevision: number | undefined;
    const found = receipt.receipt.logs.some((log) => {
      const value = log as { address?: string; topics?: string[]; data?: string };
      if (!value.address || getAddress(value.address) !== target || !value.topics || value.data === undefined) return false;
      try {
        const decoded = parser.parseLog({ topics: value.topics, data: value.data });
        const matches = decoded?.args?.actionDigest?.toLowerCase() === expectedDigest;
        if (matches) resultingRevision = Number(decoded?.args?.revision);
        return matches;
      } catch {
        return false;
      }
    });
    if (!found || resultingRevision === undefined) throw new Error("TARGET_CONTRACT_EVENT_NOT_FOUND");
    return resultingRevision;
  }

  private async indexCanonicalBlocks(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    const deployedAt = Math.min(
      this.config.value.manifest.didRegistry.deploymentBlock,
      this.config.value.manifest.managementRegistry.deploymentBlock,
    );
    let next = deployedAt;
    const latestStored = this.store.latestStoredBlockNumber();
    if (latestStored !== undefined) {
      const compareFrom = Math.min(latestStored, head);
      const ancestor = await this.findCommonAncestor(compareFrom);
      if (ancestor < latestStored) this.store.rollbackAfter(ancestor);
      next = Math.max(deployedAt, ancestor + 1);
    }
    const batchHead = Math.min(head, next + 49);
    for (let number = next; number <= batchHead; number++) {
      const block = await this.provider.getBlock(number);
      if (!block?.hash) break;
      const blockHash = block.hash;
      const logs = await this.provider.getLogs({
        address: [this.config.value.manifest.didRegistry.address, this.config.value.manifest.managementRegistry.address],
        fromBlock: number,
        toBlock: number,
      });
      if (logs.some((log) => log.blockHash !== blockHash)) throw new Error("INDEXED_BLOCK_HASH_MISMATCH");
      this.store.transaction(() => {
        this.indexLogs(logs, number, blockHash, head);
        this.store.saveBlock({ number, hash: blockHash, parentHash: block.parentHash, canonical: true });
      });
    }
    this.store.confirmProjections(head, this.config.value.requiredConfirmations);
  }

  private async findCommonAncestor(from: number): Promise<number> {
    for (let number = from; number >= 0; number--) {
      const stored = this.store.block(number);
      const canonical = await this.provider.getBlock(number);
      if (stored && canonical?.hash === stored.block_hash) return number;
    }
    return -1;
  }

  private indexLogs(logs: Awaited<ReturnType<JsonRpcProvider["getLogs"]>>, blockNumber: number, blockHash: string, head: number): void {
    for (const log of logs) {
      const isDid = getAddress(log.address) === getAddress(this.config.value.manifest.didRegistry.address);
      const parser = isDid ? DID : MANAGEMENT;
      let parsed;
      try {
        parsed = parser.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed) continue;
      const payload = jsonSafe(parsed.args.toObject());
      const subject = getAddress(String(isDid ? parsed.args.identityAccount : parsed.args.agent));
      const revision = Number(parsed.args.revision);
      this.store.saveIndexedEvent({
        blockNumber,
        blockHash,
        txHash: log.transactionHash,
        logIndex: log.index,
        contractAddress: log.address,
        eventName: parsed.name,
        subject,
        revision,
        payload,
      });
      const confirmed = head - blockNumber + 1 >= this.config.value.requiredConfirmations;
      if (isDid) this.projectDidEvent(parsed.name, parsed.args, blockNumber, blockHash, confirmed, log.index);
      else this.projectManagementEvent(parsed.name, parsed.args, blockNumber, blockHash, confirmed, log.index);
    }
  }

  private projectDidEvent(
    eventName: string,
    args: ParsedArgs,
    blockNumber: number,
    blockHash: string,
    confirmed: boolean,
    logIndex: number,
  ): void {
    const identity = getAddress(String(args.identityAccount));
    const did = didForAddress(identity);
    const previous = this.store.identityProjection(did, false);
    const status = eventName === "AgentRegistered"
      ? "active"
      : eventName === "AgentStatusChanged"
        ? ["none", "active", "suspended", "revoked", "superseded"][Number(args.status)] || "unknown"
        : eventName === "SuccessorDeclared"
          ? "superseded"
          : String(previous?.status || "active");
    this.store.upsertIdentityProjection({
      agentDid: did,
      identityAccount: identity,
      status,
      revision: Number(args.revision),
      nonce: (BigInt(args.nonce) + 1n).toString(),
      documentHash: eventName === "AgentRegistered" || eventName === "DocumentUpdated"
        ? String(args.documentHash)
        : previous?.document_hash ? String(previous.document_hash) : undefined,
      profileHash: eventName === "AgentRegistered" || eventName === "ProfileUpdated"
        ? String(args.profileHash)
        : previous?.profile_hash ? String(previous.profile_hash) : undefined,
      blockNumber,
      blockHash,
      confirmed,
      logIndex,
    });
  }

  private projectManagementEvent(
    eventName: string,
    args: ParsedArgs,
    blockNumber: number,
    blockHash: string,
    confirmed: boolean,
    logIndex: number,
  ): void {
    const agent = getAddress(String(args.agent));
    const transferred = eventName === "RelationshipTransferred";
    const previous = this.store.managementProjection(didForAddress(agent), false);
    this.store.upsertManagementProjection({
      agentDid: didForAddress(agent),
      managerAccount: getAddress(String(transferred ? args.newManager : args.manager || previous?.manager_account)),
      relationshipHash: String(transferred ? args.newRelationshipIdHash : args.relationshipIdHash || previous?.relationship_hash),
      scopesHash: String(args.scopesHash || previous?.scopes_hash || "0x" + "00".repeat(32)),
      expiresAt: Number(args.expiresAt || previous?.expires_at || 0),
      discoverable: args.discoverable === undefined ? Boolean(previous?.discoverable) : Boolean(args.discoverable),
      status: eventName === "RelationshipEnded" ? "ended" : "active",
      revision: Number(args.revision),
      nonce: (BigInt(args.nonce) + 1n).toString(),
      blockNumber,
      blockHash,
      confirmed,
      logIndex,
    });
  }
}

export function encodeRegistryCall(
  actionType: ActionType,
  message: Record<string, unknown>,
  signatures: Record<string, string>,
): string {
  const agentSignature = signatures.agentSignature;
  switch (actionType as DidActionType) {
    case "RegisterAgent":
      return DID.encodeFunctionData("registerAgent", [
        message.identityAccount, message.identityPublicKeyHash, message.documentHash, message.profileHash,
        message.expectedRevision, message.nonce, message.deadline, requiredSignature(agentSignature),
      ]);
    case "UpdateProfile":
      return DID.encodeFunctionData("updateProfile", [
        message.identityAccount, message.profileHash, message.expectedRevision, message.nonce,
        message.deadline, requiredSignature(agentSignature),
      ]);
    case "UpdateDocument":
      return DID.encodeFunctionData("updateDocument", [
        message.identityAccount, message.documentHash, message.expectedRevision, message.nonce,
        message.deadline, requiredSignature(agentSignature),
      ]);
    case "SuspendAgent":
    case "ResumeAgent":
    case "RevokeAgent": {
      const functionName = actionType === "SuspendAgent" ? "suspendAgent" : actionType === "ResumeAgent" ? "resumeAgent" : "revokeAgent";
      return DID.encodeFunctionData(functionName, [
        message.identityAccount, message.expectedRevision, message.nonce, message.deadline,
        requiredSignature(agentSignature),
      ]);
    }
    case "DeclareSuccessor":
      return DID.encodeFunctionData("declareSuccessor", [
        message.identityAccount, message.successorDidHash, message.expectedRevision, message.nonce,
        message.deadline, requiredSignature(agentSignature),
      ]);
    case "RevokeInstanceCredential":
      return DID.encodeFunctionData("revokeInstanceCredential", [
        message.identityAccount, message.credentialIdHash, message.expectedRevision, message.nonce,
        message.deadline, requiredSignature(agentSignature),
      ]);
  }
  switch (actionType as ManagementActionType) {
    case "ActivateRelationship":
      return MANAGEMENT.encodeFunctionData("activateRelationship", [
        message.agent, message.manager, message.relationshipIdHash, message.scopesHash, message.issuedAt,
        message.expiresAt, message.discoverable, message.expectedRevision, message.nonce, message.deadline,
        requiredSignature(signatures.managerSignature), requiredSignature(agentSignature),
      ]);
    case "RenewRelationship":
      return MANAGEMENT.encodeFunctionData("renewRelationship", [
        message.agent, message.manager, message.relationshipIdHash, message.scopesHash, message.expiresAt,
        message.discoverable, message.expectedRevision, message.nonce, message.deadline,
        requiredSignature(signatures.managerSignature), requiredSignature(agentSignature),
      ]);
    case "EndRelationship":
      return MANAGEMENT.encodeFunctionData("endRelationship", [
        message.agent, message.manager, message.relationshipIdHash, message.actor, message.reasonHash,
        message.expectedRevision, message.nonce, message.deadline,
        requiredSignature(signatures.actorSignature || signatures.managerSignature || agentSignature),
      ]);
    case "TransferRelationship":
      return MANAGEMENT.encodeFunctionData("transferRelationship", [
        message.agent, message.oldManager, message.newManager, message.oldRelationshipIdHash,
        message.newRelationshipIdHash, message.scopesHash, message.expiresAt, message.discoverable,
        message.expectedRevision, message.nonce, message.deadline,
        requiredSignature(signatures.oldManagerSignature), requiredSignature(signatures.newManagerSignature),
        requiredSignature(agentSignature),
      ]);
  }
  throw new Error("UNSUPPORTED_ACTION_TYPE");
}

function requiredSignature(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("MISSING_REQUIRED_SIGNATURE");
  return value;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function localRelayerPrivateKey(config: RuntimeConfigService): string {
  const explicit = process.env.MEMO_RELAYER_OWNER_PRIVATE_KEY;
  if (explicit) return explicit;
  if (config.value.environment !== "local") return "";
  const mnemonic = process.env.MEMO_LOCAL_MNEMONIC;
  if (!mnemonic) throw new Error("LOCAL_RELAYER_OWNER_KEY_REQUIRED");
  return HDNodeWallet.fromPhrase(mnemonic, "", "m/44'/60'/0'/0/2").privateKey;
}

function relayerSigner(config: RuntimeConfigService): UserOperationSigner {
  const provider = config.value.manifest.relayerSmartAccount.ownerProvider;
  if (provider === "dev-private-key") {
    return new DevelopmentPrivateKeySigner(
      localRelayerPrivateKey(config),
      config.value.primaryRpcUrl,
      config.value.environment === "local" && process.env.MEMO_DOCKER_LOCAL_NETWORK === "true",
    );
  }
  const endpoint = requiredEnvironment("MEMO_RELAYER_SIGNER_ENDPOINT");
  const keyId = requiredEnvironment("MEMO_RELAYER_SIGNER_KEY_ID");
  const address = requiredEnvironment("MEMO_RELAYER_OWNER_ADDRESS");
  return new RemoteKmsDigestSigner({
    provider,
    endpoint,
    keyId,
    address,
    bearerToken: process.env.MEMO_RELAYER_SIGNER_TOKEN,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("MISSING_CONFIG:" + name);
  return value;
}
