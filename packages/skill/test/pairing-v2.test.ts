import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { AgentDidService } from "../src/service.js";

const registry = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const management = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const roots: string[] = [];

beforeEach(() => {
  process.env.MEMO_AGENT_MAINNET_MASTER_KEY = "pairing-v2-test-master-key-32-characters";
  process.env.MEMO_AGENT_MAINNET_ALLOW_R2 = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEMO_AGENT_MAINNET_ALLOW_R2;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Pairing v2 Skill", () => {
  it("creates an Agent Offer without persisting or returning its handle outside the protected package", async () => {
    const service = activeService("offer-agent");
    let serverView: Record<string, unknown> | undefined;
    try {
      installSessionAndPairingFetch(service, (url, init, body) => {
        if (url.pathname === "/api/v1/pairing-offers") {
          expect(body.tokenHash).toMatch(/^[0-9a-f]{64}$/);
          expect(JSON.stringify(body)).not.toContain("memo-pair-v2.");
          const issuedAt = new Date().toISOString();
          serverView = {
            schema: "memo.agent-pairing-package/2",
            exchangeId: body.exchangeId,
            kind: "agent-offer",
            state: "CREATED",
            platformOrigin: "http://127.0.0.1:4273",
            environment: "local",
            chainId: 985,
            didRegistry: registry,
            managementRegistry: management,
            agentDid: service.status().agentDid,
            identityAccount: service.status().identityAccount,
            profileHash: service.status().profileHash,
            managerAccount: undefined,
            maxScopes: body.maxScopes,
            maxTermSeconds: body.maxTermSeconds,
            requestedScopes: [],
            requestedTermSeconds: 0,
            visibility: "private",
            issuedAt,
            expiresAt: new Date(Date.parse(issuedAt) + Number(body.ttlSeconds) * 1000).toISOString(),
          };
          return ok(serverView);
        }
        if (url.pathname.startsWith("/api/v1/pairing-exchanges/")) return ok({ ...serverView, state: "PAIRED", bindingId: "bind_test" });
        return undefined;
      });
      const created = await service.createPairingOffer("identity.read,profile.update", "30d", "15m");
      const packageValue = created.pairingPackage as Record<string, unknown>;
      expect(packageValue.handle).toMatch(/^memo-pair-v2\.poff_/);
      expect(created).toMatchObject({ kind: "agent-offer", state: "CREATED" });
      const local = service.store.db.prepare("SELECT package_json FROM pairing_exchanges WHERE exchange_id=?")
        .get(String(created.exchangeId)) as Record<string, unknown>;
      expect(String(local.package_json)).not.toContain("memo-pair-v2.");
      expect(readFileSync(service.config.dbPath).includes(Buffer.from(String(packageValue.handle)))).toBe(false);
      await expect(service.pairingStatus(String(created.exchangeId))).resolves.toMatchObject({ state: "PAIRED", bindingId: "bind_test" });
    } finally {
      service.close();
    }
  });

  it("accepts a Platform Invitation and returns only redacted Pairing state", async () => {
    const service = activeService("invitation-agent");
    try {
      const exchangeId = "pinv_1234567890abcdef";
      const handle = `memo-pair-v2.${exchangeId}.${"a".repeat(43)}`;
      const issuedAt = new Date().toISOString();
      const invitation = {
        schema: "memo.agent-pairing-package/2",
        kind: "platform-invitation",
        exchangeId,
        platformOrigin: "http://127.0.0.1:4273",
        environment: "local",
        chainId: 985,
        didRegistry: registry,
        managementRegistry: management,
        handle,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 900_000).toISOString(),
        managerAccount: "0x1000000000000000000000000000000000000001",
        requestedScopes: ["identity.read"],
        requestedTermSeconds: 86_400,
        visibility: "private",
      };
      const view = {
        ...invitation,
        handle: undefined,
        state: "CREATED",
        maxScopes: invitation.requestedScopes,
        maxTermSeconds: invitation.requestedTermSeconds,
        agentDid: service.status().agentDid,
      };
      delete (view as Record<string, unknown>).handle;
      installSessionAndPairingFetch(service, (url) => {
        if (url.pathname === "/api/v1/chain/config") return ok(chainConfig());
        if (url.pathname.endsWith("/inspect")) return ok(view);
        if (url.pathname.endsWith("/claim")) return ok({ ...view, state: "CLAIMED" });
        if (url.pathname.endsWith("/complete")) return ok({
          ...view,
          state: "PAIRED",
          bindingId: "bind_invitation",
          managementDraftId: "mdr_invitation",
          binding: { bindingId: "bind_invitation" },
          managementDraft: { draftId: "mdr_invitation" },
        });
        return undefined;
      });
      const result = await service.acceptPairingInvitation(invitation);
      expect(result).toMatchObject({ state: "PAIRED", bindingId: "bind_invitation", managementDraftId: "mdr_invitation" });
      expect(JSON.stringify(result)).not.toContain(handle);
      const row = service.store.db.prepare("SELECT secret_handle,state FROM pairing_exchanges WHERE exchange_id=?").get(exchangeId) as Record<string, unknown>;
      expect(row).toMatchObject({ secret_handle: "destroyed", state: "PAIRED" });
    } finally {
      service.close();
    }
  });
});

function activeService(installationId: string): AgentDidService {
  const root = mkdtempSync(resolve(tmpdir(), "memo-pair-v2-"));
  roots.push(root);
  const config: Config = {
    home: root,
    dbPath: resolve(root, "state.sqlite"),
    keyStorePath: resolve(root, "keys.enc.json"),
    apiUrl: "http://127.0.0.1:4273/",
    apiOrigin: "http://127.0.0.1:4273",
    expectedChainId: 985,
    deploymentEnvironment: "local",
    installationId,
    keyProvider: "env-master-key",
  };
  const service = new AgentDidService(config);
  service.ensureIdentity();
  service.store.db.prepare(`UPDATE installations SET state='ACTIVE',profile_hash=?,registry_address=?,
    management_registry_address=?,last_identity_revision=1 WHERE installation_id=?`)
    .run("0x" + "12".repeat(32), registry, management, installationId);
  return service;
}

function installSessionAndPairingFetch(
  service: AgentDidService,
  pairing: (url: URL, init: RequestInit, body: Record<string, unknown>) => Response | undefined,
): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === "/api/v1/agent-sessions/challenges") {
      const identity = service.status();
      const issuedAt = new Date().toISOString();
      return ok({
        challengeId: "ach_pairing-test",
        message: [
          "MEMO Agent DID Mainnet session",
          `DID: ${identity.agentDid}`,
          `Address: ${identity.identityAccount}`,
          "Chain ID: 985",
          "Challenge: ach_pairing-test",
          `Nonce: ${"n".repeat(43)}`,
          `Issued At: ${issuedAt}`,
          `Expires At: ${new Date(Date.now() + 240_000).toISOString()}`,
        ].join("\n"),
      });
    }
    if (url.pathname === "/api/v1/agent-sessions") return ok({ token: "pairing_agent_session_token_abcdefghijklmnopqrstuvwxyz" });
    const result = pairing(url, init, body);
    if (result) return result;
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url.pathname } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
}

function chainConfig() {
  return {
    chainId: 985,
    environment: "local",
    contracts: {
      agentDidRegistry: { address: registry },
      agentManagementRegistry: { address: management },
    },
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ schema: "memo.agent-api-result/1", ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
