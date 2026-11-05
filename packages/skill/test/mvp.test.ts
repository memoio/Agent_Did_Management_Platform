import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedDataEncoder, verifyMessage, verifyTypedData } from "ethers";
import type { Config } from "../src/config.js";
import { AgentDidService } from "../src/service.js";
import { ACTION_REGISTRY } from "../src/signer.js";

// Mixed-case checksummed addresses exercise the same format returned by ethers
// and by the deployment manifest.
const registry = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const management = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const roots: string[] = [];

beforeEach(() => {
  process.env.MEMO_AGENT_MAINNET_MASTER_KEY = "integration-test-mainnet-master-key-32-chars";
  process.env.MEMO_AGENT_MAINNET_ALLOW_R2 = "1";
  process.env.MEMO_AGENT_MAINNET_ENVIRONMENT = "local";
});

afterEach(() => {
  delete process.env.MEMO_AGENT_MAINNET_ALLOW_R2;
  vi.unstubAllGlobals();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("mainnet Skill HTTP flow", () => {
  it("uses one local key for Agent session, EIP-712 registration, finality, and resolution", async () => {
    let sessionMessage = "";
    let agentDid = "";
    let identityAccount = "";
    let registeredProfile: unknown;
    let currentMessage: Record<string, unknown> | undefined;
    let currentDigest = "";
    const token = "test_agent_session_token_abcdefghijklmnopqrstuvwxyz";
    const operationId = "op_registration";
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname === "/api/v1/chain/config") return response({
        chainId: 985,
        environment: "local",
        requiredConfirmations: 2,
        contracts: {
          agentDidRegistry: { address: registry, domain: domain("MEMO Agent DID Registry", registry) },
          agentManagementRegistry: { address: management, domain: domain("MEMO Agent DID Management", management) },
        },
      });
      if (url.pathname === "/api/v1/agent-sessions/challenges") {
        agentDid = String(body.agentDid);
        identityAccount = agentDid.split(":").at(-1)!;
        const issuedAt = new Date().toISOString();
        sessionMessage = [
          "MEMO Agent DID Mainnet session",
          `DID: ${agentDid}`,
          `Address: ${identityAccount}`,
          "Chain ID: 985",
          "Challenge: ach_integration",
          `Nonce: ${"n".repeat(43)}`,
          `Issued At: ${issuedAt}`,
          `Expires At: ${new Date(Date.now() + 240_000).toISOString()}`,
        ].join("\n");
        return response({ challengeId: "ach_integration", message: sessionMessage });
      }
      if (url.pathname === "/api/v1/agent-sessions") {
        expect(verifyMessage(sessionMessage, String(body.signature)).toLowerCase()).toBe(identityAccount.toLowerCase());
        return response({ token, tokenType: "Bearer", agentDid });
      }
      if (url.pathname.startsWith("/api/v1/agent-dids/") && init?.method !== "POST") return response({
        didDocument: { id: agentDid },
        profile: registeredProfile,
        didResolutionMetadata: { verified: true, chainId: 985, confirmations: 2 },
        didDocumentMetadata: { state: "active", versionId: 1 },
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (url.pathname === "/api/v1/registration-intents") {
        registeredProfile = body.profile;
        expect(body.identityAccount).toBe(identityAccount);
        expect(body.identityPublicKeyHash).toMatch(/^0x[0-9a-f]{64}$/);
        const message = {
          identityAccount,
          identityPublicKeyHash: body.identityPublicKeyHash,
          documentHash: sha256(JSON.stringify(body.document)),
          profileHash: sha256(JSON.stringify(body.profile)),
          expectedRevision: "0",
          nonce: "0",
          deadline: String(Math.floor(Date.now() / 1000) + 600),
        };
        const typedDomain = domain("MEMO Agent DID Registry", registry);
        currentMessage = message;
        currentDigest = TypedDataEncoder.hash(typedDomain, { RegisterAgent: ACTION_REGISTRY.RegisterAgent }, message);
        return response({
          intentId: "int_register",
          actionType: "RegisterAgent",
          primaryType: "RegisterAgent",
          domain: typedDomain,
          types: { RegisterAgent: ACTION_REGISTRY.RegisterAgent },
          message,
          digest: currentDigest,
          nonce: "0",
          expectedRevision: 0,
          expiresAt: new Date(Number(message.deadline) * 1000).toISOString(),
        });
      }
      if (url.pathname === "/api/v1/agent-dids" && init?.method === "POST") {
        const typedDomain = domain("MEMO Agent DID Registry", registry);
        expect(verifyTypedData(typedDomain, { RegisterAgent: ACTION_REGISTRY.RegisterAgent }, currentMessage!, String(body.signature)).toLowerCase()).toBe(identityAccount.toLowerCase());
        expect(new Headers(init.headers).get("idempotency-key")).toBe(currentDigest);
        return response(operation("SIGNED"));
      }
      if (url.pathname === `/api/v1/operations/${operationId}`) return response(operation("CONFIRMED"));
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "NOT_FOUND" } }), { status: 404, headers: { "content-type": "application/json" } });

      function operation(state: string) {
        return {
          operationId,
          actionType: "RegisterAgent",
          digest: currentDigest,
          state,
          userOpHash: "0x" + "11".repeat(32),
          entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
          relayerSmartAccount: "0x3000000000000000000000000000000000000003",
          bundlerState: state === "CONFIRMED" ? "included" : "accepted",
          txHash: "0x" + "22".repeat(32),
          blockNumber: 20,
          blockHash: "0x" + "33".repeat(32),
          confirmations: state === "CONFIRMED" ? 2 : 0,
          requiredConfirmations: 2,
          finalitySource: state === "CONFIRMED" ? "confirmations" : null,
          actualGasUsed: "123456",
          actualGasCost: "987654321",
          resultingRevision: 1,
        };
      }
    });
    const root = mkdtempSync(resolve(tmpdir(), "memo-mainnet-http-"));
    roots.push(root);
    const value: Config = {
      home: root,
      dbPath: resolve(root, "state.sqlite"),
      keyStorePath: resolve(root, "keys.enc.json"),
      apiUrl: "http://127.0.0.1:4273/",
      apiOrigin: "http://127.0.0.1:4273",
      expectedChainId: 985,
      deploymentEnvironment: "local",
      installationId: "http-agent",
      keyProvider: "env-master-key",
    };
    const service = new AgentDidService(value);
    try {
      const identity = service.ensureIdentity();
      const profile = { name: "HTTP Agent", capabilities: ["research"] };
      const registered = await service.register(profile, false);
      expect(registered.operationId).toBe(operationId);
      expect(registered.data.agentDid).toBe(identity.agentDid);
      expect(registered.data.defaultInstanceState).toBe("ACTIVE");
      expect(service.status()).toMatchObject({ state: "ACTIVE", registered: true, identityRevision: 1 });
      await expect(service.resolve(String(identity.agentDid), true)).resolves.toMatchObject({
        didResolutionMetadata: { verified: true, chainId: 985 },
      });
      const repeated = await service.register(profile, false);
      expect(repeated.operationId).toBe(operationId);
      expect(repeated.data.reused).toBe(true);
    } finally {
      service.close();
    }
  });
});

function domain(name: string, verifyingContract: string) {
  return { name, version: "1", chainId: 985, verifyingContract };
}

function sha256(value: string): string {
  return "0x" + createHash("sha256").update(value).digest("hex");
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ schema: "memo.agent-api-result/1", ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
