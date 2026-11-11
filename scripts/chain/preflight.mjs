import { providers, inspectNetwork, safeFailure } from "./network.mjs";
import { configuredChain } from "../../dist/packages/chain-adapter/src/index.js";

let rpcs = [];
try {
  rpcs = providers();
  const report = await inspectNetwork(rpcs);
  if (process.env.MEMO_CHAIN_MANIFEST_PATH) {
    const connection = await configuredChain({
      ...process.env,
      MEMO_CHAIN_WRITES_ENABLED: "false",
    });
    try {
      report.deployment = await connection.adapter.verifyDeployment();
    } finally {
      connection.close();
    }
  }
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  safeFailure(e);
} finally {
  rpcs.forEach((p) => p.destroy());
}
