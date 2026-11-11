import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("rejects deployment without approved settings before connecting or loading a signer", () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("MEMO_")) delete environment[key];
  }
  for (const args of [[], ["--execute"]]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/chain/deploy.mjs", ...args],
      { env: environment, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: "DEPLOYMENT_SETTINGS_REQUIRED",
    });
  }
});
