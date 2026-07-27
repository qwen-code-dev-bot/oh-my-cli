// Per-message (per-turn) usage observability (#241). The run already accumulates
// token totals and an estimated cost per round (#58); this module adds the two
// responsiveness metrics a user wants to see for each individual assistant turn:
// time-to-first-token (TTFT) and output throughput (tok/s). The computation is
// pure and timestamp-driven so it is deterministic under test, and the rendered
// line is redacted and degrades gracefully — when a metric is unavailable it is
// omitted rather than guessed.

import { formatCostUsd } from "./cost.js";
import { redactSecrets } from "./permission-impact.js";

export interface MessageTimingInput {
  /** Wall-clock just before the provider request was issued. */
  requestStartMs: number | null;
  /** Wall-clock when the first streamed text token arrived (null if none). */
  firstTokenMs: number | null;
  /** Wall-clock when the stream completed. */
  generationEndMs: number | null;
  /** Completion tokens reported for this turn (null when usage is absent). */
  completionTokens: number | null;
}

export interface MessageTiming {
  /** Milliseconds from request start to the first streamed token; null when no
   *  text token arrived or timing is unavailable. */
  ttftMs: number | null;
  /** Output tokens per second over the call wall-time; null when there were no
   *  completion tokens or no measurable elapsed time. */
  tokensPerSecond: number | null;
}

// Derive TTFT and throughput from raw timestamps. TTFT is the wait until the
// first streamed token; throughput is the turn's completion tokens divided by
// the whole-call wall-time (an effective rate that stays defined even when a
// turn produces a single chunk). Every degenerate input degrades to null rather
// than dividing by zero or reporting a fabricated figure.
export function computeMessageTiming(input: MessageTimingInput): MessageTiming {
  const { requestStartMs, firstTokenMs, generationEndMs, completionTokens } = input;

  const ttftMs =
    requestStartMs != null && firstTokenMs != null
      ? Math.max(0, Math.round(firstTokenMs - requestStartMs))
      : null;

  let tokensPerSecond: number | null = null;
  if (
    requestStartMs != null &&
    generationEndMs != null &&
    typeof completionTokens === "number" &&
    completionTokens > 0
  ) {
    const seconds = (generationEndMs - requestStartMs) / 1000;
    if (seconds > 0) {
      tokensPerSecond = Math.round((completionTokens / seconds) * 100) / 100;
    }
  }

  return { ttftMs, tokensPerSecond };
}

// The per-message usage record rendered for a turn: the running token totals and
// estimated cost reused from existing accounting (#58), plus the turn's TTFT and
// throughput. `costKnown` is false when the conservative fallback rate was used.
export interface MessageUsage {
  round: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costKnown: boolean;
  ttftMs: number | null;
  tokensPerSecond: number | null;
}

// Render a compact, redacted one-line per-message usage summary. Unavailable
// metrics (TTFT, tok/s) are omitted rather than shown as zero. The cost is
// always labeled an estimate; the whole line is secret-redacted as a final guard
// even though it carries only numeric fields.
export function formatMessageUsageLine(usage: MessageUsage): string {
  const parts: string[] = [
    `tokens ${usage.totalTokens} (prompt ${usage.promptTokens}, completion ${usage.completionTokens})`,
    `cost ${formatCostUsd(usage.estimatedCostUsd)} (est${usage.costKnown ? "" : ", fallback rate"})`,
  ];
  if (usage.ttftMs != null) parts.push(`TTFT ${usage.ttftMs}ms`);
  if (usage.tokensPerSecond != null) parts.push(`${usage.tokensPerSecond} tok/s`);
  return redactSecrets(parts.join(" · ")).text;
}
