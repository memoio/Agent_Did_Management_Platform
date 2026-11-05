import { loadConfig, type Config } from "./config.js";
import { AgentError } from "./errors.js";
import { AgentDidService } from "./service.js";

export interface RuntimeBootstrapResult {
  doctor: Record<string, unknown>;
  ensure: Record<string, unknown>;
  status: Record<string, unknown>;
}

/**
 * Runtime adapters call this once during startup. It is intentionally offline:
 * doctor, identity ensure, and status never register, pair, or create an owner
 * relationship. Network access begins only when an explicit chain command runs.
 */
export async function bootstrapMemoAgentMainnetRuntime(config: Config = loadConfig()): Promise<RuntimeBootstrapResult> {
  if (process.env.MEMO_AGENT_MAINNET_MULTI_AGENT === "1" && !process.env.MEMO_AGENT_MAINNET_INSTALLATION_ID) {
    throw new AgentError("INSTALLATION_ID_REQUIRED", "Multi-Agent runtimes must provide a stable mainnet installation ID");
  }
  const service = new AgentDidService(config);
  try {
    const doctor = service.doctor();
    if (doctor.ready !== true) throw new AgentError("SECURE_STORAGE_UNAVAILABLE", "Mainnet Agent DID preflight is not ready");
    const ensure = service.ensureIdentity();
    const status = service.status();
    return { doctor, ensure, status };
  } finally {
    service.close();
  }
}
