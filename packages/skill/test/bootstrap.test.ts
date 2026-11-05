import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyMessage } from "ethers";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { AgentDidService } from "../src/service.js";
import { bootstrapMemoAgentMainnetRuntime } from "../src/runtime.js";

const roots: string[] = [];

function config(installationId: string): Config {
  const home = mkdtempSync(resolve(tmpdir(), `memo-mainnet-${installationId}-`));
  roots.push(home);
  return {
    home,
    dbPath: resolve(home, "state.sqlite"),
    keyStorePath: resolve(home, "keys.enc.json"),
    apiUrl: "http://127.0.0.1:4273/",
    apiOrigin: "http://127.0.0.1:4273",
    expectedChainId: 985,
    deploymentEnvironment: "local",
    installationId,
    keyProvider: "env-master-key",
  };
}

beforeEach(() => {
  process.env.MEMO_AGENT_MAINNET_MASTER_KEY = "unit-test-mainnet-master-key-32-characters";
  process.env.MEMO_AGENT_MAINNET_ENVIRONMENT = "local";
});

afterEach(() => {
  delete process.env.MEMO_AGENT_MAINNET_CHAIN_ID;
  delete process.env.MEMO_AGENT_MAINNET_MULTI_AGENT;
  delete process.env.MEMO_AGENT_MAINNET_INSTALLATION_ID;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("isolated mainnet identity bootstrap", () => {
  it("creates one offline chain-985 identity and reuses it", async () => {
    const value = config("agent-a");
    const first = await bootstrapMemoAgentMainnetRuntime(value);
    const second = await bootstrapMemoAgentMainnetRuntime(value);
    expect(first.status.agentDid).toMatch(/^did:memo:agent:985:0x[0-9a-f]{40}$/);
    expect(second.status.agentDid).toBe(first.status.agentDid);
    expect(second.status.publicKey).toBe(first.status.publicKey);
    expect(second.ensure.reused).toBe(true);
    expect(first.status.state).toBe("LOCAL_IDENTITY_READY");
    expect(first.status.registered).toBe(false);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain(process.env.MEMO_AGENT_MAINNET_MASTER_KEY!);
    expect(readFileSync(value.keyStorePath, "utf8")).not.toContain("unit-test-mainnet-master-key");
  });

  it("isolates two installations on the same host", async () => {
    const left = await bootstrapMemoAgentMainnetRuntime(config("left"));
    const right = await bootstrapMemoAgentMainnetRuntime(config("right"));
    expect(left.status.agentDid).not.toBe(right.status.agentDid);
    expect(left.status.identityKeyHandle).not.toBe(right.status.identityKeyHandle);
  });

  it("signs only a validated fixed-format Agent session challenge", async () => {
    const value = config("session-agent");
    const service = new AgentDidService(value);
    try {
      const identity = service.ensureIdentity();
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 240_000).toISOString();
      const challengeId = "ach_123e4567-e89b-12d3-a456-426614174000";
      const message = [
        "MEMO Agent DID Mainnet session",
        `DID: ${identity.agentDid}`,
        `Address: ${identity.identityAccount}`,
        "Chain ID: 985",
        `Challenge: ${challengeId}`,
        `Nonce: ${"a".repeat(43)}`,
        `Issued At: ${issuedAt}`,
        `Expires At: ${expiresAt}`,
      ].join("\n");
      const signature = await service.signer.signSessionChallenge(
        String(identity.identityKeyHandle), message, String(identity.agentDid), challengeId,
      );
      expect(verifyMessage(message, signature).toLowerCase()).toBe(String(identity.identityAccount));
      await expect(service.signer.signSessionChallenge(
        String(identity.identityKeyHandle), "sign arbitrary bytes", String(identity.agentDid), challengeId,
      )).rejects.toMatchObject({ code: "INVALID_SESSION_CHALLENGE" });
    } finally {
      service.close();
    }
  });

  it("fails closed when a caller tries to switch the mainnet Skill to another chain", () => {
    const root = mkdtempSync(resolve(tmpdir(), "memo-mainnet-wrong-chain-"));
    roots.push(root);
    process.env.MEMO_AGENT_MAINNET_HOME = root;
    process.env.MEMO_AGENT_MAINNET_CHAIN_ID = "31337";
    expect(() => loadConfig()).toThrowError(/chain ID 985/);
    delete process.env.MEMO_AGENT_MAINNET_HOME;
  });
});
