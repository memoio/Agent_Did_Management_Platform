import { createHash } from "node:crypto";
import { AgentError } from "./errors.js";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgentError("INVALID_CANONICAL_VALUE", "Non-finite numbers are forbidden");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new AgentError("INVALID_CANONICAL_VALUE", `Unsupported canonical value: ${typeof value}`);
}

export function sha256(value: string | Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalize(value));
}

export function assertExactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const forbidden = new Set(["managerDid", "dataDid", "ownerDid"]);
  for (const key of Object.keys(value)) {
    if (forbidden.has(key)) throw new AgentError("UNSUPPORTED_SIGNED_FIELD", `Forbidden signed field: ${key}`);
    if (!allowed.includes(key)) throw new AgentError("UNSUPPORTED_SIGNED_FIELD", `Unknown signed field: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new AgentError("INVALID_REQUEST", `Missing required field: ${key}`);
  }
}
