import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";

const modulePath = new URL("../../scripts/configure-local.mjs", import.meta.url)
  .href;
const parseValues = (content: string) => parseEnv(content) as Record<string, string>;

it("fills Mac paths and imports manifests while preserving existing signer and budget settings", async () => {
  const { configureLocal } = await import(/* @vite-ignore */ modulePath);
  const home = await mkdtemp(path.join(os.tmpdir(), "memo-local-config-"));
  try {
    const result = await configureLocal({ home, username: "test-user" });
    let values = parseValues(await readFile(result.environmentFile, "utf8"));
    expect(values.MEMO_GAS_PRICE_CAP_WEI).toBe("2000000");
    expect(values.MEMO_CHAIN_WRITES_ENABLED).toBe("false");
    expect(new URL(values.DATABASE_URL).searchParams.get("host")).toBe(
      path.join(
        home,
        "Library",
        "Application Support",
        "MemoAgentOpbnb",
        "run",
      ),
    );
    let content = await readFile(result.environmentFile, "utf8");
    content = content.replace(
      /^MEMO_RELAYER_PRIVATE_KEY=.*$/m,
      "MEMO_RELAYER_PRIVATE_KEY=synthetic-test-value",
    );
    content = content.replace(
      /^MEMO_GAS_LIMIT_CAP=.*$/m,
      'MEMO_GAS_LIMIT_CAP="5000000"',
    );
    await writeFile(result.environmentFile, content);
    const manifest = {
      schema: "memo.agent-chain-deployment/1",
      environment: "testnet",
      network: { chainId: 5611, caip2: "eip155:5611" },
      contracts: {
        didRegistry: { address: "0x" + "1".repeat(40) },
        managementRegistry: { address: "0x" + "2".repeat(40) },
      },
    };
    const bytes = JSON.stringify(manifest);
    await writeFile(
      path.join(
        result.deploymentDirectory,
        "agent-opbnb-testnet-v1.manifest.json",
      ),
      bytes,
    );
    const imported = await configureLocal({ home, username: "test-user" });
    expect(imported.manifestImported).toBe(true);
    expect(imported.signerConfigured).toBe(true);
    expect(JSON.stringify(imported)).not.toContain("synthetic-test-value");
    values = parseValues(await readFile(result.environmentFile, "utf8"));
    expect(values.MEMO_RELAYER_PRIVATE_KEY).toBe("synthetic-test-value");
    expect(values.MEMO_GAS_LIMIT_CAP).toBe("5000000");
    expect(values.MEMO_CHAIN_MANIFEST_SHA256).toBe(
      "0x" + createHash("sha256").update(bytes).digest("hex"),
    );
    expect(values.MEMO_CHAIN_WRITES_ENABLED).toBe("false");
    if (process.platform !== "win32")
      expect((await stat(result.environmentFile)).mode & 0o777).toBe(0o600);
    manifest.network.chainId = 985;
    const other = path.join(result.deploymentDirectory, "wrong-chain.json");
    await writeFile(other, JSON.stringify(manifest));
    await expect(
      configureLocal({ home, username: "test-user", manifestPath: other }),
    ).rejects.toThrow("MANIFEST_NETWORK_MISMATCH");
    expect(
      parseValues(await readFile(result.environmentFile, "utf8"))
        .MEMO_RELAYER_PRIVATE_KEY,
    ).toBe("synthetic-test-value");
  } finally {
    if (
      path.dirname(home) === path.resolve(os.tmpdir()) &&
      path.basename(home).startsWith("memo-local-config-")
    )
      await rm(home, { recursive: true, force: true });
  }
});
