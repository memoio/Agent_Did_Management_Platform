import { AgentError } from "./errors.js";

export type Risk = "R0" | "R1" | "R2" | "R3" | "R4";

export function hasLocalR4TestGrant(): boolean {
  if (process.env.MEMO_AGENT_MAINNET_ALLOW_R4_TEST !== "1") return false;
  if (process.env.MEMO_AGENT_MAINNET_ENVIRONMENT !== "local") return false;
  if (Number(process.env.MEMO_AGENT_MAINNET_CHAIN_ID || "985") !== 985) return false;
  try {
    const api = new URL(process.env.MEMO_AGENT_MAINNET_API_URL || "http://127.0.0.1:4273");
    return api.protocol === "http:" && ["127.0.0.1", "localhost"].includes(api.hostname);
  } catch {
    return false;
  }
}

export function authorize(risk: Risk): void {
  if (risk === "R0" || risk === "R1") return;
  if (risk === "R2" && process.env.MEMO_AGENT_MAINNET_ALLOW_R2 === "1") return;
  if (risk === "R2") throw new AgentError("POLICY_CONFIRMATION_REQUIRED", "R2 action requires a trusted mainnet service grant");
  if (risk === "R4" && hasLocalR4TestGrant()) return;
  throw new AgentError("POLICY_DENIED", `${risk} action is not authorized; production R4 approval integration is required`);
}
