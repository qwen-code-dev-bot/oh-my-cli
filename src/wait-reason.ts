// Wait reason: explains why a Goal is waiting with structured wait reasons.
//
// When a Goal is waiting (for model response, approval, tool execution,
// retry backoff, dependency, or user input), the system shows a structured
// wait reason with elapsed wait time. Wait state is bounded, redacted,
// and deterministic.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const WAIT_REASON_SCHEMA = "oh-my-cli.wait-reason";
export const WAIT_REASON_VERSION = 1;

// --- types ------------------------------------------------------------------

export type WaitReason =
  | "model-response"
  | "approval"
  | "tool-execution"
  | "retry-backoff"
  | "dependency"
  | "user-input";

const WAIT_REASON_LABELS: Record<WaitReason, string> = {
  "model-response": "Waiting for model response",
  "approval": "Waiting for approval",
  "tool-execution": "Waiting for tool execution",
  "retry-backoff": "Waiting for retry backoff",
  "dependency": "Waiting for dependency",
  "user-input": "Waiting for user input",
};

const WAIT_REASON_ICONS: Record<WaitReason, string> = {
  "model-response": "⏳",
  "approval": "🔒",
  "tool-execution": "🔧",
  "retry-backoff": "↻",
  "dependency": "⛓",
  "user-input": "👤",
};

export interface WaitState {
  schema: typeof WAIT_REASON_SCHEMA;
  v: typeof WAIT_REASON_VERSION;
  reason: WaitReason;
  /** When the wait started (epoch ms). */
  startedAt: number;
  /** Elapsed wait time in ms (computed). */
  elapsedMs: number;
  /** Optional detail (bounded, redacted). */
  detail?: string;
  /** Whether the Goal is currently waiting. */
  isWaiting: boolean;
}

// --- bounds -----------------------------------------------------------------

const MAX_DETAIL_LENGTH = 200;

function safeDetail(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_DETAIL_LENGTH
    ? redacted
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_DETAIL_LENGTH - 1))}…`;
}

// --- wait state management --------------------------------------------------

// Create a wait state.
export function setWaitReason(
  reason: WaitReason,
  startedAt: number = Date.now(),
  detail?: string,
): WaitState {
  return {
    schema: WAIT_REASON_SCHEMA,
    v: WAIT_REASON_VERSION,
    reason,
    startedAt,
    elapsedMs: 0,
    detail: detail !== undefined ? safeDetail(detail) : undefined,
    isWaiting: true,
  };
}

// Clear the wait state.
export function clearWaitReason(): WaitState | null {
  return null;
}

// Compute elapsed time for a wait state.
export function computeElapsed(waitState: WaitState, now: number = Date.now()): WaitState {
  if (!waitState.isWaiting) return waitState;
  return { ...waitState, elapsedMs: now - waitState.startedAt };
}

// --- formatting -------------------------------------------------------------

// Format elapsed milliseconds as a human-readable duration.
function formatElapsed(ms: number): string {
  // Issue #810: clamp negative elapsed ms (clock skew) to 0, matching activity-render.
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h${remainMinutes}m`;
}

// Format a wait state as a compact explanation.
export function formatWaitState(waitState: WaitState | null): string {
  if (!waitState || !waitState.isWaiting) {
    return "Not waiting.";
  }

  const icon = WAIT_REASON_ICONS[waitState.reason];
  const label = WAIT_REASON_LABELS[waitState.reason];
  const elapsed = formatElapsed(waitState.elapsedMs);
  const detail = waitState.detail ? ` — ${waitState.detail}` : "";

  return `${icon} ${label} (${elapsed})${detail}`;
}

// Get the human-readable label for a wait reason.
export function waitReasonLabel(reason: WaitReason): string {
  return WAIT_REASON_LABELS[reason];
}
