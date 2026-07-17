// Bounded, deterministic CI handoff.
//
// The CLI can understand a repository (src/repo-context.ts), plan a task
// (src/task-plan.ts), verify a task by running its canonical commands
// (src/task-verify.ts), and review the current change (src/change-review.ts),
// but each emits its own brief. At the CI boundary nobody stitches those
// verdicts together to answer "is this change safe to hand to CI, and what
// should CI run?" This module composes the verify (#66) and review (#68)
// slices into a single deterministic, redacted, head-bound handoff brief: the
// exact commit, the canonical commands CI should run with their LOCAL
// pass/fail status, the change summary and review signals, and any local
// blocker (introduced secrets, mutated protected governance paths, or failing
// local verification) that must be cleared before handoff. It mutates nothing;
// the only command execution is the repository's own canonical verify commands
// via verifyTask. Secrets are reported only as a count (never literals) and the
// absolute workspace path never appears in the output.

import * as path from "node:path";
import { reviewChange } from "./change-review.js";
import { verifyTask } from "./task-verify.js";
import type { VerifyVerdict } from "./task-verify.js";
import type { CanonicalCommand } from "./repo-context.js";

export const CI_HANDOFF_SCHEMA = "oh-my-cli.ci-handoff";
export const CI_HANDOFF_VERSION = 1;

// Bound the (already small) canonical command list so the brief stays compact
// even if the canonical set ever grows.
const MAX_COMMANDS_LISTED = 8;

export type CiHandoffVerdict = "no-change" | "ready-for-ci" | "local-blockers";

export interface CiHandoffCommand {
  /** Canonical command name (build, test, typecheck, lint). */
  name: CanonicalCommand;
  /** The resolved command, redacted and bounded for display. */
  command: string;
  /** Whether the command passed when run locally. */
  localPassed: boolean;
  /** True when the local run was killed for exceeding its timeout. */
  timedOut: boolean;
  /** Local process exit code, or null when killed/timed out/failed to spawn. */
  exitCode: number | null;
}

export interface CiHandoffReviewSignals {
  /** Count of added lines that contain a secret-like string (literals never stored). */
  secretsIntroduced: number;
  /** Redacted protected/governance paths touched by the change. */
  protectedPaths: string[];
  /** True when source files changed but no test files did. */
  sourceWithoutTests: boolean;
  /** True when the change exceeds a file-count, line-count, or per-file bound. */
  oversized: boolean;
  /** Runtime dependencies added relative to the base (redacted, bounded). */
  dependenciesAdded: string[];
}

export interface CiHandoffReport {
  schema: typeof CI_HANDOFF_SCHEMA;
  v: typeof CI_HANDOFF_VERSION;
  /** Repository head SHA the brief is bound to, or null when not a repo. */
  head: string | null;
  /** Base ref the change is measured against and its resolved SHA. */
  base: { ref: string; sha: string | null };
  /** Overall handoff verdict. */
  verdict: CiHandoffVerdict;
  /** Bounded change summary. */
  changeSummary: { filesChanged: number; linesAdded: number; linesRemoved: number };
  /** Canonical commands CI should run, with their LOCAL status (canonical order). */
  commands: CiHandoffCommand[];
  /** Review signals CI should gate on. */
  review: CiHandoffReviewSignals;
  /** Human-readable, redacted local blockers that must be cleared before handoff. */
  blockers: string[];
}

export interface CiHandoffOptions {
  /** Workspace to inspect (default cwd). */
  workspace?: string;
  /** Base ref to measure the change against (default origin/main, then HEAD). */
  base?: string;
  /** Per-command verify timeout in milliseconds (default from task-verify). */
  timeoutMs?: number;
}

/**
 * Assemble a deterministic, redacted CI-handoff report from collected facts.
 * Pure: identical facts always produce an identical report. The verdict is
 * `no-change` when nothing changed, `local-blockers` when an introduced secret,
 * a mutated protected path, or a failing local verify is present, otherwise
 * `ready-for-ci`.
 */
export function buildCiHandoffReport(facts: {
  head: string | null;
  base: { ref: string; sha: string | null };
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commands: CiHandoffCommand[];
  reviewSignals: CiHandoffReviewSignals;
  verifyVerdict: VerifyVerdict;
}): CiHandoffReport {
  const commands = facts.commands.slice(0, MAX_COMMANDS_LISTED);

  const blockers: string[] = [];
  if (facts.reviewSignals.secretsIntroduced > 0) {
    blockers.push(`introduced ${facts.reviewSignals.secretsIntroduced} secret-like added line(s)`);
  }
  if (facts.reviewSignals.protectedPaths.length > 0) {
    blockers.push(
      `protected governance path(s) mutated: ${facts.reviewSignals.protectedPaths.join(", ")}`,
    );
  }
  if (facts.verifyVerdict === "fail") {
    blockers.push("local verification failed");
  }

  let verdict: CiHandoffVerdict;
  if (facts.filesChanged === 0) verdict = "no-change";
  else if (blockers.length > 0) verdict = "local-blockers";
  else verdict = "ready-for-ci";

  return {
    schema: CI_HANDOFF_SCHEMA,
    v: CI_HANDOFF_VERSION,
    head: facts.head,
    base: facts.base,
    verdict,
    changeSummary: {
      filesChanged: facts.filesChanged,
      linesAdded: facts.linesAdded,
      linesRemoved: facts.linesRemoved,
    },
    commands,
    review: facts.reviewSignals,
    blockers: facts.filesChanged === 0 ? [] : blockers,
  };
}

/**
 * Compose the verify (#66) and review (#68) slices into a single bounded,
 * redacted, head-bound CI-handoff brief. Read-only with respect to the
 * repository: it inspects Git and package.json and runs only the repository's
 * own canonical verify commands; it never mutates the repository or governance
 * paths and never calls a provider.
 */
export function collectCiHandoff(opts: CiHandoffOptions = {}): CiHandoffReport {
  const workspace = path.resolve(opts.workspace ?? process.cwd());

  // Capture the change set first, before verifyTask runs any command that might
  // write build artifacts, so the review reflects the change as authored.
  const review = reviewChange({ workspace, base: opts.base });
  const verify = verifyTask({ workspace, timeoutMs: opts.timeoutMs });

  const commands: CiHandoffCommand[] = verify.results.map((r) => ({
    name: r.name,
    command: r.command,
    localPassed: r.passed,
    timedOut: r.timedOut,
    exitCode: r.exitCode,
  }));

  return buildCiHandoffReport({
    head: review.head ?? verify.head,
    base: review.base,
    filesChanged: review.filesChanged,
    linesAdded: review.linesAdded,
    linesRemoved: review.linesRemoved,
    commands,
    reviewSignals: {
      secretsIntroduced: review.signals.secretsIntroduced,
      protectedPaths: review.signals.protectedPaths,
      sourceWithoutTests: review.signals.sourceWithoutTests,
      oversized: review.signals.oversized,
      dependenciesAdded: review.signals.dependencies?.added ?? [],
    },
    verifyVerdict: verify.verdict,
  });
}

// --- formatting -------------------------------------------------------------

export function formatCiHandoffReport(report: CiHandoffReport): string {
  const lines: string[] = [];
  lines.push(`CI handoff (${report.schema} v${report.v})`);
  lines.push("─".repeat(46));
  lines.push(`Head   : ${report.head ?? "(not a git repository)"}`);
  lines.push(`Base   : ${report.base.ref} (${report.base.sha ?? "unknown"})`);
  lines.push(`Verdict: ${report.verdict}`);

  if (report.verdict === "no-change") {
    lines.push("No changes to hand off.");
    return lines.join("\n");
  }

  const c = report.changeSummary;
  lines.push(`Change : ${c.filesChanged} file(s), +${c.linesAdded} -${c.linesRemoved}`);

  if (report.commands.length === 0) {
    lines.push("Commands for CI: none detected");
  } else {
    lines.push("Commands for CI:");
    for (const cmd of report.commands) {
      const status = cmd.localPassed ? "PASS" : cmd.timedOut ? "TIMEOUT" : "FAIL";
      const exit = cmd.exitCode === null ? "n/a" : String(cmd.exitCode);
      lines.push(`  [${status}] ${cmd.name.padEnd(10)} ${cmd.command}  (exit ${exit})`);
    }
  }

  const r = report.review;
  lines.push("Review signals:");
  lines.push(`  Secrets introduced : ${r.secretsIntroduced} added line(s)`);
  lines.push(
    `  Protected paths    : ${r.protectedPaths.length > 0 ? r.protectedPaths.join(", ") : "none"}`,
  );
  lines.push(`  Source w/o tests   : ${r.sourceWithoutTests ? "yes" : "no"}`);
  lines.push(`  Oversized change   : ${r.oversized ? "yes" : "no"}`);
  lines.push(
    `  Runtime deps added : ${r.dependenciesAdded.length > 0 ? r.dependenciesAdded.join(", ") : "none"}`,
  );

  if (report.blockers.length > 0) {
    lines.push("Blockers:");
    for (const b of report.blockers) lines.push(`  - ${b}`);
  } else {
    lines.push("Blockers: none");
  }

  return lines.join("\n");
}
