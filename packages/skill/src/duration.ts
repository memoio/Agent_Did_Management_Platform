import { AgentError } from "./errors.js";

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new AgentError("INVALID_DURATION", `Invalid duration: ${value}`);
  const seconds = Number(match[1]!) * UNITS[match[2]!]!;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new AgentError("INVALID_DURATION", `Invalid duration: ${value}`);
  return seconds;
}
