import {
  readFile,
  mkdir,
  lstat,
  open,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createHash, randomUUID } from "node:crypto";

const repository = fileURLToPath(new URL("../", import.meta.url));

export function localDefaults(home, username) {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "MemoAgentOpbnb",
  );
  const socket = path.join(directory, "run");
  const url = new URL(
    `postgresql://${encodeURIComponent(username)}@localhost/memo_agent_opbnb`,
  );
  url.searchParams.set("host", socket);
  url.searchParams.set("port", "55435");
  return {
    directory,
    values: {
      MEMO_DEPLOYMENT_DIR: path.join(directory, "deployments"),
      MEMO_SUBMISSION_DIRECTORY: path.join(directory, "submissions"),
      MEMO_DEPLOYMENT_ID: "agent-opbnb-testnet-v1",
      MEMO_MINIMUM_BALANCE_WEI: "100000000000000",
      MEMO_GAS_PRICE_CAP_WEI: "2000000",
      MEMO_GAS_LIMIT_CAP: "8000000",
      MEMO_FINALITY_MODE: "finalized-tag",
      MEMO_FALLBACK_CONFIRMATIONS: "12",
      MEMO_MAX_REORG_DEPTH: "128",
      MEMO_ALLOW_FINALITY_FALLBACK: "false",
      MEMO_CHAIN_WRITES_ENABLED: "false",
      MEMO_PLATFORM_ORIGIN: "http://127.0.0.1:4273",
      DATABASE_URL: url.href,
    },
  };
}

export function fillEmptyValues(content, defaults) {
  const existing = parseEnv(content);
  const additions = [];
  for (const [name, value] of Object.entries(defaults)) {
    if (existing[name]) continue;
    content = content.replace(
      new RegExp(`^[ \\t]*${name}[ \\t]*=.*(?:\\r?\\n|$)`, "gm"),
      "",
    );
    additions.push(`${name}=${JSON.stringify(value)}`);
  }
  return (
    content.trimEnd() +
    "\n" +
    (additions.length ? additions.join("\n") + "\n" : "")
  );
}

export function manifestValues(bytes, filename) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.schema !== "memo.agent-chain-deployment/1" ||
    manifest.environment !== "testnet" ||
    manifest.network?.chainId !== 5611 ||
    manifest.network?.caip2 !== "eip155:5611"
  ) {
    throw new Error("MANIFEST_NETWORK_MISMATCH");
  }
  const addresses = [
    manifest.contracts?.didRegistry?.address,
    manifest.contracts?.managementRegistry?.address,
  ];
  if (
    addresses.some(
      (address) =>
        typeof address !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(address) ||
        BigInt(address) === 0n,
    ) ||
    addresses[0].toLowerCase() === addresses[1].toLowerCase()
  ) {
    throw new Error("MANIFEST_CONTRACTS_INVALID");
  }
  return {
    MEMO_DID_REGISTRY_ADDRESS: addresses[0],
    MEMO_MANAGEMENT_REGISTRY_ADDRESS: addresses[1],
    MEMO_CHAIN_MANIFEST_PATH: path.resolve(filename),
    MEMO_CHAIN_MANIFEST_SHA256:
      "0x" + createHash("sha256").update(bytes).digest("hex"),
  };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("UNSAFE_RUNTIME_DIRECTORY");
  await chmod(directory, 0o700);
}

export async function configureLocal({
  home = os.homedir(),
  username = os.userInfo().username,
  manifestPath,
} = {}) {
  const defaults = localDefaults(home, username);
  const relative = path.relative(repository, defaults.directory);
  if (
    !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
  )
    throw new Error("RUNTIME_MUST_BE_OUTSIDE_REPOSITORY");
  await privateDirectory(defaults.directory);
  const envPath = path.join(defaults.directory, "runtime.env");
  const lockPath = path.join(defaults.directory, "configure.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const temporary = path.join(defaults.directory, `.runtime-${randomUUID()}`);
  try {
    let content;
    try {
      const info = await lstat(envPath);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("UNSAFE_RUNTIME_FILE");
      content = await readFile(envPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      content = await readFile(path.join(repository, ".env.example"), "utf8");
    }
    content = fillEmptyValues(content, defaults.values);
    let values = parseEnv(content);
    const candidate = manifestPath
      ? path.resolve(manifestPath)
      : values.MEMO_CHAIN_MANIFEST_PATH ||
        path.join(
          values.MEMO_DEPLOYMENT_DIR,
          `${encodeURIComponent(values.MEMO_DEPLOYMENT_ID)}.manifest.json`,
        );
    let imported = false;
    try {
      const bytes = await readFile(candidate);
      const updates = manifestValues(bytes, candidate);
      for (const name of Object.keys(updates)) {
        if (values[name] && values[name] !== updates[name])
          throw new Error("EXISTING_MANIFEST_CONFIGURATION_DIFFERS");
      }
      content = fillEmptyValues(content, updates);
      imported = true;
    } catch (error) {
      if (
        error.code !== "ENOENT" ||
        manifestPath ||
        values.MEMO_CHAIN_MANIFEST_PATH
      )
        throw error;
    }
    values = parseEnv(content);
    for (const name of ["MEMO_DEPLOYMENT_DIR", "MEMO_SUBMISSION_DIRECTORY"]) {
      if (!path.isAbsolute(values[name]))
        throw new Error("ABSOLUTE_RUNTIME_DIRECTORY_REQUIRED");
      const rel = path.relative(repository, values[name]);
      if (
        !(
          rel === ".." ||
          rel.startsWith(`..${path.sep}`) ||
          path.isAbsolute(rel)
        )
      )
        throw new Error("RUNTIME_MUST_BE_OUTSIDE_REPOSITORY");
      await privateDirectory(values[name]);
    }
    await privateDirectory(path.join(defaults.directory, "run"));
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, envPath);
    await chmod(envPath, 0o600);
    return {
      environmentFile: envPath,
      deploymentDirectory: values.MEMO_DEPLOYMENT_DIR,
      submissionDirectory: values.MEMO_SUBMISSION_DIRECTORY,
      manifestImported: imported,
      signerConfigured:
        Boolean(values.MEMO_RELAYER_PRIVATE_KEY) !==
        Boolean(values.MEMO_SIGNER_MODULE_PATH),
      databaseConfigured: Boolean(values.DATABASE_URL),
      writesEnabled: values.MEMO_CHAIN_WRITES_ENABLED === "true",
    };
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await lock.close();
    await unlink(lockPath);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const valid =
    args.length === 0 || (args.length === 2 && args[0] === "--manifest");
  if (!valid) {
    console.error(
      "Usage: npm run local:configure -- [--manifest /absolute/path/manifest.json]",
    );
    process.exitCode = 1;
  } else
    configureLocal({ manifestPath: args[1] })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        const allowed = new Set([
          "MANIFEST_NETWORK_MISMATCH",
          "MANIFEST_CONTRACTS_INVALID",
          "UNSAFE_RUNTIME_DIRECTORY",
          "UNSAFE_RUNTIME_FILE",
          "RUNTIME_MUST_BE_OUTSIDE_REPOSITORY",
          "ABSOLUTE_RUNTIME_DIRECTORY_REQUIRED",
          "EXISTING_MANIFEST_CONFIGURATION_DIFFERS",
        ]);
        console.error(
          allowed.has(error.message)
            ? error.message
            : "LOCAL_CONFIGURATION_FAILED",
        );
        process.exitCode = 1;
      });
}
