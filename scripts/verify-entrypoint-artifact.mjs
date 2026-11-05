import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keccak256 } from "ethers";
import {
  ENTRY_POINT_V07,
  ENTRY_POINT_V07_RUNTIME_CODE_HASH,
  SENDER_CREATOR_V07,
  SENDER_CREATOR_V07_RUNTIME_CODE_HASH,
  SENDER_CREATOR_V07_RUNTIME,
  buildCanonicalEntryPointRuntime,
} from "./lib/canonical-entrypoint.mjs";

const artifact = JSON.parse(await readFile(
  resolve("node_modules/@account-abstraction/contracts/artifacts/EntryPoint.json"),
  "utf8",
));
const runtime = buildCanonicalEntryPointRuntime(artifact);
process.stdout.write(JSON.stringify({
  entryPoint: ENTRY_POINT_V07,
  entryPointRuntimeBytes: (runtime.length - 2) / 2,
  entryPointRuntimeCodeHash: keccak256(runtime),
  expectedEntryPointRuntimeCodeHash: ENTRY_POINT_V07_RUNTIME_CODE_HASH,
  senderCreator: SENDER_CREATOR_V07,
  senderCreatorRuntimeBytes: (SENDER_CREATOR_V07_RUNTIME.length - 2) / 2,
  senderCreatorRuntimeCodeHash: SENDER_CREATOR_V07_RUNTIME_CODE_HASH,
}) + "\n");
