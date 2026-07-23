// A privacy-safe failure-taxonomy report for unattended (`-p`) runs. Where the run
// summary (#40) reports a single terminal reason and counts tool failures by tool
// name, this report categorizes each tool failure by CAUSE — why it failed — into a
// fixed, bounded taxonomy (policy denial, hook denial, approval denial, path
// escape, tool error, unknown tool, folder-trust denial), plus the terminal reason
// class. It is opt-in (`--failure-taxonomy`) and metadata-only: it carries category
// names and counts and has no channel for error text, prompts, file contents,
// secrets, or raw tool payloads. The schema is stable and deterministic so CI can
// retain and diff it.

export const FAILURE_TAXONOMY_SCHEMA = "oh-my-cli.failure-taxonomy";
export const FAILURE_TAXONOMY_VERSION = 1;

// The fixed failure taxonomy, in canonical report order. Every tool failure is
// bucketed into exactly one category; anything unrecognized falls into "other" so
// the output stays bounded and stable even if a new failure path appears.
export const FAILURE_CATEGORIES = [
  "policy_denied",
  "hook_denied",
  "approval_denied",
  "folder_trust_denied",
  "read_only_denied",
  "path_escape",
  "unknown_tool",
  "tool_error",
  "other",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

export interface FailureTaxonomyReport {
  schema: typeof FAILURE_TAXONOMY_SCHEMA;
  v: typeof FAILURE_TAXONOMY_VERSION;
  // Total run wall-time, for context.
  elapsedMs: number;
  // Terminal reason class (e.g. completed, provider_error, max_rounds,
  // budget_reached) — the run-level outcome, distinct from per-tool failure causes.
  reason: string;
  // Total number of failed tool calls across the run.
  totalFailures: number;
  // Category → count, in canonical taxonomy order, including only non-zero
  // categories. Empty when no tool call failed.
  byCategory: Record<string, number>;
}

// Accumulates per-cause tool-failure counts across a run.
export interface FailureTaxonomyCollector {
  record(category: FailureCategory): void;
}

export function createFailureTaxonomyCollector(): {
  collector: FailureTaxonomyCollector;
  build: (elapsedMs: number, reason: string) => FailureTaxonomyReport;
} {
  const counts = new Map<FailureCategory, number>();
  const collector: FailureTaxonomyCollector = {
    record(category) {
      const key: FailureCategory = CATEGORY_SET.has(category) ? category : "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  };
  const build = (elapsedMs: number, reason: string): FailureTaxonomyReport =>
    buildFailureTaxonomyReport(elapsedMs, reason, counts);
  return { collector, build };
}

function buildFailureTaxonomyReport(
  elapsedMs: number,
  reason: string,
  counts: Map<FailureCategory, number>,
): FailureTaxonomyReport {
  const byCategory: Record<string, number> = {};
  let totalFailures = 0;
  // Emit in canonical taxonomy order, only non-zero categories, for stable output.
  for (const category of FAILURE_CATEGORIES) {
    const n = counts.get(category) ?? 0;
    if (n > 0) {
      byCategory[category] = n;
      totalFailures += n;
    }
  }
  return {
    schema: FAILURE_TAXONOMY_SCHEMA,
    v: FAILURE_TAXONOMY_VERSION,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    reason: sanitizeReason(reason),
    totalFailures,
    byCategory,
  };
}

// The terminal reason is one of a small fixed set produced by the agent loop; bound
// and strip control characters defensively so the report can never carry a runaway
// or control-laced value.
function sanitizeReason(reason: string): string {
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/g, "_").trim();
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// A deterministic, human-readable rendering of the report. It contains only
// category names, counts, and the terminal reason — there is no channel for error
// text, prompt/tool/file content, or secrets.
export function formatFailureTaxonomyReport(report: FailureTaxonomyReport): string {
  const lines: string[] = [];
  lines.push(`Failure taxonomy (${report.schema} v${report.v})`);
  lines.push(`  elapsed:   ${formatElapsed(report.elapsedMs)}`);
  lines.push(`  terminal:  ${report.reason}`);
  if (report.totalFailures === 0) {
    lines.push("  failures:  0 (none)");
  } else {
    lines.push(`  failures:  ${report.totalFailures}`);
    for (const category of Object.keys(report.byCategory)) {
      lines.push(`    ${category.padEnd(20)} ${report.byCategory[category]}`);
    }
  }
  return lines.join("\n");
}
