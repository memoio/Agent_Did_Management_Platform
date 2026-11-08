import { expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";

// mjs is executed directly by Node and does not form part of the API build.
const modulePath = new URL("../../scripts/chain/configure-wallet.mjs", import.meta.url).href;

it("matches the intended derived account and refuses wrong indices or passphrases", async () => {
  const { deriveAccount } = await import(/* @vite-ignore */ modulePath);
  // Public synthetic entropy for testing only, never a funded wallet.
  const phrase = Mnemonic.fromEntropy("0x" + "11".repeat(16)).phrase;
  const expected = HDNodeWallet.fromPhrase(phrase).address;
  expect(deriveAccount(phrase, "", 0, expected).address).toBe(expected);
  expect(() => deriveAccount(phrase, "", 1, expected)).toThrow("ADDRESS_MISMATCH");
  expect(() => deriveAccount(phrase, "wrong", 0, expected)).toThrow("ADDRESS_MISMATCH");
});

it("publishes an ignored env file without overwriting existing settings", async () => {
  const { writeWalletEnvironment } = await import(/* @vite-ignore */ modulePath);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-wallet-test-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(path.join(directory, ".gitignore"), ".env.local\n.env.wallet-*\n");
    await writeFile(path.join(directory, ".env.example"), "MEMO_RELAYER_PRIVATE_KEY=\nMEMO_CHAIN_WRITES_ENABLED=false\nCUSTOM_VALUE=preserved\n");
    const wallet = HDNodeWallet.fromSeed(new Uint8Array(32).fill(7));
    await writeWalletEnvironment(directory, wallet);
    const contents = await readFile(path.join(directory, ".env.local"), "utf8");
    expect(contents).toContain(`MEMO_RELAYER_PRIVATE_KEY=${wallet.privateKey}`);
    expect(contents).toContain("CUSTOM_VALUE=preserved");
    expect(contents).toContain("MEMO_CHAIN_WRITES_ENABLED=false");
    await expect(writeWalletEnvironment(directory, wallet)).rejects.toThrow("SIGNER_ALREADY_CONFIGURED");
    expect(await readFile(path.join(directory, ".env.local"), "utf8")).toBe(contents);
  } finally {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("agent-wallet-test-")) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it("refuses piped secret input and never echoes it", () => {
  const result = spawnSync(process.execPath, ["scripts/chain/configure-wallet.mjs"], {
    encoding: "utf8", input: "synthetic-secret-input\n", timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("INTERACTIVE_TERMINAL_REQUIRED");
  expect(result.stdout + result.stderr).not.toContain("synthetic-secret-input");
});
