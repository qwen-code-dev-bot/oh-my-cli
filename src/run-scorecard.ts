// Compare two privacy-safe run summaries (see src/run-summary.ts) into a
// deterministic scorecard for local review and CI. It reports the stable deltas
// between a baseline and a candidate run — outcome, elapsed time, retry/failure
// counts, and completed work — and flags a regression only when an *explicit*,
// documented threshold is crossed. It never invents a universal quality score:
// every row is evidence derived from the two summaries, and the output carries
// no prompts, secrets, host paths, session ids, or tool payloads.

import fs from "node:fs";
import { z } from "zod";
import { RUN_SUMMARY_SCHEMA, RUN_SUMMARY_VERSION } from "./run-summary.js";
import type { RunSummary } from "./run-summary.js";

export const RUN_SCORECARD_SCHEMA = "oh-my-cli.scorecard";
export const RUN_SCORECARD_VERSION = 1;

// A persisted RunSummary, validated on read so malformed or incompatible inputs
// are rejected with an actionable message instead of producing a garbage diff.
// Mirrors the RunSummary interface in src/run-summary.ts exactly.
const RUN_SUMMARY_Z = z.object({
  schema: z.literal(RUN_SUMMARY_SCHEMA),
  v: z.literal(RUN_SUMMARY_VERSION),
  outcome: z.enum(["success", "failure"]),
  exitCode: z.number().int(),
  reason: z.string(),
  elapsedMs: z.number().nonnegative(),
  rounds: z.number().int().nonnegative(),
  toolCalls: z.object({
    total: z.number().int().nonnegative(),
    byName: z.record(z.number().int().nonnegative()),
  }),
  toolFailures: z.object({
    total: z.number().int().nonnegative(),
    byName: z.record(z.number().int().nonnegative()),
  }),
  tokens: z
    .object({
      prompt: z.number().int().nonnegative(),
      completion: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  // Added after v1; older summaries omit it, so default to null on read.
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
  evidence: z.object({
    sessionId: z.string(),
    sessionPath: z.string().nullable(),
  }),
});

/**
 * Thrown when a summary input cannot be read, parsed, or validated. Carries an
 * actionable message; the CLI maps it to a distinct usage/exit code.
 */
export class ScorecardInputError extends Error {
  readonly reason = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScorecardInputError";
  }
}

/**
 * Explicit regression thresholds. A candidate is flagged as a regression only
 * when one of these documented rules is crossed:
 *   - outcome regressed from success to failure (always a regression);
 *   - tool failures rose more than `failureDelta` above the baseline;
 *   - elapsed time rose more than `elapsedRatio` above the baseline (e.g. 0.25
 *     tolerates a +25% slowdown).
 */
export interface RegressionThresholds {
  /** Fractional elapsed-time increase tolerated before flagging (0.25 = +25%). */
  elapsedRatio: number;
  /** Absolute tool-failure increase tolerated before flagging. */
  failureDelta: number;
}

export const DEFAULT_THRESHOLDS: RegressionThresholds = {
  elapsedRatio: 0.25,
  failureDelta: 0,
};

// A single comparable metric. `change` is neutral evidence ("what moved"), kept
// separate from `regression` ("did it cross a threshold") so the scorecard never
// smuggles in an opinionated quality judgement.
export interface MetricRow {
  metric: string;
  baseline: number | string | null;
  candidate: number | string | null;
  /** candidate - baseline for numeric metrics; null for text or n/a metrics. */
  delta: number | null;
  change: "up" | "down" | "flat" | "same" | "changed";
  regression: boolean;
}

export interface RunScorecard {
  schema: typeof RUN_SCORECARD_SCHEMA;
  v: typeof RUN_SCORECARD_VERSION;
  /** True when any documented threshold was crossed (drives the exit code). */
  regression: boolean;
  outcomeRegressed: boolean;
  failuresRegressed: boolean;
  elapsedRegressed: boolean;
  /** The thresholds used, so a verdict is reproducible and auditable. */
  thresholds: RegressionThresholds;
  rows: MetricRow[];
}

// --- input parsing ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A headless NDJSON `summary` event: { type: "summary", summary: RunSummary }.
function isSummaryEvent(value: unknown): value is { type: "summary"; summary: unknown } {
  return isRecord(value) && value.type === "summary" && isRecord(value.summary);
}

function looksLikeSummary(value: unknown): boolean {
  return isRecord(value) && value.schema === RUN_SUMMARY_SCHEMA;
}

// Pull every candidate summary object out of the raw text. Accepts either a bare
// (possibly pretty-printed) RunSummary object or a headless NDJSON stream from
// which the `summary` event is extracted.
function extractSummaryObjects(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // A single JSON document first (handles pretty-printed bare summaries).
  try {
    const obj = JSON.parse(trimmed);
    if (isSummaryEvent(obj)) return [obj.summary];
    if (looksLikeSummary(obj)) return [obj];
  } catch {
    /* not a single JSON document; fall through to line-delimited scan */
  }

  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (isSummaryEvent(obj)) out.push(obj.summary);
    else if (looksLikeSummary(obj)) out.push(obj);
  }
  return out;
}

/**
 * Parse and validate a single RunSummary from raw text. `label` names the input
 * ("baseline"/"candidate") in error messages. The last summary found is used so
 * a stream with a single terminal summary is handled naturally.
 */
export function parseRunSummary(text: string, label = "input"): RunSummary {
  const found = extractSummaryObjects(text);
  if (found.length === 0) {
    throw new ScorecardInputError(
      `No run summary found in ${label}: expected a "${RUN_SUMMARY_SCHEMA}" object ` +
        `or a headless NDJSON stream containing a "summary" event.`,
    );
  }
  const raw = found[found.length - 1];

  // A clear compatibility verdict before full structural validation.
  if (isRecord(raw) && (raw.schema !== RUN_SUMMARY_SCHEMA || raw.v !== RUN_SUMMARY_VERSION)) {
    throw new ScorecardInputError(
      `Incompatible run summary in ${label}: expected schema "${RUN_SUMMARY_SCHEMA}" ` +
        `v${RUN_SUMMARY_VERSION}, found schema ${JSON.stringify(raw.schema ?? null)} ` +
        `v${JSON.stringify(raw.v ?? null)}.`,
    );
  }

  const parsed = RUN_SUMMARY_Z.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ScorecardInputError(`Malformed run summary in ${label}: ${issues}.`);
  }
  return parsed.data;
}

/** Read a summary file and parse it, translating fs errors into actionable ones. */
export function readRunSummaryFile(filePath: string, label = "input"): RunSummary {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ScorecardInputError(`Cannot read ${label} summary: file not found: ${filePath}`);
    }
    throw new ScorecardInputError(`Cannot read ${label} summary at ${filePath}: ${e.message}`);
  }
  return parseRunSummary(text, label);
}

/** Parse the CLI threshold options, rejecting invalid values with a clear message. */
export function parseScorecardThresholds(
  ratioStr: string,
  deltaStr: string,
): RegressionThresholds {
  const elapsedRatio = Number(ratioStr);
  if (!Number.isFinite(elapsedRatio) || elapsedRatio < 0) {
    throw new ScorecardInputError(
      `Invalid --max-elapsed-ratio "${ratioStr}": expected a non-negative number ` +
        `(e.g. 0.25 tolerates a +25% slowdown).`,
    );
  }
  const failureDelta = Number(deltaStr);
  if (!Number.isInteger(failureDelta) || failureDelta < 0) {
    throw new ScorecardInputError(
      `Invalid --max-failure-delta "${deltaStr}": expected a non-negative integer.`,
    );
  }
  return { elapsedRatio, failureDelta };
}

// --- comparison -------------------------------------------------------------

function numChange(delta: number): "up" | "down" | "flat" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/**
 * Compare two validated summaries into a deterministic scorecard. Rows are in a
 * fixed order and contain only metadata deltas — no paths, secrets, or payloads.
 */
export function compareRunSummaries(
  baseline: RunSummary,
  candidate: RunSummary,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
): RunScorecard {
  const outcomeRegressed =
    baseline.outcome === "success" && candidate.outcome === "failure";

  const failureDelta = candidate.toolFailures.total - baseline.toolFailures.total;
  const failuresRegressed = failureDelta > thresholds.failureDelta;

  const elapsedDelta = candidate.elapsedMs - baseline.elapsedMs;
  const elapsedRegressed =
    baseline.elapsedMs > 0 && candidate.elapsedMs > baseline.elapsedMs * (1 + thresholds.elapsedRatio);

  const baselineWork = baseline.toolCalls.total - baseline.toolFailures.total;
  const candidateWork = candidate.toolCalls.total - candidate.toolFailures.total;
  const workDelta = candidateWork - baselineWork;

  const roundsDelta = candidate.rounds - baseline.rounds;
  const callsDelta = candidate.toolCalls.total - baseline.toolCalls.total;

  const baselineTokens = baseline.tokens ? baseline.tokens.total : null;
  const candidateTokens = candidate.tokens ? candidate.tokens.total : null;
  const tokensDelta =
    baselineTokens !== null && candidateTokens !== null ? candidateTokens - baselineTokens : null;

  const rows: MetricRow[] = [
    {
      metric: "outcome",
      baseline: baseline.outcome,
      candidate: candidate.outcome,
      delta: null,
      change: baseline.outcome === candidate.outcome ? "same" : "changed",
      regression: outcomeRegressed,
    },
    {
      metric: "reason",
      baseline: baseline.reason,
      candidate: candidate.reason,
      delta: null,
      change: baseline.reason === candidate.reason ? "same" : "changed",
      regression: false,
    },
    {
      metric: "elapsed ms",
      baseline: baseline.elapsedMs,
      candidate: candidate.elapsedMs,
      delta: elapsedDelta,
      change: numChange(elapsedDelta),
      regression: elapsedRegressed,
    },
    {
      metric: "rounds",
      baseline: baseline.rounds,
      candidate: candidate.rounds,
      delta: roundsDelta,
      change: numChange(roundsDelta),
      regression: false,
    },
    {
      metric: "tool calls",
      baseline: baseline.toolCalls.total,
      candidate: candidate.toolCalls.total,
      delta: callsDelta,
      change: numChange(callsDelta),
      regression: false,
    },
    {
      metric: "tool failures",
      baseline: baseline.toolFailures.total,
      candidate: candidate.toolFailures.total,
      delta: failureDelta,
      change: numChange(failureDelta),
      regression: failuresRegressed,
    },
    {
      metric: "completed work",
      baseline: baselineWork,
      candidate: candidateWork,
      delta: workDelta,
      change: numChange(workDelta),
      regression: false,
    },
    {
      metric: "tokens total",
      baseline: baselineTokens,
      candidate: candidateTokens,
      delta: tokensDelta,
      change:
        baselineTokens === null && candidateTokens === null
          ? "same"
          : tokensDelta === null
            ? "changed"
            : numChange(tokensDelta),
      regression: false,
    },
  ];

  return {
    schema: RUN_SCORECARD_SCHEMA,
    v: RUN_SCORECARD_VERSION,
    regression: outcomeRegressed || failuresRegressed || elapsedRegressed,
    outcomeRegressed,
    failuresRegressed,
    elapsedRegressed,
    thresholds,
    rows,
  };
}

// --- formatting -------------------------------------------------------------

function fmtVal(v: number | string | null): string {
  return v === null ? "n/a" : String(v);
}

function formatRowValue(row: MetricRow): string {
  const unchanged =
    (row.change === "same" || row.change === "flat") &&
    row.baseline !== null &&
    row.baseline === row.candidate;
  if (unchanged) return fmtVal(row.baseline);
  let s = `${fmtVal(row.baseline)} -> ${fmtVal(row.candidate)}`;
  if (row.delta !== null) {
    s += ` (${row.delta >= 0 ? "+" : ""}${row.delta}, ${row.change})`;
  }
  return s;
}

// A deterministic, human-readable scorecard. Rows are aligned and ordered as in
// the scorecard object; regressions are tagged inline and summarised at the end.
export function formatScorecard(scorecard: RunScorecard): string {
  const lines: string[] = [];
  lines.push(`Run scorecard (${scorecard.schema} v${scorecard.v})`);

  const width = Math.max(...scorecard.rows.map((r) => r.metric.length));
  for (const row of scorecard.rows) {
    const label = `${row.metric}:`.padEnd(width + 1);
    const tag = row.regression ? "  [REGRESSION]" : "";
    lines.push(`  ${label} ${formatRowValue(row)}${tag}`);
  }

  lines.push(
    `  ${"thresholds:".padEnd(width + 1)} elapsed ratio <= ${scorecard.thresholds.elapsedRatio}, ` +
      `failure delta <= ${scorecard.thresholds.failureDelta}`,
  );

  if (!scorecard.regression) {
    lines.push("Result: no regression detected (exit 0)");
    return lines.join("\n");
  }

  const crossed: string[] = [];
  if (scorecard.outcomeRegressed) crossed.push("outcome regressed (success -> failure)");
  if (scorecard.failuresRegressed) {
    crossed.push(`tool failures rose more than ${scorecard.thresholds.failureDelta} above baseline`);
  }
  if (scorecard.elapsedRegressed) {
    crossed.push(
      `elapsed time rose more than ${Math.round(scorecard.thresholds.elapsedRatio * 100)}% above baseline`,
    );
  }
  lines.push(`Result: REGRESSION (exit 1)`);
  for (const reason of crossed) lines.push(`  - ${reason}`);
  return lines.join("\n");
}
