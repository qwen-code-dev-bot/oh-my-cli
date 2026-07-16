// A privacy-safe execution summary for unattended (`-p`) runs. It reports how a
// run ended, its wall-clock duration, bounded model/tool activity, the terminal
// reason category, token totals when the provider reports them, and where the
// detailed evidence (the session log) can be found. It is opt-in (`--summary`)
// and carries only metadata: never prompts, file contents, secrets, or raw tool
// payloads. The schema is stable and deterministic so CI can retain and diff it.

import { formatCostUsd } from "./cost.js";

export const RUN_SUMMARY_SCHEMA = "oh-my-cli.summary";
export const RUN_SUMMARY_VERSION = 1;

// Bound the number of distinct tool names reported so a pathological or unknown
// tool cannot inflate the summary into high-cardinality output. Overflow names
// are rolled into a single "__other__" bucket.
const MAX_TOOL_NAMES = 16;

export interface RunSummaryToolStats {
  total: number;
  byName: Record<string, number>;
}

export interface RunSummaryTokens {
  prompt: number;
  completion: number;
  total: number;
}

export type RunSummaryOutcome = "success" | "failure";

export interface RunSummary {
  schema: typeof RUN_SUMMARY_SCHEMA;
  v: typeof RUN_SUMMARY_VERSION;
  outcome: RunSummaryOutcome;
  exitCode: number;
  // Terminal reason category (e.g. completed, provider_error, max_rounds, error).
  reason: string;
  elapsedMs: number;
  rounds: number;
  // Total transient provider retries across the run (0 when the provider never
  // failed transiently). Distinguishes an exhausted-retry failure from a
  // non-retryable one.
  retries: number;
  toolCalls: RunSummaryToolStats;
  toolFailures: RunSummaryToolStats;
  // Token totals across the whole run, or null when the provider did not report
  // usage ("token totals when available").
  tokens: RunSummaryTokens | null;
  // Estimated provider cost (USD) across the run, or null when usage was not
  // reported. An estimate from a bundled price table, not authoritative billing.
  estimatedCostUsd: number | null;
  evidence: {
    sessionId: string;
    // Host paths are redacted (home directory collapsed to ~) before they reach
    // the summary; null when no session path is available.
    sessionPath: string | null;
  };
}

export interface BuildRunSummaryInput {
  ok: boolean;
  exitCode: number;
  reason: string;
  elapsedMs: number;
  rounds: number;
  // Total transient provider retries; defaults to 0 when omitted.
  retries?: number;
  toolCalls: Record<string, number>;
  toolFailures: Record<string, number>;
  tokens: RunSummaryTokens | null;
  // Optional estimated provider cost (USD); defaults to null when omitted.
  estimatedCostUsd?: number | null;
  sessionId: string;
  sessionPath: string | null;
}

// Collapse a raw name→count map into a total plus a bounded, deterministic
// byName map. Names are sorted for stable output; overflow beyond MAX_TOOL_NAMES
// distinct names is aggregated into "__other__".
function toBoundedStats(byName: Record<string, number>): RunSummaryToolStats {
  let total = 0;
  const entries: Array<[string, number]> = [];
  for (const [name, count] of Object.entries(byName)) {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (n <= 0) continue;
    total += n;
    entries.push([name, n]);
  }
  entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

  const result: Record<string, number> = {};
  let other = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i < MAX_TOOL_NAMES) {
      result[entries[i][0]] = entries[i][1];
    } else {
      other += entries[i][1];
    }
  }
  if (other > 0) result["__other__"] = other;
  return { total, byName: result };
}

export function buildRunSummary(input: BuildRunSummaryInput): RunSummary {
  return {
    schema: RUN_SUMMARY_SCHEMA,
    v: RUN_SUMMARY_VERSION,
    outcome: input.ok ? "success" : "failure",
    exitCode: input.exitCode,
    reason: input.reason,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    rounds: Math.max(0, Math.floor(input.rounds)),
    retries: Math.max(0, Math.floor(input.retries ?? 0)),
    toolCalls: toBoundedStats(input.toolCalls),
    toolFailures: toBoundedStats(input.toolFailures),
    tokens: input.tokens
      ? {
          prompt: Math.max(0, Math.floor(input.tokens.prompt)),
          completion: Math.max(0, Math.floor(input.tokens.completion)),
          total: Math.max(0, Math.floor(input.tokens.total)),
        }
      : null,
    estimatedCostUsd:
      typeof input.estimatedCostUsd === "number" &&
      Number.isFinite(input.estimatedCostUsd) &&
      input.estimatedCostUsd >= 0
        ? input.estimatedCostUsd
        : null,
    evidence: {
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
    },
  };
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNames(byName: Record<string, number>): string {
  const names = Object.keys(byName).sort();
  if (names.length === 0) return "";
  return ` (${names.map((n) => `${n}×${byName[n]}`).join(", ")})`;
}

// A deterministic, human-readable rendering of the summary. It contains only the
// metadata fields above — there is no channel for prompt/tool/file content.
export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`Run summary (${summary.schema} v${summary.v})`);
  lines.push(`  outcome:   ${summary.outcome}`);
  lines.push(`  exit code: ${summary.exitCode}`);
  lines.push(`  reason:    ${summary.reason}`);
  lines.push(`  elapsed:   ${formatElapsed(summary.elapsedMs)}`);
  lines.push(`  rounds:    ${summary.rounds}`);
  lines.push(`  retries:   ${summary.retries}`);
  lines.push(`  tool calls: ${summary.toolCalls.total}${formatNames(summary.toolCalls.byName)}`);
  lines.push(`  tool failures: ${summary.toolFailures.total}${formatNames(summary.toolFailures.byName)}`);
  lines.push(
    summary.tokens
      ? `  tokens:    prompt ${summary.tokens.prompt}, completion ${summary.tokens.completion}, total ${summary.tokens.total}`
      : `  tokens:    n/a`,
  );
  lines.push(
    summary.estimatedCostUsd != null
      ? `  est. cost: ${formatCostUsd(summary.estimatedCostUsd)} (estimate, not billing)`
      : `  est. cost: n/a`,
  );
  const where = summary.evidence.sessionPath
    ? `session ${summary.evidence.sessionId} (${summary.evidence.sessionPath})`
    : `session ${summary.evidence.sessionId}`;
  lines.push(`  evidence:  ${where}`);
  return lines.join("\n");
}
