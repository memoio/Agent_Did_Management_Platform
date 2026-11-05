import { describe, expect, it, vi } from "vitest";
import { ApiController } from "../../apps/api/src/api.controller.js";

describe("ApiController Pairing management draft", () => {
  it("derives activation issuedAt and term from canonical chain time", async () => {
    const principal = {
      kind: "wallet" as const,
      subject: "0x3000000000000000000000000000000000000003",
      tenantId: "wallet:0x3000000000000000000000000000000000000003",
    };
    const draft = {
      draft_id: "mdr_test",
      binding_id: "bind_test",
      tenant_id: principal.tenantId,
      agent_did: "did:memo:agent:985:0x2000000000000000000000000000000000000002",
      manager_account: principal.subject,
      relationship_id: "rel_test",
      scopes_json: JSON.stringify(["profile.update"]),
      term_seconds: 86_400,
      visibility: "private",
      state: "AWAITING_WALLET_SIGNATURE",
      expires_at: Date.now() + 60_000,
      intent_id: null,
      request_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const createManagementAction = vi.fn().mockResolvedValue({ intentId: "int_test" });
    const controller = new ApiController(
      {} as never,
      { bearer: () => "token", require: () => principal } as never,
      {
        managementDraft: () => draft,
        updateManagementDraft: () => ({ ...draft, intent_id: "int_test" }),
      } as never,
      { createManagementAction } as never,
      {} as never,
      {} as never,
      { latestBlock: vi.fn().mockResolvedValue({ timestamp: 1_700_000_000 }) } as never,
      {} as never,
    );

    await controller.managementDraftIntent(draft.draft_id, "Bearer token");

    expect(createManagementAction).toHaveBeenCalledWith(principal, expect.objectContaining({
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_086_400,
    }));
  });
});
