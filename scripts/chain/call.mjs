import { readFile } from "node:fs/promises";
import {
  ChainError,
  configuredChain,
} from "../../dist/packages/chain-adapter/src/index.js";

const [command, inputPath, ...flags] = process.argv.slice(2);
let connection;
try {
  if (
    ![
      "config",
      "ready",
      "identity",
      "relationship",
      "intent",
      "estimate",
      "submit",
      "submission",
    ].includes(command)
  )
    throw new ChainError("INVALID_ACTION");
  // No signer access or transaction preparation before explicit submit approval.
  if (command === "submit" && !flags.includes("--execute"))
    throw new ChainError("INVALID_ACTION");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : {};
  connection = await configuredChain();
  const { adapter } = connection;
  let result;
  switch (command) {
    case "config":
      result = await adapter.publicConfig();
      break;
    case "ready":
      result = await adapter.readiness();
      break;
    case "identity":
      result = await adapter.readIdentity(input.address);
      break;
    case "relationship":
      result = await adapter.readRelationship(input.address);
      break;
    case "intent":
      result = await adapter.buildIntent(
        input.actionType,
        input.payload,
        input.intentId,
        input.ttlSeconds,
      );
      break;
    case "estimate":
      result = await adapter.estimateSignedAction(
        input.intent,
        input.signatures,
      );
      break;
    case "submit":
      result = await adapter.submitSignedAction(
        input.intent,
        input.signatures,
        input.requestId,
      );
      break;
    case "submission":
      result = await adapter.getSubmission(input.submissionId);
      break;
  }
  console.log(JSON.stringify({ ok: true, data: result }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        error instanceof ChainError
          ? error.toJSON()
          : { code: "CHAIN_CONFIGURATION_OR_INPUT_ERROR" },
    }),
  );
  process.exitCode = 1;
} finally {
  connection?.close();
}
