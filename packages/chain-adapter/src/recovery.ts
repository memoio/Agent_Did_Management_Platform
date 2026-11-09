import { requireChain } from "./errors.js";
import type { OpbnbChainAdapter } from "./adapter.js";

export interface IndexCursor {
  blockNumber: number;
  blockHash: string;
}
/** Returns a batch for ONE platform database transaction: insert deduped events + update cursor.
 * On RPC errors/reorg, no batch/cursor is returned. Never persist a cursor before its events. */
export async function readNextWindow(
  adapter: OpbnbChainAdapter,
  cursor: IndexCursor,
  limit = 200,
) {
  requireChain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 2000);
  requireChain(
    (await adapter.readBlock(cursor.blockNumber)).blockHash ===
      cursor.blockHash,
    "CHAIN_STATE_UNCERTAIN",
  );
  const head = await adapter.readBlock();
  const from = cursor.blockNumber + 1;
  if (from > head.blockNumber) return { events: [], cursor, idle: true };
  const to = Math.min(head.blockNumber, from + limit - 1);
  const batch = await adapter.readEvents(from, to);
  // Detect an ancestor replacement while reading, even if no business event occurred there.
  requireChain(
    (await adapter.readBlock(cursor.blockNumber)).blockHash ===
      cursor.blockHash,
    "CHAIN_STATE_UNCERTAIN",
  );
  return {
    events: batch.events,
    cursor: { blockNumber: to, blockHash: batch.toBlockHash },
    idle: false,
  };
}

export type OperationState =
  | "CREATED"
  | "SIGNED"
  | "SUBMITTED"
  | "INCLUDED"
  | "CONFIRMED"
  | "REORGED"
  | "FAILED";
export interface OperationEvidence {
  state: OperationState;
  blockNumber?: number;
  blockHash?: string;
  confirmations?: number;
  txHash?: string;
  errorCode?: string;
  finalitySource?: "finalized-tag" | "confirmations";
}
/** A platform must append audit records; this helper never deletes historical evidence. */
export async function advanceOperation(
  adapter: OpbnbChainAdapter,
  previous: OperationEvidence,
  next: OperationEvidence,
): Promise<OperationEvidence> {
  if (next.state === "REORGED") {
    requireChain(
      ["SUBMITTED", "INCLUDED", "CONFIRMED"].includes(previous.state) &&
        previous.blockNumber !== undefined &&
        previous.blockHash,
      "INVALID_ACTION",
    );
    const canonical = await adapter.readBlock(previous.blockNumber);
    requireChain(
      canonical.blockHash !== previous.blockHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    return { ...previous, state: "REORGED" };
  }
  // Older/non-final updates must never demote an already confirmed operation.
  if (previous.state === "CONFIRMED") return previous;
  if (previous.state === "FAILED") return previous;
  const allowed: Record<OperationState, OperationState[]> = {
    CREATED: ["SIGNED", "FAILED"],
    SIGNED: ["SUBMITTED", "FAILED"],
    SUBMITTED: ["INCLUDED", "FAILED"],
    INCLUDED: ["CONFIRMED", "FAILED"],
    CONFIRMED: [],
    REORGED: ["SUBMITTED", "FAILED"],
    FAILED: [],
  };
  if (next.state === previous.state) {
    if (previous.blockHash && next.blockHash !== previous.blockHash)
      return previous;
    if ((next.confirmations ?? 0) < (previous.confirmations ?? 0))
      return previous;
  } else
    requireChain(
      allowed[previous.state].includes(next.state),
      "INVALID_ACTION",
    );
  if (next.state === "INCLUDED" || next.state === "CONFIRMED") {
    requireChain(
      next.blockNumber !== undefined && next.blockHash && next.txHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    if (previous.state === "INCLUDED") {
      requireChain(
        previous.txHash === next.txHash &&
          previous.blockHash === next.blockHash &&
          previous.blockNumber === next.blockNumber,
        "CHAIN_STATE_UNCERTAIN",
      );
    }
    const finality = await adapter.evaluateFinality(
      next.blockNumber,
      next.blockHash,
    );
    if (next.state === "CONFIRMED")
      requireChain(finality.confirmed, "CHAIN_STATE_UNCERTAIN");
    return {
      ...next,
      confirmations: finality.confirmations,
      finalitySource: finality.finalitySource,
    };
  }
  if (next.state === "FAILED")
    requireChain(
      next.errorCode &&
        next.errorCode !== "SUBMISSION_UNKNOWN" &&
        next.errorCode !== "CHAIN_UNAVAILABLE" &&
        next.errorCode !== "CHAIN_STATE_UNCERTAIN",
    );
  // REORGED resubmission requires the platform to revalidate the original nonce/intent.
  return next;
}
