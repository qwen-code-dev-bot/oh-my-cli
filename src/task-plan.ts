// Read-only, deterministic task planning.
//
// The CLI can execute bounded agent turns, but it has no observable plan for a
// repository task, so execution is opaque and later verification/review slices
// have nothing objective to check against. This module derives a bounded,
// ordered, redacted plan for one task from the repository-context snapshot
// (src/repo-context.ts) — it never executes anything, never calls a provider,
// and never mutates the repository or filesystem. The plan is a fixed,
// dependency-ordered phase sequence (understand → implement → verify → review)
// whose verify step is grounded in the canonical commands the snapshot actually
// detected. The result is deterministic for fixed inputs (same task + same
// repository state → same plan), with secrets redacted and every collection
// bounded.

import { collectRepoContext } from "./repo-context.js";
import type { RepoContextSnapshot, CanonicalCommand } from "./repo-context.js";
import { redactSecrets } from "./permission-impact.js";

export const PLAN_SCHEMA = "oh-my-cli.plan";
export const PLAN_VERSION = 1;

// Bounds that keep the plan compact and free of oversized untrusted input.
const MAX_OBJECTIVE = 500;
const MAX_STEPS = 16;
const MAX_COMMANDS = 8;
const MAX_COMMAND_LEN = 120;

const CANONICAL_ORDER: CanonicalCommand[] = ["build", "test", "typecheck", "lint"];

export type PlanPhase = "understand" | "implement" | "verify" | "review";

export interface PlanStep {
  /** Stable 1-based position in the ordered plan. */
  id: number;
  phase: PlanPhase;
  /** A redacted, bounded description of the step. */
  intent: string;
  /** Concrete commands for the verify step (reported, never executed). */
  commands?: string[];
}

export interface TaskPlan {
  schema: typeof PLAN_SCHEMA;
  v: typeof PLAN_VERSION;
  /** The redacted, bounded task description. */
  objective: string;
  /** Detected package managers / ecosystems (from the repository context). */
  toolchain: string[];
  /** Bounded, dependency-ordered steps. */
  steps: PlanStep[];
  /** The canonical verification commands the plan will run (bounded). */
  verifyCommands: string[];
}

export interface TaskPlanOptions {
  /** The task to plan for (untrusted input; redacted and bounded). */
  task: string;
  /** Workspace to inspect (default cwd). */
  workspace?: string;
}

function redactObjective(task: string): string {
  return redactSecrets(task ?? "").text.trim().slice(0, MAX_OBJECTIVE);
}

// Derive the ordered verify commands from a repository-context snapshot, in
// canonical order (build, test, typecheck, lint). Each command is redacted and
// bounded; the list itself is bounded.
export function deriveVerifyCommands(snapshot: RepoContextSnapshot): string[] {
  const commands: string[] = [];
  for (const key of CANONICAL_ORDER) {
    const ref = snapshot.commands[key];
    if (ref) commands.push(redactSecrets(ref.command).text.slice(0, MAX_COMMAND_LEN));
    if (commands.length >= MAX_COMMANDS) break;
  }
  return commands;
}

// Build the bounded, deterministic phase sequence grounded in the snapshot.
export function buildPlanSteps(
  snapshot: RepoContextSnapshot,
  verifyCommands: string[],
): PlanStep[] {
  const toolchain = snapshot.toolchains.map((t) => t.manager);
  const toolchainText = toolchain.length > 0 ? toolchain.join(", ") : "an unknown toolchain";

  const steps: PlanStep[] = [
    {
      id: 1,
      phase: "understand",
      intent: `Read the relevant files and the repository context (toolchain: ${toolchainText}) before editing.`,
    },
    {
      id: 2,
      phase: "implement",
      intent: "Make the minimal change described by the objective, confined to the workspace.",
    },
    verifyCommands.length > 0
      ? {
          id: 3,
          phase: "verify",
          intent: "Run the detected verification commands and confirm they pass before finishing.",
          commands: verifyCommands,
        }
      : {
          id: 3,
          phase: "verify",
          intent: "No canonical verification command detected; verify the change manually.",
        },
    {
      id: 4,
      phase: "review",
      intent: "Summarize the change and produce completion evidence (diff and test results).",
    },
  ];

  return steps.slice(0, MAX_STEPS);
}

/**
 * Produce a deterministic, bounded, redacted plan for one task. Read-only and
 * offline: it inspects the workspace via the repository-context snapshot but
 * never executes the commands it lists, never calls a provider, and never
 * mutates anything.
 */
export function planTask(opts: TaskPlanOptions): TaskPlan {
  const objective = redactObjective(opts.task);
  const snapshot = collectRepoContext({ workspace: opts.workspace });
  const verifyCommands = deriveVerifyCommands(snapshot);
  const steps = buildPlanSteps(snapshot, verifyCommands);
  return {
    schema: PLAN_SCHEMA,
    v: PLAN_VERSION,
    objective,
    toolchain: snapshot.toolchains.map((t) => t.manager),
    steps,
    verifyCommands,
  };
}

// --- formatting -------------------------------------------------------------

export function formatTaskPlan(plan: TaskPlan): string {
  const lines: string[] = [];
  lines.push(`Task plan (${plan.schema} v${plan.v})`);
  lines.push("─".repeat(46));
  lines.push(`Objective : ${plan.objective || "(none provided)"}`);
  lines.push(`Toolchain : ${plan.toolchain.length > 0 ? plan.toolchain.join(", ") : "unknown"}`);
  lines.push("Steps     :");
  for (const step of plan.steps) {
    lines.push(`  ${step.id}. ${step.phase.padEnd(10)} ${step.intent}`);
    if (step.commands && step.commands.length > 0) {
      for (const c of step.commands) lines.push(`       - ${c}`);
    }
  }
  return lines.join("\n");
}
