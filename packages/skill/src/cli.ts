import { loadConfig } from "./config.js";
import { AgentDidService } from "./service.js";
import { AgentError, asAgentError } from "./errors.js";
import { failure, success, type Envelope } from "./envelope.js";
import { chmodSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const group = args[0] || "help";
const command = args[1] || "";
const nestedCommand = group === "pair" && ["invitation", "offer"].includes(command) ? args[2] || "" : "";
const action = nestedCommand ? `${group}.${command}.${nestedCommand}` : command ? `${group}.${command}` : group;

function option(name: string, required = true): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    if (required) throw new AgentError("INVALID_ARGUMENT", `Missing --${name}`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new AgentError("INVALID_ARGUMENT", `Missing value for --${name}`);
  return value;
}

function positional(index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new AgentError("INVALID_ARGUMENT", `Missing ${name}`);
  return value;
}

function rejectSecretArguments(): void {
  for (const forbidden of ["--master-key", "--private-key", "--token", "--binding-code", "--passphrase"]) {
    if (args.includes(forbidden)) throw new AgentError("SECRET_IN_ARGUMENT", `${forbidden} is forbidden; use trusted environment or stdin input`);
  }
}

function checkedInvitation(pathValue: string): string {
  const path = resolve(pathValue);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new AgentError("INVALID_PAIRING_FILE", "Invitation must be a regular file, not a symbolic link");
  if (info.size > 65_536) throw new AgentError("INPUT_TOO_LARGE", "Invitation file exceeds 64 KiB");
  if (typeof process.getuid === "function") {
    if (info.uid !== process.getuid()) throw new AgentError("INVALID_PAIRING_FILE", "Invitation file is not owned by the current user");
    chmodSync(path, 0o600);
  }
  return path;
}

function writeOffer(pathValue: string, value: unknown): string {
  const path = resolve(pathValue);
  if (!existsSync(dirname(path))) throw new AgentError("INVALID_ARGUMENT", "Offer output directory does not exist");
  if (existsSync(path)) throw new AgentError("INVALID_ARGUMENT", "Offer file already exists");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return path;
}

function exitCode(error: AgentError): number {
  if (error.code.startsWith("POLICY_")) return 3;
  if (error.code === "NONCE_REPLAYED") return 4;
  if (error.code.startsWith("INVALID_") || error.code === "UNSUPPORTED_SIGNED_FIELD" || error.code === "SECRET_IN_ARGUMENT") return 2;
  return 1;
}

async function run(): Promise<Envelope> {
  rejectSecretArguments();
  const service = new AgentDidService(loadConfig());
  try {
    if (group === "doctor") return success("doctor", service.doctor());
    if (group === "identity" && command === "ensure") return success(action, service.ensureIdentity());
    if (group === "identity" && command === "init") return success(action, await service.initialize(option("storage", false) || "auto"), null, ["identity init is deprecated; use identity ensure"]);
    if (group === "identity" && command === "key-migrate") {
      if (option("to") !== "os-keyring") throw new AgentError("INVALID_ARGUMENT", "Only --to os-keyring is supported");
      return success(action, service.migrateKeyToOsKeyring());
    }
    if (group === "identity" && command === "status") return success(action, service.status());
    if (group === "identity" && command === "register") {
      const result = await service.register(service.readJson(option("profile")!), args.includes("--dry-run"));
      return success(action, result.data, result.operationId);
    }
    if (group === "identity" && command === "resolve") return success(action, await service.resolve(positional(2, "DID"), args.includes("--verify")));
    if (group === "identity" && command === "update-profile") return success(action, await service.updateProfile(service.readJson(option("profile")!)));
    if (group === "identity" && command === "update-document") return success(action, await service.updateDocument(service.readJson(option("document")!)));
    if (group === "identity" && ["suspend", "resume", "revoke"].includes(command)) return success(action, await service.changeIdentityState(command as "suspend" | "resume" | "revoke"));
    if (group === "identity" && command === "successor") return success(action, await service.declareSuccessor(option("did")!));
    if (group === "identity" && command === "self-test") return success(action, await service.selfTest());
    if (group === "instance" && command === "create") return success(action, await service.createInstance(option("name")!, option("ttl")!));
    if (group === "instance" && command === "reconcile-default") return success(action, await service.reconcileDefaultInstance());
    if (group === "instance" && command === "list") return success(action, service.listInstances());
    if (group === "instance" && command === "revoke") return success(action, await service.revokeInstance(positional(2, "instance ID"), option("reason")!));
    if (group === "auth" && command === "sign") return success(action, await service.signChallenge(service.readJson(option("challenge-file")!)));
    if (group === "pair" && command === "create") {
      throw new AgentError("PAIRING_V1_REMOVED", "pair create was removed; use pair invitation accept or pair offer create");
    }
    if (group === "pair" && command === "invitation" && nestedCommand === "accept") {
      const profilePath = option("profile", false);
      const data = await service.acceptPairingInvitation(
        service.readJson(checkedInvitation(option("invitation-file")!)),
        profilePath ? service.readJson(profilePath) : undefined,
      );
      return success(action, data, typeof data.operationId === "string" ? data.operationId : null);
    }
    if (group === "pair" && command === "offer" && nestedCommand === "create") {
      const offerFile = option("offer-file")!;
      const profilePath = option("profile", false);
      const result = await service.createPairingOffer(
        option("max-scopes")!,
        option("max-term")!,
        option("ttl")!,
        profilePath ? service.readJson(profilePath) : undefined,
      );
      const pairingPackage = result.pairingPackage;
      if (!pairingPackage) throw new AgentError("INVALID_PAIRING_PACKAGE", "The platform did not produce an Agent Offer package");
      const storedAt = writeOffer(offerFile, pairingPackage);
      const { pairingPackage: _redacted, ...publicResult } = result;
      return success(action, { ...publicResult, offerFile: storedAt, offerStored: true }, typeof result.operationId === "string" ? result.operationId : null);
    }
    if (group === "pair" && command === "status") return success(action, await service.pairingStatus(positional(2, "Pairing exchange ID")));
    if (group === "pair" && command === "resume") {
      const profilePath = option("profile", false);
      const data = await service.resumePairing(positional(2, "Pairing exchange ID"), profilePath ? service.readJson(profilePath) : undefined);
      return success(action, data, typeof data.operationId === "string" ? data.operationId : null);
    }
    if (group === "pair" && command === "cancel") return success(action, await service.cancelPairing(positional(2, "Pairing exchange ID")));
    if (group === "agent-request" && command === "next") return success(action, await service.nextAgentRequest(Number(option("wait-seconds", false) || "20")));
    if (group === "agent-request" && command === "approve") return success(action, await service.decideAgentRequest(option("id")!, "approve"));
    if (group === "agent-request" && command === "reject") return success(action, await service.decideAgentRequest(option("id")!, "reject", option("reason", false) || "declined"));
    if (group === "management" && command === "inspect") return success(action, service.inspectManagement(service.readJson(option("request-file")!)));
    if (group === "management" && command === "accept") return success(action, await service.acceptManagement(option("request-id")!));
    if (group === "management" && command === "accept-chain") return success(action, await service.acceptChainManagement(service.readJson(option("input-file")!)));
    if (group === "management" && ["renew", "end", "transfer"].includes(command)) return success(action, await service.acceptChainManagement(service.readJson(option("input-file")!)));
    if (group === "management" && command === "reject") return success(action, service.rejectManagement(option("request-id")!, option("reason")!));
    if (group === "operation" && command === "status") return success(action, service.operation(positional(2, "operation ID")));
    if (group === "operation" && command === "reconcile") return success(action, await service.reconcileOperation(positional(2, "operation ID")));
    throw new AgentError("INVALID_ARGUMENT", `Unsupported command: ${args.filter((arg) => arg !== "--json").join(" ") || "(empty)"}`);
  } finally {
    service.close();
  }
}

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const normalized = asAgentError(error);
  process.stdout.write(`${JSON.stringify(failure(action, normalized))}\n`);
  process.exitCode = exitCode(normalized);
}
