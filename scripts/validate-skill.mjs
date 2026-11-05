#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = resolve(root, "packages/skill");
const skillText = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
const metadata = JSON.parse(readFileSync(resolve(skillRoot, "skill.json"), "utf8"));
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillText)?.[1];
if (!frontmatter) throw new Error("SKILL_FRONTMATTER_MISSING");
const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1];
if (!name || name !== metadata.name) throw new Error("SKILL_NAME_MISMATCH");
if (!description) throw new Error("SKILL_DESCRIPTION_MISSING");
if (!existsSync(resolve(skillRoot, "bin", metadata.cli))) throw new Error("SKILL_CLI_MISSING");

const links = [...skillText.matchAll(/\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !/^(?:https?:|#)/.test(target));
for (const target of links) {
  const file = resolve(skillRoot, target.split("#", 1)[0]);
  if (!existsSync(file)) throw new Error(`SKILL_REFERENCE_MISSING:${target}`);
}
process.stdout.write(JSON.stringify({ valid: true, name, localReferences: links.length }) + "\n");
