import { Injectable } from "@nestjs/common";
import { getAddress } from "ethers";
import { RuntimeConfigService } from "./config.service.js";
import { ChainHealthService } from "./chain-health.service.js";
import { ChainStore, type StoreRow } from "./store.service.js";
import { ResolverService } from "./resolver.service.js";
import type { Principal } from "./session.service.js";
import { draftView } from "./pairing.service.js";

@Injectable()
export class DashboardService {
  constructor(
    private readonly config: RuntimeConfigService,
    private readonly chain: ChainHealthService,
    private readonly store: ChainStore,
    private readonly resolver: ResolverService,
  ) {}

  async view(principal: Principal) {
    if (principal.kind !== "wallet") throw new Error("WALLET_SESSION_REQUIRED");
    const bindings = this.store.agentBindingsForTenant(principal.tenantId);
    const details = await Promise.all(bindings.map((binding) => this.singleView(principal, binding)));
    const base = await this.singleView(principal, undefined);
    const agents = details.map((detail) => ({
      bindingId: detail.binding?.bindingId,
      binding: detail.binding,
      agentDid: detail.identity.agentDid,
      identity: detail.identity,
      profile: detail.profile,
      management: detail.management,
      pairing: detail.pairing,
      managementDraft: detail.managementDraft,
      pendingRequests: detail.pendingRequests,
      instances: detail.instances,
    }));
    return {
      schema: "memo.agent-dashboard/2",
      walletSession: base.walletSession,
      walletDisplayDataDid: null,
      agents,
      pairingExchanges: this.store.pairingExchangesForTenant(principal.tenantId).map(pairingView),
      counts: {
        total: agents.length,
        pending: agents.filter((agent) => agent.managementDraft && agent.managementDraft.state !== "CONFIRMED").length,
        managed: agents.filter((agent) => agent.management?.state === "ACTIVE").length,
        unmanaged: agents.filter((agent) => !agent.management).length,
      },
      contract: base.contract,
      events: base.events,
      chain: base.chain,
    };
  }

  async detail(principal: Principal, agentDid: string) {
    if (principal.kind !== "wallet") throw new Error("WALLET_SESSION_REQUIRED");
    const binding = this.store.agentBinding(agentDid, principal.tenantId);
    if (!binding) throw new Error("TENANT_AGENT_ACCESS_DENIED");
    return this.singleView(principal, binding);
  }

  private async singleView(principal: Principal, binding: StoreRow | undefined) {
    const agentDid = binding ? String(binding.agent_did) : undefined;
    const projection = agentDid ? this.store.identityProjection(agentDid, true) : undefined;
    const management = agentDid ? this.store.managementProjection(agentDid, true) : undefined;
    const pairing = agentDid ? this.store.latestPairingForAgent(agentDid) : undefined;
    const eventRows = projection ? this.store.eventsForSubject(String(projection.identity_account)) : [];
    const allOperationRows = this.store.operationDetailsForTenant(principal.tenantId);
    const operationRows = projection ? allOperationRows.filter((row) => {
      const message = JSON.parse(String(row.message_json)) as Record<string, unknown>;
      const target = String(message.identityAccount || message.agent || "").toLowerCase();
      return target === String(projection.identity_account).toLowerCase();
    }) : allOperationRows;
    const auditRows = this.store.auditForTenant(principal.tenantId);
    const operations = operationRows.map((row) => operationDetail(row));
    let resolution: Record<string, unknown> | undefined;
    if (agentDid && projection) {
      try {
        resolution = this.resolver.resolve(agentDid) as unknown as Record<string, unknown>;
      } catch {
        resolution = undefined;
      }
    }
    const [latestBlock, health] = await Promise.all([this.chain.latestBlock(), this.chain.health()]);
    const latestTransaction = operations.find((operation) => operation.txHash)?.txHash;
    const transaction = latestTransaction ? await this.chain.transaction(String(latestTransaction)).catch(() => null) : null;
    const publicConfig = this.config.publicChainConfig();
    const profile = resolution?.profile as Record<string, unknown> | undefined;
    const platformEvents = auditRows.map((row) => ({
      eventSequence: Number(row.event_sequence),
      occurredAt: Number(row.occurred_at),
      type: String(row.event_type),
      subject: row.subject,
      authority: row.authority,
      payload: JSON.parse(String(row.payload_json)),
    })).filter((event) => !agentDid || event.subject === agentDid || JSON.stringify(event.payload).includes(agentDid));
    const maximumSequence = platformEvents.reduce((maximum, event) => Math.max(maximum, event.eventSequence), 0);
    const events = [...platformEvents, ...eventRows.map((row, index) => ({
      eventSequence: maximumSequence + eventRows.length - index,
      occurredAt: Date.now(),
      type: String(row.event_name),
      subject: agentDid,
      authority: "memo-mainnet-985",
      payload: JSON.parse(String(row.payload_json)),
    }))].sort((left, right) => right.eventSequence - left.eventSequence);
    return {
      schema: "memo.agent-dashboard-detail/2",
      walletSession: { account: principal.subject, tenantId: principal.tenantId },
      binding: binding ? {
        bindingId: String(binding.binding_id),
        agentDid: String(binding.agent_did),
        state: String(binding.state),
        createdAt: new Date(Number(binding.created_at)).toISOString(),
      } : null,
      walletDisplayDataDid: null,
      identity: projection ? {
        exists: true,
        agentDid,
        identityAccount: projection.identity_account,
        state: String(projection.status).toUpperCase(),
        identityRevision: Number(projection.revision),
        profileHash: projection.profile_hash,
        documentHash: projection.document_hash,
        network: "eip155:985",
        blockNumber: Number(projection.block_number),
        blockHash: projection.block_hash,
      } : { exists: false, state: binding ? "REGISTRATION_PENDING" : "WAITING_FOR_AGENT" },
      profile: profile || null,
      resolution: resolution || null,
      profileHistory: projection ? [{
        revision: Number(projection.revision),
        occurredAt: Date.now(),
        kind: "canonical-chain-state",
        note: "MEMO Mainnet confirmed projection",
        profileHash: projection.profile_hash,
      }] : [],
      management: management ? {
        managerAccount: management.manager_account,
        state: String(management.status).toUpperCase(),
        relationshipRevision: Number(management.revision),
        relationshipHash: management.relationship_hash,
        managementScopes: [String(management.scopes_hash)],
        termEndsAt: Number(management.expires_at),
        visibility: Number(management.discoverable) ? "public" : "private",
      } : null,
      pairing: pairing ? pairingView(pairing) : null,
      managementDraft: agentDid
        ? (() => {
            const row = this.store.managementDraftForAgent(agentDid, principal.tenantId);
            return row ? draftView(row) : null;
          })()
        : null,
      pendingRequests: agentDid ? this.store.requestsForTenant(principal.tenantId, agentDid).map(requestView) : [],
      instances: [],
      contract: {
        identityProtocolVersion: "memo-agent-did/2",
        managementProtocolVersion: "memo-agent-management/4",
        capabilities: [
          "identity.resolve.chain", "identity.profile.update", "identity.document.update",
          "identity.suspend", "identity.resume", "identity.revoke", "instance.revoke",
          "management.activate.chain", "management.renew.chain", "management.end.chain", "management.transfer.chain",
        ],
      },
      events,
      chain: {
        config: publicConfig,
        latestBlock,
        accounts: {
          relayer: {
            address: health.relayerSmartAccount.address,
            role: "ERC-4337 v0.7 Relayer Smart Account",
            balanceWei: health.relayerSmartAccount.balanceWei,
            entryPointDepositWei: health.relayerSmartAccount.entryPointDepositWei,
          },
        },
        operations,
        events: eventRows.map((row) => ({
          blockNumber: Number(row.block_number),
          name: row.event_name,
          contract: getAddress(String(row.contract_address)),
          txHash: row.tx_hash,
          args: JSON.parse(String(row.payload_json)),
        })),
        latestTransaction: transaction,
      },
    };
  }
}

function operationDetail(row: StoreRow): Record<string, unknown> {
  return {
    operationId: row.operation_id,
    actionType: row.action_type,
    digest: row.digest,
    state: row.state,
    userOpHash: row.user_op_hash || null,
    entryPoint: row.entry_point,
    relayerSmartAccount: row.smart_account,
    bundlerState: row.bundler_state || null,
    txHash: row.tx_hash || null,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    confirmations: Number(row.confirmations),
    requiredConfirmations: Number(row.required_confirmations),
    finalitySource: row.finality_source || null,
    actualGasUsed: row.actual_gas_used || null,
    actualGasCost: row.actual_gas_cost || null,
    resultingRevision: row.resulting_revision,
    domain: JSON.parse(String(row.domain_json)),
    types: JSON.parse(String(row.types_json)),
    primaryType: row.action_type,
    message: JSON.parse(String(row.message_json)),
  };
}

function pairingView(row: StoreRow): Record<string, unknown> {
  const state = Number(row.expires_at) <= Date.now() && !["PAIRED", "CANCELLED", "FAILED"].includes(String(row.state))
    ? "EXPIRED"
    : String(row.state);
  return {
    exchangeId: String(row.exchange_id),
    kind: String(row.kind),
    state,
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    ...(row.binding_id ? { bindingId: String(row.binding_id) } : {}),
    ...(row.management_draft_id ? { managementDraftId: String(row.management_draft_id) } : {}),
  };
}

function requestView(row: StoreRow): Record<string, unknown> {
  return {
    requestId: row.request_id,
    type: row.request_type,
    state: row.state,
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
  };
}
