import { readFile } from "node:fs/promises";
import { providers, inspectNetwork, safeFailure } from "./network.mjs";
import { OpbnbChainAdapter } from "../../dist/packages/chain-adapter/src/index.js";

let rpcs = [];
try {
  rpcs = providers();
  const report = await inspectNetwork(rpcs);
  if (process.env.MEMO_CHAIN_MANIFEST_PATH) {
    const manifest = JSON.parse(
      await readFile(process.env.MEMO_CHAIN_MANIFEST_PATH, "utf8"),
    );
    const adapter = new OpbnbChainAdapter({
      manifest,
      primary: rpcs[0],
      secondary: rpcs[1],
    });
    report.deployment = await adapter.verifyDeployment();
  }
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  safeFailure(e);
} finally {
  rpcs.forEach((p) => p.destroy());
}
