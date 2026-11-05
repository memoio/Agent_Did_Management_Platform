import { describe, expect, it, vi } from "vitest";
import { PairingService } from "../../apps/api/src/pairing.service.js";
import type { ChainStore } from "../../apps/api/src/store.service.js";
import type { RuntimeConfigService } from "../../apps/api/src/config.service.js";
import type { Principal } from "../../apps/api/src/session.service.js";

const agent: Principal = {
  kind: "agent",
  subject: "did:memo:agent:985:0x2000000000000000000000000000000000000002",
  tenantId: "unpaired:agent",
};
const wallet: Principal = {
  kind: "wallet",
  subject: "0x3000000000000000000000000000000000000003",
  tenantId: "wallet:0x3000000000000000000000000000000000000003",
};

describe("PairingService v2", () => {
  it("creates a wallet-scoped Platform Invitation without returning bearer material", () => {
    const createPairingExchange = vi.fn((input) => row({ ...input, state: "CREATED" }));
    const service = new PairingService({ createPairingExchange } as unknown as ChainStore, config());
    const result = service.createInvitation(wallet, {
      exchangeId: "pinv_123456789012",
      tokenHash: "a".repeat(64),
      platformOrigin: "http://127.0.0.1:4273",
      requestedScopes: ["profile.update"],
      requestedTermSeconds: 2_592_000,
      visibility: "private",
      ttlSeconds: 900,
    }, "idem-invitation");
    expect(createPairingExchange).toHaveBeenCalledWith(expect.objectContaining({
      kind: "platform-invitation",
      managerAccount: wallet.subject,
      maxScopes: ["profile.update"],
    }));
    expect(result).not.toHaveProperty("handle");
    expect(result).not.toHaveProperty("tokenHash");
  });

  it("creates an Agent Offer only for an active confirmed identity", () => {
    const identityProjection = vi.fn();
    const createPairingExchange = vi.fn((input) => row({ ...input, state: "CREATED" }));
    const service = new PairingService({ identityProjection, createPairingExchange } as unknown as ChainStore, config());
    const input = {
      exchangeId: "poff_123456789012",
      tokenHash: "b".repeat(64),
      platformOrigin: "http://127.0.0.1:4273",
      maxScopes: ["profile.update"],
      maxTermSeconds: 2_592_000,
      ttlSeconds: 900,
    };
    identityProjection.mockReturnValue(undefined);
    expect(() => service.createOffer(agent, input, "idem-offer")).toThrow("IDENTITY_NOT_ACTIVE_OR_CONFIRMED");
    identityProjection.mockReturnValue({ status: "active" });
    expect(service.createOffer(agent, input, "idem-offer")).toMatchObject({
      exchangeId: input.exchangeId,
      kind: "agent-offer",
      agentDid: agent.subject,
    });
  });
});

function row(input: Record<string, unknown>) {
  return {
    exchange_id: input.exchangeId,
    kind: input.kind,
    token_hash: input.tokenHash,
    platform_origin: input.platformOrigin,
    creator_tenant_id: input.creatorTenantId,
    creator_subject: input.creatorSubject,
    agent_did: input.agentDid || null,
    manager_account: input.managerAccount || null,
    max_scopes_json: JSON.stringify(input.maxScopes),
    max_term_seconds: input.maxTermSeconds,
    requested_scopes_json: JSON.stringify(input.requestedScopes),
    requested_term_seconds: input.requestedTermSeconds,
    visibility: input.visibility,
    state: input.state,
    expires_at: input.expiresAt,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function config(): RuntimeConfigService {
  return {
    value: {
      environment: "local",
      platformOrigins: [],
      manifest: {
        environment: "local",
        didRegistry: { address: "0x1000000000000000000000000000000000000001" },
        managementRegistry: { address: "0x6000000000000000000000000000000000000006" },
      },
    },
  } as unknown as RuntimeConfigService;
}
