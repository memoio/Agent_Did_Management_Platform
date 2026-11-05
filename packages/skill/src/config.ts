import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentError } from "./errors.js";

export const CHAIN_ID = 985;
export const KEYRING_SERVICE = "com.memo.agent-did.mainnet";
const INSTALLATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type KeyProviderName = "auto" | "os-keyring" | "env-master-key";
export type DeploymentEnvironment = "local" | "preprod" | "production";

export interface Config {
  home: string;
  dbPath: string;
  keyStorePath: string;
  apiUrl: string;
  apiOrigin: string;
  expectedChainId: 985;
  deploymentEnvironment: DeploymentEnvironment;
  installationId: string;
  keyProvider: KeyProviderName;
}

function validInstallationId(value: string): string {
  if (!INSTALLATION_PATTERN.test(value) || value === "." || value === ".." || basename(value) !== value) {
    throw new AgentError("INVALID_INSTALLATION_ID", "MEMO_AGENT_MAINNET_INSTALLATION_ID contains forbidden characters");
  }
  return value;
}

function persistedInstallationId(root: string): string {
  const marker = resolve(root, ".installation-id");
  if (existsSync(marker)) return validInstallationId(readFileSync(marker, "utf8").trim());
  const generated = randomUUID();
  try {
    writeFileSync(marker, `${generated}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(marker, 0o600);
    return generated;
  } catch (error) {
    if (existsSync(marker)) return validInstallationId(readFileSync(marker, "utf8").trim());
    throw error;
  }
}

function deploymentEnvironment(value: string | undefined): DeploymentEnvironment {
  const result = value || "local";
  if (!["local", "preprod", "production"].includes(result)) {
    throw new AgentError("INVALID_DEPLOYMENT_ENVIRONMENT", "Unsupported mainnet deployment environment");
  }
  return result as DeploymentEnvironment;
}

function checkedApiUrl(value: string, environment: DeploymentEnvironment): { url: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentError("API_ORIGIN_FORBIDDEN", "MEMO_AGENT_MAINNET_API_URL is not a valid absolute URL");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (environment === "local") {
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new AgentError("API_ORIGIN_FORBIDDEN", "Local mainnet emulation requires a loopback HTTP API");
    }
  } else if (parsed.protocol !== "https:") {
    throw new AgentError("API_ORIGIN_FORBIDDEN", "Preprod and production Agent DID APIs require HTTPS");
  }
  const allowlist = (process.env.MEMO_AGENT_MAINNET_API_ORIGINS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (environment !== "local" && (allowlist.length === 0 || !allowlist.includes(parsed.origin))) {
    throw new AgentError("API_ORIGIN_FORBIDDEN", "The platform origin is not in MEMO_AGENT_MAINNET_API_ORIGINS");
  }
  return { url: parsed.toString(), origin: parsed.origin };
}

export function loadConfig(): Config {
  const environment = deploymentEnvironment(process.env.MEMO_AGENT_MAINNET_ENVIRONMENT);
  const requestedChainId = Number(process.env.MEMO_AGENT_MAINNET_CHAIN_ID || CHAIN_ID);
  if (requestedChainId !== CHAIN_ID) {
    throw new AgentError("LOCAL_STATE_NETWORK_MISMATCH", "The mainnet Skill is permanently bound to chain ID 985");
  }
  const root = resolve(process.env.MEMO_AGENT_MAINNET_HOME || resolve(homedir(), ".memo-agent-mainnet"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const installationId = process.env.MEMO_AGENT_MAINNET_INSTALLATION_ID
    ? validInstallationId(process.env.MEMO_AGENT_MAINNET_INSTALLATION_ID)
    : persistedInstallationId(root);
  const home = process.env.MEMO_AGENT_MAINNET_STATE_DIR
    ? resolve(process.env.MEMO_AGENT_MAINNET_STATE_DIR)
    : resolve(root, "agents", installationId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const requestedProvider = process.env.MEMO_AGENT_MAINNET_KEY_PROVIDER || "auto";
  if (!["auto", "os-keyring", "env-master-key"].includes(requestedProvider)) {
    throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Unsupported MEMO_AGENT_MAINNET_KEY_PROVIDER");
  }
  const api = checkedApiUrl(
    process.env.MEMO_AGENT_MAINNET_API_URL || "http://127.0.0.1:4273",
    environment,
  );
  return {
    home,
    dbPath: resolve(home, "state.sqlite"),
    keyStorePath: resolve(home, "keys.enc.json"),
    apiUrl: api.url,
    apiOrigin: api.origin,
    expectedChainId: CHAIN_ID,
    deploymentEnvironment: environment,
    installationId,
    keyProvider: requestedProvider as KeyProviderName,
  };
}
