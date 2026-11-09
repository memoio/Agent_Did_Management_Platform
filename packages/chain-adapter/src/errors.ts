export type ErrorCode =
  | "NETWORK_MISMATCH"
  | "DEPLOYMENT_MISMATCH"
  | "CHAIN_UNAVAILABLE"
  | "CHAIN_STATE_UNCERTAIN"
  | "INVALID_ACTION"
  | "INVALID_SIGNATURE"
  | "NONCE_CONFLICT"
  | "ACTION_EXPIRED"
  | "CONTRACT_REVERT"
  | "SUBMISSION_UNKNOWN"
  | "INSUFFICIENT_FUNDS";
export class ChainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable = false,
    public readonly mayHaveBroadcast = false,
  ) {
    super(code);
    this.name = "ChainError";
  }
  toJSON() {
    return {
      code: this.code,
      retryable: this.retryable,
      mayHaveBroadcast: this.mayHaveBroadcast,
    };
  }
}
export function requireChain(
  condition: unknown,
  code: ErrorCode = "INVALID_ACTION",
): asserts condition {
  if (!condition)
    throw new ChainError(
      code,
      code === "CHAIN_UNAVAILABLE" || code === "CHAIN_STATE_UNCERTAIN",
    );
}
// Never propagate provider errors: they may embed authenticated URLs, calldata or signatures.
export async function rpc<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw new ChainError("CHAIN_UNAVAILABLE", true);
  }
}
