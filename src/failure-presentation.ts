// Failure presentation: present a failed or waiting step the way the shared
// activity roadmap (Issue #291) requires — preserve the partial output already
// produced, pair it with an actionable canonical next step, surface bounded
// retries, and distinguish a real failure from a waiting condition
// (network / rate-limit / CI queue / service unavailable) that is NOT a code
// failure and instead waits with bounded exponential backoff. It builds on the
// shared event presentation model (Issue #306): partial output is redacted,
// escape-neutralized, and bounded by presentEvent before any surface renders it,
// and the outcome maps to the contract's canonical "failed" / "waiting" statuses
// rather than a surface-local message.
//
// Distinct from run-failure-taxonomy.ts: that report is metadata-only cause
// COUNTING for unattended runs (no error text, no partial output, no guidance).
// This module PRESENTS a single failure or waiting step to the user with its
// partial output and an actionable next step. The two are complementary; this
// module reuses the taxonomy's category names where they apply so the cause
// vocabulary stays consistent.
//
// Trust boundary: partial output is untrusted and may contain secrets or
// terminal control sequences; it is sanitized by the #306 mapper before
// presentation. Next-step guidance is fixed canonical text and never echoes
// untrusted content.

import { presentEvent } from "./event-presentation.js";
import type { PresentedEvent } from "./event-presentation.js";

export const FAILURE_PRESENTATION_SCHEMA = "oh-my-cli.failure-presentation";
export const FAILURE_PRESENTATION_VERSION = 1;

// The outcome classes. A waiting condition is explicitly NOT a failure (it does
// not count as a code failure); "ok" is included so classifyOutcome is total.
export const OUTCOME_CLASSES = ["ok", "failure", "waiting"] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

// Waiting conditions: transient external states that resolve with bounded
// exponential backoff rather than a code-fix. These are never code failures.
export const WAITING_CONDITIONS = [
  "network",
  "rate-limit",
  "ci-queue",
  "service-unavailable",
] as const;
export type WaitingCondition = (typeof WAITING_CONDITIONS)[number];

const WAITING_SET: ReadonlySet<string> = new Set(WAITING_CONDITIONS);

// True when the category is a transient waiting condition rather than a failure.
export function isWaitingCondition(category: string): boolean {
  return WAITING_SET.has(category);
}

// Classify a category as a failure or a waiting condition. (Success is reported
// elsewhere; this only distinguishes the two non-ok outcomes.)
export function classifyOutcome(category: string): Exclude<OutcomeClass, "ok"> {
  return isWaitingCondition(category) ? "waiting" : "failure";
}

// Canonical, actionable next-step guidance for one failure or waiting category.
// `retryable` marks categories where a bounded retry is appropriate (always true
// for waiting conditions; true for transient failures; false for denials that
// require a configuration or permission change).
export interface FailureGuidance {
  category: string;
  outcome: Exclude<OutcomeClass, "ok">;
  nextStep: string;
  retryable: boolean;
}

// The canonical guidance table. Failure categories align with the
// run-failure-taxonomy vocabulary where they apply; waiting conditions are the
// transient external states. The next-step text is fixed and actionable so a
// surface never invents recovery advice.
export const FAILURE_GUIDANCE: readonly FailureGuidance[] = [
  {
    category: "policy_denied",
    outcome: "failure",
    nextStep: "Review the command policy or approval mode; this command is not permitted as written.",
    retryable: false,
  },
  {
    category: "hook_denied",
    outcome: "failure",
    nextStep: "A hook denied this action; inspect the hook configuration before retrying.",
    retryable: false,
  },
  {
    category: "approval_denied",
    outcome: "failure",
    nextStep: "The approval was denied; re-request with a narrower action or adjust the approval mode.",
    retryable: false,
  },
  {
    category: "folder_trust_denied",
    outcome: "failure",
    nextStep: "Trust the workspace folder before running mutations in it.",
    retryable: false,
  },
  {
    category: "read_only_denied",
    outcome: "failure",
    nextStep: "This surface is read-only; run in a mode that permits the mutation.",
    retryable: false,
  },
  {
    category: "path_escape",
    outcome: "failure",
    nextStep: "The path escapes the workspace; confine the operation to the workspace.",
    retryable: false,
  },
  {
    category: "unknown_tool",
    outcome: "failure",
    nextStep: "The tool is not registered; check the tool name or enable the extension that provides it.",
    retryable: false,
  },
  {
    category: "tool_error",
    outcome: "failure",
    nextStep: "Inspect the preserved partial output and the tool input; fix the input and retry.",
    retryable: true,
  },
  {
    category: "provider_error",
    outcome: "failure",
    nextStep: "Check provider configuration and quota; retry once a transient cause is cleared.",
    retryable: true,
  },
  {
    category: "timeout",
    outcome: "failure",
    nextStep: "The operation timed out; retry, or raise the timeout for long-running steps.",
    retryable: true,
  },
  {
    category: "network",
    outcome: "waiting",
    nextStep: "Network unreachable; waiting with bounded exponential backoff.",
    retryable: true,
  },
  {
    category: "rate-limit",
    outcome: "waiting",
    nextStep: "Rate-limited by the provider; waiting with bounded exponential backoff.",
    retryable: true,
  },
  {
    category: "ci-queue",
    outcome: "waiting",
    nextStep: "Waiting for the CI queue; retrying with bounded exponential backoff.",
    retryable: true,
  },
  {
    category: "service-unavailable",
    outcome: "waiting",
    nextStep: "Service temporarily unavailable; waiting with bounded exponential backoff.",
    retryable: true,
  },
  {
    category: "other",
    outcome: "failure",
    nextStep: "Inspect the preserved partial output; retry only with new evidence.",
    retryable: true,
  },
];

// Look up canonical guidance for a category. Waiting conditions resolve to their
// waiting guidance; unrecognized failure categories fall back to the bounded
// "other" guidance so presentation stays stable and actionable.
export function guidanceFor(category: string): FailureGuidance {
  const found = FAILURE_GUIDANCE.find((g) => g.category === category);
  if (found) return found;
  const fallback = FAILURE_GUIDANCE.find((g) => g.category === "other");
  // "other" is always defined above; this guard keeps the return type total.
  return (
    fallback ?? {
      category: "other",
      outcome: "failure",
      nextStep: "Inspect the preserved partial output; retry only with new evidence.",
      retryable: true,
    }
  );
}

// Default bounded retry limit for retryable categories.
export const DEFAULT_MAX_ATTEMPTS = 3;

// A failed or waiting step, ready for a surface to render. `partial` is the
// preserved partial output (sanitized by the #306 mapper); null when the step
// produced none.
export interface FailurePresentation {
  schema: string;
  version: number;
  category: string;
  outcome: Exclude<OutcomeClass, "ok">;
  partial: PresentedEvent | null;
  nextStep: string;
  retryable: boolean;
  attempt: number;
  retriesExhausted: boolean;
}

// A failure or waiting step as observed by the runtime. `partialSummary` /
// `partialDetail` are raw and untrusted; they are sanitized before presentation.
export interface FailureInput {
  category: string;
  partialSummary?: string;
  partialDetail?: string;
  attempt?: number;
  maxAttempts?: number;
}

// Present a failed or waiting step: classify the outcome (failure vs waiting),
// preserve any partial output through the #306 mapper (redacted, neutralized,
// bounded), attach the canonical actionable next step, and surface bounded-retry
// state. Never throws for a recognized outcome; an unrecognized failure category
// falls back to the canonical "other" guidance.
export function presentFailure(input: FailureInput): FailurePresentation {
  const guidance = guidanceFor(input.category);
  const outcome = guidance.outcome;
  const hasPartial =
    (input.partialSummary !== undefined && input.partialSummary !== "") ||
    (input.partialDetail !== undefined && input.partialDetail !== "");
  const partial = hasPartial
    ? presentEvent({
        kind: "result",
        status: outcome === "waiting" ? "waiting" : "failed",
        summary: input.partialSummary,
        detail: input.partialDetail,
      })
    : null;
  const attempt = Math.max(1, Math.floor(input.attempt ?? 1));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retriesExhausted = guidance.retryable && attempt >= maxAttempts;
  return {
    schema: FAILURE_PRESENTATION_SCHEMA,
    version: FAILURE_PRESENTATION_VERSION,
    category: guidance.category,
    outcome,
    partial,
    nextStep: guidance.nextStep,
    retryable: guidance.retryable,
    attempt,
    retriesExhausted,
  };
}

// The canonical failure/waiting guidance model exposed to users and surfaces.
export interface FailureModel {
  schema: string;
  version: number;
  outcomes: readonly OutcomeClass[];
  waitingConditions: readonly WaitingCondition[];
  defaultMaxAttempts: number;
  guidance: FailureGuidance[];
}

// Build the canonical guidance model. Pure and side-effect-free.
export function collectFailureModel(): FailureModel {
  return {
    schema: FAILURE_PRESENTATION_SCHEMA,
    version: FAILURE_PRESENTATION_VERSION,
    outcomes: [...OUTCOME_CLASSES],
    waitingConditions: [...WAITING_CONDITIONS],
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
    guidance: FAILURE_GUIDANCE.map((g) => ({ ...g })),
  };
}

// A redacted, human-readable rendering of the canonical guidance model.
export function formatFailureModel(model: FailureModel): string {
  const lines: string[] = [
    "Failure Presentation Model",
    "─".repeat(40),
    `Schema: ${model.schema} v${model.version}`,
    `Outcomes: ${model.outcomes.join(" · ")}`,
    `Waiting conditions: ${model.waitingConditions.join(" · ")}`,
    `Default max attempts: ${model.defaultMaxAttempts}`,
    "",
    "Guidance (category [outcome] retryable -> next step):",
    ...model.guidance.map(
      (g) => `  ${g.category} [${g.outcome}] ${g.retryable ? "retryable" : "no-retry"} -> ${g.nextStep}`,
    ),
  ];
  return lines.join("\n");
}
