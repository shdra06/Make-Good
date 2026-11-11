// The life of one movement of money, as a state machine.
//
//   planned ──▶ queued ──▶ submitting ──▶ succeeded
//                 ▲            │  │  │
//                 │            │  │  └──▶ pending_provider ──▶ succeeded | failed_final
//                 │            │  └─────▶ unknown ──▶ succeeded | pending_provider | failed_final | failed_retryable
//                 │            └────────▶ failed_final | failed_retryable
//                 └── failed_retryable (an operator, or a rate-limit wait, sends it round again)
//
// "unknown" is the important one. It means we asked PayPal to move money and
// do not know whether it did. An operation leaves "unknown" only by asking
// PayPal, never by assuming.

import { ConflictError } from "../../platform/errors.ts";

export type OperationState =
  | "planned"
  | "queued"
  | "submitting"
  | "unknown"
  | "pending_provider"
  | "succeeded"
  | "failed_retryable"
  | "failed_final"
  | "cancelled";

const ALLOWED: Record<OperationState, readonly OperationState[]> = {
  planned: ["queued", "cancelled"],
  queued: ["submitting", "cancelled"],
  submitting: ["succeeded", "pending_provider", "unknown", "failed_retryable", "failed_final", "queued"],
  unknown: ["succeeded", "pending_provider", "failed_retryable", "failed_final"],
  pending_provider: ["succeeded", "failed_final"],
  failed_retryable: ["queued", "cancelled", "failed_final"],
  succeeded: [],
  failed_final: [],
  cancelled: [],
};

/** Nothing more will happen to an operation in one of these states. */
export const TERMINAL_STATES: readonly OperationState[] = ["succeeded", "failed_final", "cancelled"];

/** Money may have moved, or may still move, for an operation in one of these states. */
export const LIVE_STATES: readonly OperationState[] = ["queued", "submitting", "unknown", "pending_provider"];

export function canTransition(from: OperationState, to: OperationState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: OperationState, to: OperationState): void {
  if (!canTransition(from, to)) {
    throw new ConflictError("ILLEGAL_TRANSITION", `A payment operation cannot go from "${from}" to "${to}".`);
  }
}

export type BatchStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "executing"
  | "paused"
  | "completed"
  | "completed_with_failures"
  | "rejected"
  | "cancelled";

const BATCH_ALLOWED: Record<BatchStatus, readonly BatchStatus[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "rejected", "cancelled"],
  approved: ["executing", "cancelled"],
  executing: ["paused", "completed", "completed_with_failures", "cancelled"],
  paused: ["executing", "cancelled", "completed", "completed_with_failures"],
  completed: [],
  completed_with_failures: [],
  rejected: [],
  cancelled: [],
};

export function assertBatchTransition(from: BatchStatus, to: BatchStatus): void {
  if (!BATCH_ALLOWED[from].includes(to)) {
    throw new ConflictError("ILLEGAL_BATCH_TRANSITION", `A batch cannot go from "${from}" to "${to}".`);
  }
}
