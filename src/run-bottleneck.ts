// A privacy-safe wall-time bottleneck report for unattended (`-p`) runs. It ranks
// tools and approval gates by wall-time and call count so an operator can answer
// "where did this long run spend its time?" without parsing raw logs: a slow tool
// surfaces as a `tool` bottleneck, a long human-approval wait as an `approval`
// bottleneck. It is opt-in (`--bottleneck`), bounded (a fixed head of ranked
// entries), and metadata-only — it carries tool names, wall-time, and counts, and
// has no channel for prompts, file contents, secrets, or raw tool payloads. The
// schema is stable and deterministic so CI can retain and diff it.

export const BOTTLENECK_REPORT_SCHEMA = "oh-my-cli.bottleneck";
export const BOTTLENECK_REPORT_VERSION = 1;

// Bound the number of ranked entries so a pathological run cannot inflate the
// report into high-cardinality output. Entries beyond the head are not listed;
// their count is reported in `truncated`.
const MAX_BOTTLENECK_ENTRIES = 16;

// Tool names flow from model output; although only registered tool names are ever
// recorded (unknown tools are rejected before timing), bound and sanitize anyway
// so the report can never carry a runaway or control-laced name.
const MAX_NAME = 256;

export type BottleneckKind = "tool" | "approval";

export interface BottleneckEntry {
  kind: BottleneckKind;
  name: string;
  // Total wall-time spent in this tool's execution (kind "tool") or waiting at
  // its approval gate (kind "approval"), summed across all calls, in milliseconds.
  wallMs: number;
  calls: number;
}

export interface BottleneckReport {
  schema: typeof BOTTLENECK_REPORT_SCHEMA;
  v: typeof BOTTLENECK_REPORT_VERSION;
  // Total run wall-time, for context (the entries sum to the tool/approval
  // portion of it; provider/model time is intentionally out of scope).
  elapsedMs: number;
  // Ranked by wall-time (desc), head-bound to MAX_BOTTLENECK_ENTRIES.
  entries: BottleneckEntry[];
  // Count of distinct entries that fell off the head bound (0 when none).
  truncated: number;
}

// Accumulates per-tool execution and per-approval-gate wall-time across a run.
export interface BottleneckCollector {
  recordTool(name: string, wallMs: number): void;
  recordApproval(name: string, wallMs: number): void;
}

interface Accumulator {
  wallMs: number;
  calls: number;
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, "_").trim();
  return cleaned.length <= MAX_NAME ? cleaned : cleaned.slice(0, MAX_NAME);
}

export function createBottleneckCollector(): {
  collector: BottleneckCollector;
  build: (elapsedMs: number) => BottleneckReport;
} {
  const tool = new Map<string, Accumulator>();
  const approval = new Map<string, Accumulator>();
  const bump = (map: Map<string, Accumulator>, name: string, wallMs: number): void => {
    const ms = Number.isFinite(wallMs) && wallMs > 0 ? wallMs : 0;
    const key = safeName(name);
    const acc = map.get(key) ?? { wallMs: 0, calls: 0 };
    acc.wallMs += ms;
    acc.calls += 1;
    map.set(key, acc);
  };
  const collector: BottleneckCollector = {
    recordTool: (name, wallMs) => bump(tool, name, wallMs),
    recordApproval: (name, wallMs) => bump(approval, name, wallMs),
  };
  return { collector, build: (elapsedMs) => buildBottleneckReport(elapsedMs, tool, approval) };
}

function buildBottleneckReport(
  elapsedMs: number,
  tool: Map<string, Accumulator>,
  approval: Map<string, Accumulator>,
): BottleneckReport {
  const all: BottleneckEntry[] = [];
  for (const [name, acc] of tool) {
    all.push({ kind: "tool", name, wallMs: Math.round(acc.wallMs), calls: acc.calls });
  }
  for (const [name, acc] of approval) {
    all.push({ kind: "approval", name, wallMs: Math.round(acc.wallMs), calls: acc.calls });
  }
  // Rank by wall-time desc, then call count desc, then a stable name/kind order so
  // identical runs produce byte-identical reports.
  all.sort(
    (a, b) =>
      b.wallMs - a.wallMs ||
      b.calls - a.calls ||
      a.name.localeCompare(b.name) ||
      a.kind.localeCompare(b.kind),
  );
  const entries = all.slice(0, MAX_BOTTLENECK_ENTRIES);
  return {
    schema: BOTTLENECK_REPORT_SCHEMA,
    v: BOTTLENECK_REPORT_VERSION,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    entries,
    truncated: Math.max(0, all.length - entries.length),
  };
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// A deterministic, human-readable rendering of the report. It contains only tool
// names, wall-time, and counts — there is no channel for prompt/tool/file content.
export function formatBottleneckReport(report: BottleneckReport): string {
  const lines: string[] = [];
  lines.push(`Bottleneck report (${report.schema} v${report.v})`);
  lines.push(`  elapsed:   ${formatElapsed(report.elapsedMs)}`);
  if (report.entries.length === 0) {
    lines.push("  bottlenecks: (no tool or approval activity recorded)");
  } else {
    lines.push(`  bottlenecks (top ${report.entries.length} by wall-time):`);
    report.entries.forEach((e, i) => {
      const label = `${e.kind} ${e.name}`;
      const callWord = e.calls === 1 ? "call" : "calls";
      lines.push(
        `    ${String(i + 1).padStart(2)}. ${label.padEnd(24)} ${formatElapsed(e.wallMs).padStart(9)}  (${e.calls} ${callWord})`,
      );
    });
  }
  if (report.truncated > 0) {
    lines.push(`  truncated: ${report.truncated} more entr${report.truncated === 1 ? "y" : "ies"} beyond the head bound`);
  }
  return lines.join("\n");
}
