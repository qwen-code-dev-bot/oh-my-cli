// Redacted performance diagnostics with declared budgets (Issue #572, roadmap
// #286's first step: measure and define budgets before optimizing anything).
// --perf-report attributes wall time to bounded local phases — workspace file
// discovery, session-store scan, a bounded turn-log scan, and a memory
// snapshot — compares each against versioned declared budgets, and renders a
// deterministic, redacted report with honest ok/exceeds verdicts. Strictly
// read-only: every phase is a read; nothing is written to the workspace, the
// session store, or any cache. Privacy: paths are home-collapsed, file
// contents and prompts never appear, and cardinality is bounded.

import fs from "node:fs";
import path from "node:path";
import { redactHomePath } from "./permission-impact.js";
import { IgnoreSet } from "./discovery.js";
import { collectSessionSummaries } from "./session-summary.js";
import { loadTurnLog } from "./turn-checkpoint.js";
import type { SessionStore } from "./session.js";
import type { Workspace } from "./workspace.js";

export const PERF_REPORT_SCHEMA = "oh-my-cli.perf" as const;
export const PERF_REPORT_VERSION = 1 as const;

// Declared budgets (versioned with the schema). Exceeding a budget is
// reported, never hidden — and is not itself an error.
export const PERF_BUDGETS = {
  discoveryMs: 2_000,
  storeScanMs: 500,
  turnLogScanMs: 1_000,
  heapUsedBytes: 512 * 1024 * 1024,
} as const;

// Walk bounds keep discovery responsive in very large trees; truncation is
// reported honestly in the phase detail.
const PERF_WALK_MAX_FILES = 50_000;
const PERF_WALK_MAX_DEPTH = 32;
const PERF_WALK_DEADLINE_MS = PERF_BUDGETS.discoveryMs + 1_000;
/** Turn logs are only scanned for the newest N sessions. */
export const PERF_TURN_LOG_SCAN_LIMIT = 20;

// Same skip set as the other read-only walkers (repo-map / discovery).
const PERF_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage", ".git",
]);

export type PerfVerdict = "ok" | "exceeds";
export type PerfPhaseName = "discovery" | "store-scan" | "turn-log-scan" | "memory";

export interface PerfPhase {
  name: PerfPhaseName;
  measured: number;
  unit: "ms" | "bytes";
  budget: number;
  verdict: PerfVerdict;
  /** Bounded, redacted detail (counts, truncation notes). */
  detail: string;
}

export interface PerfReport {
  schema: typeof PERF_REPORT_SCHEMA;
  v: typeof PERF_REPORT_VERSION;
  workspace: string;
  phases: PerfPhase[];
  overall: PerfVerdict;
}

export function phaseVerdict(measured: number, budget: number): PerfVerdict {
  return measured <= budget ? "ok" : "exceeds";
}

export function overallVerdict(phases: readonly PerfPhase[]): PerfVerdict {
  return phases.some((p) => p.verdict === "exceeds") ? "exceeds" : "ok";
}

export interface DiscoveryWalkResult {
  files: number;
  dirs: number;
  truncated: boolean;
}

/**
 * Bounded, symlink-safe counting walk with the standard ignore rules.
 * Reads directory entries only — file contents are never opened, so this
 * measures discovery cost itself. Truncation is reported, never silent.
 */
export function walkWorkspaceDiscovery(
  workspace: Workspace,
  opts: { now?: () => number } = {},
): DiscoveryWalkResult {
  const now = opts.now ?? Date.now;
  const deadline = now() + PERF_WALK_DEADLINE_MS;
  const ignoreSet = IgnoreSet.load(workspace);
  let files = 0;
  let dirs = 0;
  let truncated = false;

  const toRel = (abs: string): string =>
    path.relative(workspace.root, abs).split(path.sep).join("/");

  const stack: Array<{ abs: string; depth: number }> = [{ abs: workspace.root, depth: 0 }];
  while (stack.length > 0) {
    if (files >= PERF_WALK_MAX_FILES || now() > deadline) {
      truncated = true;
      break;
    }
    const { abs, depth } = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abort
    }
    for (const ent of dirents) {
      if (files >= PERF_WALK_MAX_FILES || now() > deadline) {
        truncated = true;
        break;
      }
      // Never follow symlinks: confines the walk and avoids cycles/escape.
      if (ent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || PERF_SKIP_DIRS.has(ent.name)) continue;
        if (ignoreSet.isIgnored(toRel(childAbs), true)) continue;
        if (depth + 1 > PERF_WALK_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        dirs++;
        stack.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (ignoreSet.isIgnored(toRel(childAbs), false)) continue;
        files++;
      }
    }
  }
  return { files, dirs, truncated };
}

export interface CollectPerfReportOptions {
  workspace: Workspace;
  store: SessionStore;
  now?: () => number;
}

/** Measure all phases in a fixed order. Read-only; never writes anything. */
export function collectPerfReport(opts: CollectPerfReportOptions): PerfReport {
  const now = opts.now ?? Date.now;
  const time = <T>(fn: () => T): { value: T; ms: number } => {
    const start = now();
    const value = fn();
    return { value, ms: Math.max(0, now() - start) };
  };

  // Phase 1: workspace file discovery (bounded counting walk).
  const discovery = time(() => walkWorkspaceDiscovery(opts.workspace, { now }));
  const discoveryDetail =
    `${discovery.value.files} files, ${discovery.value.dirs} dirs` +
    (discovery.value.truncated ? " (walk truncated at a bound)" : "");

  // Phase 2: session-store scan (summaries for every session).
  const storeScan = time(() => collectSessionSummaries(opts.store, { now }));
  const storeScanDetail = `${storeScan.value.length} session(s)`;

  // Phase 3: bounded turn-log scan (newest N sessions only).
  const turnLogScan = time(() => {
    const newest = [...storeScan.value]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, PERF_TURN_LOG_SCAN_LIMIT);
    let checkpoints = 0;
    for (const summary of newest) {
      checkpoints += loadTurnLog(opts.store, summary.id).checkpoints.length;
    }
    return { scanned: newest.length, checkpoints };
  });
  const turnLogDetail =
    `${turnLogScan.value.scanned} turn log(s), ${turnLogScan.value.checkpoints} checkpoint(s)`;

  // Phase 4: memory snapshot (process-local; heap used vs declared budget).
  const mem = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
  const rssMb = Math.round(mem.rss / (1024 * 1024));

  const phases: PerfPhase[] = [
    {
      name: "discovery",
      measured: discovery.ms,
      unit: "ms",
      budget: PERF_BUDGETS.discoveryMs,
      verdict: phaseVerdict(discovery.ms, PERF_BUDGETS.discoveryMs),
      detail: discoveryDetail,
    },
    {
      name: "store-scan",
      measured: storeScan.ms,
      unit: "ms",
      budget: PERF_BUDGETS.storeScanMs,
      verdict: phaseVerdict(storeScan.ms, PERF_BUDGETS.storeScanMs),
      detail: storeScanDetail,
    },
    {
      name: "turn-log-scan",
      measured: turnLogScan.ms,
      unit: "ms",
      budget: PERF_BUDGETS.turnLogScanMs,
      verdict: phaseVerdict(turnLogScan.ms, PERF_BUDGETS.turnLogScanMs),
      detail: turnLogDetail,
    },
    {
      name: "memory",
      measured: mem.heapUsed,
      unit: "bytes",
      budget: PERF_BUDGETS.heapUsedBytes,
      verdict: phaseVerdict(mem.heapUsed, PERF_BUDGETS.heapUsedBytes),
      detail: `heap ${heapMb} MB, rss ${rssMb} MB`,
    },
  ];

  return {
    schema: PERF_REPORT_SCHEMA,
    v: PERF_REPORT_VERSION,
    workspace: redactHomePath(opts.workspace.root),
    phases,
    overall: overallVerdict(phases),
  };
}

// Deterministic text rendering (no ANSI): fixed phase order, one line per
// phase with the measured value, the named budget, and the verdict.
export function formatPerfReport(report: PerfReport): string[] {
  const lines: string[] = [];
  lines.push(`Performance report — workspace ${report.workspace}`);
  lines.push("─".repeat(40));
  lines.push("");
  for (const phase of report.phases) {
    const measured = phase.unit === "ms" ? `${phase.measured} ms` : `${Math.round(phase.measured / (1024 * 1024))} MB`;
    const budget = phase.unit === "ms" ? `${phase.budget} ms` : `${Math.round(phase.budget / (1024 * 1024))} MB`;
    const mark = phase.verdict === "ok" ? "[ ok ]" : "[EXCEEDS]";
    lines.push(`${mark} ${phase.name}  ${measured} / budget ${budget}`);
    lines.push(`       ${phase.detail}`);
  }
  lines.push("");
  lines.push(
    report.overall === "ok"
      ? "Overall: all phases within declared budgets."
      : "Overall: one or more phases exceed their declared budgets (named above).",
  );
  return lines;
}
