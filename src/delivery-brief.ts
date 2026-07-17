// Bounded, deterministic delivery / completion verdict.
//
// The CLI can plan a task (src/task-plan.ts), verify canonical commands
// (src/task-verify.ts), review the current change (src/change-review.ts), and
// produce a pre-CI handoff brief (src/ci-handoff.ts), but each emits its own
// artifact and the handoff brief is produced *before* CI runs. After CI
// completes nobody stitches those verdicts together with the CI result to
// answer the final question: "is this change ready to ship?" This module
// composes the plan (#64), verify (#66), review (#68), and CI-handoff (#70)
// slices with a bounded, validated CI result into a single deterministic,
// redacted, head-bound completion verdict (ship / hold / no-ship). It mutates
// nothing; the only command execution is the repository's own canonical verify
// commands via the handoff slice. Secrets are reported only as a count (never
// literals) and the absolute workspace path never appears in the output.

import * as path from "node:path";
import { collectCiHandoff } from "./ci-handoff.js";
import type { CiHandoffCommand, CiHandoffReport } from "./ci-handoff.js";
import { planTask } from "./task-plan.js";

export const DELIVERY_BRIEF_SCHEMA = "oh-my-cli.delivery-brief";
export const DELIVERY_BRIEF_VERSION = 1;

export type CiResult = "pass" | "fail" | "pending";
export type DeliveryVerdict = "ship" | "hold" | "no-ship";
export type SignalName = "plan" | "verify" | "review" | "handoff" | "ci";

const CI_RESULTS: readonly CiResult[] = ["pass", "fail", "pending"];

/** Parse and validate the bounded CI-result input (default `pending`). */
export function parseCiResult(value: string | undefined): CiResult {
  const v = (value ?? "pending").toLowerCase();
  if (v === "pass" || v === "fail" || v === "pending") return v;
  throw new Error(
    `invalid CI result "${value}"; expected one of ${CI_RESULTS.join(", ")}`,
  );
}

export interface DeliverySignal {
  /** Stable signal name. */
  name: SignalName;
  /** Per-signal status, redacted and bounded. */
  status: string;
  /** True when this signal blocks shipping (contributes to no-ship). */
  blocking: boolean;
  /** True when this signal holds shipping but is not a hard failure. */
  holding: boolean;
  /** Human-readable, redacted detail. */
  detail: string;
}

export interface DeliveryBriefReport {
  schema: typeof DELIVERY_BRIEF_SCHEMA;
  v: typeof DELIVERY_BRIEF_VERSION;
  /** Repository head SHA the verdict is bound to, or null when not a repo. */
  head: string | null;
  /** Base ref the change is measured against and its resolved SHA. */
  base: { ref: string; sha: string | null };
  /** Overall completion verdict. */
  verdict: DeliveryVerdict;
  /** Bounded change summary. */
  changeSummary: { filesChanged: number; linesAdded: number; linesRemoved: number };
  /** Per-slice contributing signals (canonical order). */
  signals: DeliverySignal[];
  /** Redacted, bounded reasons the change cannot ship (hard blockers). */
  blockers: string[];
  /** Redacted, bounded reasons the change is not yet clear to ship. */
  holds: string[];
}

export interface DeliveryBriefOptions {
  /** Workspace to inspect (default cwd). */
  workspace?: string;
  /** Base ref to measure the change against (default origin/main, then HEAD). */
  base?: string;
  /** Bounded, validated CI outcome (default pending). */
  ciResult?: CiResult;
  /** Per-command verify timeout in milliseconds (passed to the handoff slice). */
  timeoutMs?: number;
}

/**
 * Assemble a deterministic, redacted delivery verdict from collected facts.
 * Pure: identical facts always produce an identical report. The verdict is
 * `no-ship` when any hard blocker is present (introduced secret, mutated
 * protected path, failing local verify, or failed CI); otherwise `hold` when a
 * soft signal is unresolved (no change to deliver, CI still pending, or no
 * grounded verification command in the plan); otherwise `ship`.
 */
export function buildDeliveryBrief(facts: {
  head: string | null;
  base: { ref: string; sha: string | null };
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commands: CiHandoffCommand[];
  secretsIntroduced: number;
  protectedPaths: string[];
  planGrounded: boolean;
  ciResult: CiResult;
}): DeliveryBriefReport {
  const anyCommandFailed = facts.commands.some((c) => !c.localPassed);
  const hasCommands = facts.commands.length > 0;
  const reviewBlocked = facts.secretsIntroduced > 0 || facts.protectedPaths.length > 0;
  const planHeld = facts.filesChanged > 0 && !facts.planGrounded;

  const blockers: string[] = [];
  if (facts.secretsIntroduced > 0) {
    blockers.push(`introduced ${facts.secretsIntroduced} secret-like added line(s)`);
  }
  if (facts.protectedPaths.length > 0) {
    blockers.push(`protected governance path(s) mutated: ${facts.protectedPaths.join(", ")}`);
  }
  if (anyCommandFailed) blockers.push("local verification failed");
  if (facts.ciResult === "fail") blockers.push("CI failed");

  const holds: string[] = [];
  if (facts.filesChanged === 0) holds.push("no change to deliver");
  if (facts.ciResult === "pending") holds.push("CI pending");
  if (planHeld) holds.push("no grounded verification command in plan");

  const verdict: DeliveryVerdict =
    blockers.length > 0 ? "no-ship" : holds.length > 0 ? "hold" : "ship";

  const signals: DeliverySignal[] = [
    {
      name: "plan",
      status: facts.planGrounded ? "grounded" : "no-verify-commands",
      blocking: false,
      holding: planHeld,
      detail: facts.planGrounded
        ? "plan includes grounded verification commands"
        : "plan has no grounded verification command",
    },
    {
      name: "verify",
      status: anyCommandFailed ? "fail" : hasCommands ? "pass" : "no-commands",
      blocking: anyCommandFailed,
      holding: false,
      detail: anyCommandFailed
        ? "one or more local verify commands failed"
        : hasCommands
          ? "all local verify commands passed"
          : "no local verify commands detected",
    },
    {
      name: "review",
      status: reviewBlocked ? "blocker" : "clean",
      blocking: reviewBlocked,
      holding: false,
      detail: reviewBlocked
        ? `secrets introduced: ${facts.secretsIntroduced}; protected paths: ${facts.protectedPaths.length}`
        : "no introduced secrets or mutated protected paths",
    },
    {
      name: "handoff",
      status: facts.filesChanged === 0 ? "no-change" : anyCommandFailed || reviewBlocked ? "local-blockers" : "ready-for-ci",
      blocking: anyCommandFailed || reviewBlocked,
      holding: facts.filesChanged === 0,
      detail:
        facts.filesChanged === 0
          ? "no change to hand off"
          : anyCommandFailed || reviewBlocked
            ? "local blockers must be cleared before handoff"
            : "ready for CI",
    },
    {
      name: "ci",
      status: facts.ciResult,
      blocking: facts.ciResult === "fail",
      holding: facts.ciResult === "pending",
      detail:
        facts.ciResult === "pass"
          ? "CI passed"
          : facts.ciResult === "fail"
            ? "CI failed"
            : "CI result not yet available",
    },
  ];

  return {
    schema: DELIVERY_BRIEF_SCHEMA,
    v: DELIVERY_BRIEF_VERSION,
    head: facts.head,
    base: facts.base,
    verdict,
    changeSummary: {
      filesChanged: facts.filesChanged,
      linesAdded: facts.linesAdded,
      linesRemoved: facts.linesRemoved,
    },
    signals,
    blockers,
    holds,
  };
}

/**
 * Compose the plan (#64), verify (#66), review (#68), and CI-handoff (#70)
 * slices with a bounded CI result into a single head-bound completion verdict.
 * Read-only with respect to the repository: it inspects Git and package.json
 * and runs only the repository's own canonical verify commands (via the handoff
 * slice); it never mutates the repository or governance paths and never calls a
 * provider.
 */
export function collectDeliveryBrief(opts: DeliveryBriefOptions = {}): DeliveryBriefReport {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const ciResult = opts.ciResult ?? "pending";

  const handoff: CiHandoffReport = collectCiHandoff({
    workspace,
    base: opts.base,
    timeoutMs: opts.timeoutMs,
  });
  const plan = planTask({ task: "", workspace });

  return buildDeliveryBrief({
    head: handoff.head,
    base: handoff.base,
    filesChanged: handoff.changeSummary.filesChanged,
    linesAdded: handoff.changeSummary.linesAdded,
    linesRemoved: handoff.changeSummary.linesRemoved,
    commands: handoff.commands,
    secretsIntroduced: handoff.review.secretsIntroduced,
    protectedPaths: handoff.review.protectedPaths,
    planGrounded: plan.verifyCommands.length > 0,
    ciResult,
  });
}

// --- formatting -------------------------------------------------------------

export function formatDeliveryBrief(report: DeliveryBriefReport): string {
  const lines: string[] = [];
  lines.push(`Delivery brief (${report.schema} v${report.v})`);
  lines.push("─".repeat(46));
  lines.push(`Head   : ${report.head ?? "(not a git repository)"}`);
  lines.push(`Base   : ${report.base.ref} (${report.base.sha ?? "unknown"})`);
  lines.push(`Verdict: ${report.verdict}`);

  const c = report.changeSummary;
  lines.push(`Change : ${c.filesChanged} file(s), +${c.linesAdded} -${c.linesRemoved}`);

  lines.push("Signals:");
  for (const s of report.signals) {
    const flag = s.blocking ? " [blocker]" : s.holding ? " [hold]" : "";
    lines.push(`  ${s.name.padEnd(8)} ${s.status}${flag}`);
  }

  if (report.blockers.length > 0) {
    lines.push("Blockers:");
    for (const b of report.blockers) lines.push(`  - ${b}`);
  } else {
    lines.push("Blockers: none");
  }

  if (report.holds.length > 0) {
    lines.push("Holds:");
    for (const h of report.holds) lines.push(`  - ${h}`);
  } else {
    lines.push("Holds: none");
  }

  return lines.join("\n");
}
