#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const embedded = resolve(project, "packages/skill");
const standalone = resolve(project, "../memo-agent-did-mainnet-skill/skills/memo-agent-did-mainnet");

if (!existsSync(standalone)) {
  process.stdout.write(JSON.stringify({ valid: true, skipped: true, reason: "standalone-sibling-not-present" }) + "\n");
  process.exit(0);
}

const files = [
  ...walk(resolve(embedded, "src")),
  ...walk(resolve(embedded, "schemas")),
  resolve(embedded, "skill.json"),
  resolve(embedded, "agents/openai.yaml"),
  resolve(embedded, "policy/default-policy.json"),
];
const drift = [];
for (const source of files) {
  const name = relative(embedded, source);
  const target = resolve(standalone, name);
  if (!existsSync(target)
    || readFileSync(source, "utf8").trimEnd() !== readFileSync(target, "utf8").trimEnd()) drift.push(name);
}
if (drift.length) throw new Error("STANDALONE_SKILL_DRIFT:" + drift.join(","));
process.stdout.write(JSON.stringify({ valid: true, comparedFiles: files.length, drift: 0 }) + "\n");

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
