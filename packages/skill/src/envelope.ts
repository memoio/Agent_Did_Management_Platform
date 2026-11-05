import { randomUUID } from "node:crypto";
import type { AgentError } from "./errors.js";

export interface Envelope {
  schema: "memo.agent-cli-result/2";
  ok: boolean;
  action: string;
  requestId: string;
  operationId: string | null;
  data: unknown;
  warnings: string[];
  error: null | { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

export function success(action: string, data: unknown, operationId: string | null = null, warnings: string[] = []): Envelope {
  return { schema: "memo.agent-cli-result/2", ok: true, action, requestId: `req_${randomUUID()}`, operationId, data, warnings, error: null };
}

export function failure(action: string, error: AgentError): Envelope {
  return {
    schema: "memo.agent-cli-result/2",
    ok: false,
    action,
    requestId: `req_${randomUUID()}`,
    operationId: null,
    data: null,
    warnings: [],
    error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) },
  };
}
