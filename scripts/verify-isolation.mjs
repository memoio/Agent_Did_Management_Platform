import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".data", ".git", "dist", "node_modules", "out", "cache", "lib"]);
const scannable = new Set([".ts", ".js", ".mjs", ".json", ".sol", ".yaml", ".yml"]);
const legacyTargets = ["agent-did-console-mvp", "memo-agent-did"];
const violations = [];

await walk(root);

const compose = await readFile(join(root, "docker-compose.yml"), "utf8");
if (!/^name:\s*memo-agent-did-mainnet-local\s*$/m.test(compose)) {
  violations.push("docker-compose.yml must use the isolated project name memo-agent-did-mainnet-local");
}
if (/^\s*external:\s*true\s*$/m.test(compose)) {
  violations.push("docker-compose.yml must not attach an external/shared volume or network");
}

if (violations.length) {
  throw new Error("ISOLATION_CHECK_FAILED\n" + violations.map((value) => "- " + value).join("\n"));
}

process.stdout.write(JSON.stringify({
  isolated: true,
  root,
  composeProject: "memo-agent-did-mainnet-local",
  legacyImports: 0,
  escapingSymlinks: 0,
}) + "\n");

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await realpath(path);
      if (target !== root && !target.startsWith(root + "/")) {
        violations.push(`${relative(root, path)} is a symlink escaping the new project root`);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile() || (entry.name !== "Dockerfile" && !scannable.has(extname(entry.name)))) continue;
    const content = await readFile(path, "utf8");
    for (const target of legacyTargets) {
      const parentImport = "../" + target;
      const absoluteImport = join(dirname(root), target);
      if (hasPathReference(content, parentImport) || hasPathReference(content, absoluteImport)) {
        violations.push(`${relative(root, path)} references legacy project ${target}`);
      }
    }
  }
}

function hasPathReference(content, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=$|[/\\\\'\"\x60\\s])`).test(content);
}
