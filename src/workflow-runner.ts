// Workflow runner: execute a resolved workflow's steps sequentially and
// non-interactively, reusing the existing headless `-p` execution path for each
// step (no core provider/tool/MCP changes per consumer). Each step runs in its
// own short-lived CLI process against the same workspace and environment, so a
// step is naturally bounded and isolated — there is no cross-workflow state and
// no artifact persistence beyond the run.
//
// Safe failure defaults: steps run in declared order and the first failing step
// halts the workflow; the remaining steps do not run. Every reported field is
// redacted (secrets, credentials, and workspace/home paths) and timing is
// bounded, so the run summary is safe to emit in both human and machine modes.

import { spawn } from "node:child_process";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { parseHeadlessStream, terminalRecord } from "./headless-protocol.js";
import {
  resolveWorkflow,
  WORKFLOW_CONTRACT_SCHEMA,
  WORKFLOW_CONTRACT_VERSION,
} from "./workflow-contract.js";

// Bounded display length for a redacted step prompt in the run report.
const MAX_PROMPT_DISPLAY = 120;

export interface WorkflowStepResult {
  /** Zero-based step position in the declared order. */
  index: number;
  /** Redacted, bounded one-line rendering of the step prompt. */
  prompt: string;
  ok: boolean;
  exitCode: number | null;
  /** Wall-clock time spent in the step, in milliseconds. */
  elapsedMs: number;
  /** Redacted failure reason, present only when the step failed. */
  reason?: string;
}

export interface WorkflowRunReport {
  schema: string;
  version: number;
  contractVersion: number;
  workflow: string;
  /** completed: every step ran and passed; failed: a step halted the run. */
  result: "completed" | "failed";
  stepsTotal: number;
  stepsRun: number;
  steps: WorkflowStepResult[];
  /** Wall-clock time for the whole run, in milliseconds. */
  elapsedMs: number;
  settings: string;
  workspace: string;
}

export interface StepExecutionContext {
  /** The raw (unredacted) step prompt to execute. */
  prompt: string;
  workspace: string;
  env: Record<string, string | undefined>;
}

export interface StepExecutionResult {
  ok: boolean;
  exitCode: number | null;
  reason?: string;
}

// A step executor runs one step and reports its outcome. Injectable so tests can
// drive the runner deterministically without spawning real CLI processes.
export type StepExecutor = (ctx: StepExecutionContext) => Promise<StepExecutionResult>;

// The running CLI module, reused as the step binary so a step runs the exact same
// headless `-p` path (process.argv[1] is the executed dist/index.js).
function cliEntry(): string {
  return process.argv[1] ?? "";
}

// Default executor: spawn `node <cli> -p <prompt> --output json --workspace <ws>`
// and derive the outcome from the headless terminal record (falling back to the
// process exit code). The step's own stream is captured, never forwarded, and any
// reason is redacted before it is reported.
export const spawnStepExecutor: StepExecutor = (ctx) =>
  new Promise<StepExecutionResult>((resolve) => {
    const args = [
      cliEntry(),
      "-p",
      ctx.prompt,
      "--output",
      "json",
      "--workspace",
      ctx.workspace,
    ];
    const proc = spawn(process.execPath, args, { env: ctx.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (err: Error) => {
      resolve({
        ok: false,
        exitCode: null,
        reason: redactSecrets(err?.message ?? String(err)).text,
      });
    });
    proc.on("close", (code) => {
      let ok = code === 0;
      let reason: string | undefined;
      try {
        const records = parseHeadlessStream(stdout);
        const terminal = terminalRecord(records);
        if (terminal) {
          ok = terminal.ok;
          reason = terminal.ok ? undefined : terminal.reason;
        }
        if (!ok && !reason) {
          const errorRecord = records.find((r) => r.type === "error");
          if (errorRecord && errorRecord.type === "error") {
            reason = errorRecord.message;
          }
        }
      } catch {
        // Non-protocol output: fall back to exit-code semantics below.
      }
      if (!ok && !reason) {
        const firstLine = stderr.trim().split("\n")[0];
        reason = firstLine ? redactSecrets(firstLine).text : `step exited with code ${code}`;
      }
      resolve({ ok, exitCode: code, reason: reason ? redactSecrets(reason).text : undefined });
    });
  });

// Replace every occurrence of the host home directory with `~`. Unlike
// redactHomePath (which only collapses a leading prefix), a step prompt embeds
// paths mid-string, so any occurrence must be redacted.
function redactHomeOccurrences(text: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && home.length > 1 && text.includes(home)) {
    return text.split(home).join("~");
  }
  return text;
}

// Redact and bound a step prompt for display: strip secrets, collapse the home
// path (anywhere it appears) and the workspace path, flatten whitespace, and
// truncate with an ellipsis marker.
export function redactPromptForDisplay(prompt: string, workspace?: string): string {
  let text = redactHomeOccurrences(redactSecrets(prompt).text);
  if (workspace && workspace.length > 1) {
    text = text.split(workspace).join("<workspace>");
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_PROMPT_DISPLAY) return oneLine;
  return oneLine.slice(0, MAX_PROMPT_DISPLAY - 1) + "…";
}

export interface RunWorkflowOptions {
  name: string;
  settingsPath?: string;
  workspace: string;
  env?: Record<string, string | undefined>;
  /** Override the step executor (tests). Defaults to spawning the CLI -p path. */
  executor?: StepExecutor;
  /** Invoked with the redacted step view before a step runs (streaming). */
  onStepStart?: (step: WorkflowStepResult, stepsTotal: number) => void;
  /** Invoked with the redacted step result after a step completes (streaming). */
  onStepEnd?: (step: WorkflowStepResult, stepsTotal: number) => void;
}

// Resolve and run a named workflow. Resolution failures (unknown name, invalid
// contract) throw before any step runs. Steps run sequentially in declared order;
// the first failing step halts the run and the remaining steps do not run.
export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRunReport> {
  const env = opts.env ?? process.env;
  const executor = opts.executor ?? spawnStepExecutor;
  const resolved = resolveWorkflow(opts.name, { settingsPath: opts.settingsPath });
  const definition = resolved.definition;
  const total = definition.steps.length;

  const startedAt = Date.now();
  const steps: WorkflowStepResult[] = [];
  let result: "completed" | "failed" = "completed";

  for (let i = 0; i < total; i++) {
    const displayPrompt = redactPromptForDisplay(definition.steps[i].prompt, opts.workspace);
    const pending: WorkflowStepResult = {
      index: i,
      prompt: displayPrompt,
      ok: false,
      exitCode: null,
      elapsedMs: 0,
    };
    opts.onStepStart?.({ ...pending }, total);

    const stepStart = Date.now();
    const exec = await executor({
      prompt: definition.steps[i].prompt,
      workspace: opts.workspace,
      env,
    });
    const stepResult: WorkflowStepResult = {
      index: i,
      prompt: displayPrompt,
      ok: exec.ok,
      exitCode: exec.exitCode,
      elapsedMs: Date.now() - stepStart,
      reason: exec.reason,
    };
    steps.push(stepResult);
    opts.onStepEnd?.({ ...stepResult }, total);

    if (!exec.ok) {
      result = "failed";
      break; // Safe failure default: halt; remaining steps do not run.
    }
  }

  return {
    schema: WORKFLOW_CONTRACT_SCHEMA,
    version: WORKFLOW_CONTRACT_VERSION,
    contractVersion: resolved.contractVersion,
    workflow: definition.name,
    result,
    stepsTotal: total,
    stepsRun: steps.length,
    steps,
    elapsedMs: Date.now() - startedAt,
    settings: resolved.settingsFound
      ? redactHomePath(resolved.settingsPath)
      : `${redactHomePath(resolved.settingsPath)} (not found)`,
    workspace: redactHomePath(opts.workspace),
  };
}

// A single redacted line for one step, shared by the streaming and full-report
// paths so the human rendering never diverges.
export function formatWorkflowStepLine(step: WorkflowStepResult, stepsTotal: number): string {
  const status = step.ok ? "ok" : "FAILED";
  return `  Step ${step.index + 1}/${stepsTotal}: ${step.prompt} — ${status} (${step.elapsedMs}ms)`;
}

// A redacted, human-readable summary of a workflow run.
export function formatWorkflowRun(report: WorkflowRunReport): string {
  const lines: string[] = [];
  lines.push(`Workflow:  ${report.workflow}`);
  lines.push(
    `Contract:  ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
  );
  lines.push(`Settings:  ${report.settings}`);
  lines.push(`Workspace: ${report.workspace}`);
  for (const step of report.steps) {
    lines.push(formatWorkflowStepLine(step, report.stepsTotal));
    if (!step.ok && step.reason) {
      lines.push(`    reason: ${step.reason}`);
    }
  }
  if (report.stepsRun < report.stepsTotal) {
    lines.push(`  Steps ${report.stepsRun + 1}-${report.stepsTotal}: skipped (halted)`);
  }
  lines.push(
    `Result:    ${report.result} (${report.stepsRun}/${report.stepsTotal} steps, ${report.elapsedMs}ms)`,
  );
  return lines.join("\n");
}
