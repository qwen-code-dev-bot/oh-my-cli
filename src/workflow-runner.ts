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
import type { ColorDepth } from "./product-banner.js";
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

export interface WorkflowRunStart {
  workflow: string;
  stepsTotal: number;
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
  /** Invoked with the redacted plan before the first executor call. */
  onWorkflowStart?: (start: WorkflowRunStart) => void;
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
  const displayPrompts = definition.steps.map((step) =>
    redactPromptForDisplay(step.prompt, opts.workspace),
  );
  opts.onWorkflowStart?.({
    workflow: definition.name,
    stepsTotal: total,
  });

  const startedAt = Date.now();
  const steps: WorkflowStepResult[] = [];
  let result: "completed" | "failed" = "completed";

  for (let i = 0; i < total; i++) {
    const pending: WorkflowStepResult = {
      index: i,
      prompt: displayPrompts[i],
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
      prompt: displayPrompts[i],
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

export interface WorkflowConsoleStyle {
  bold: string;
  dim: string;
  accent: string;
  accentWarm: string;
  success: string;
  error: string;
  reset: string;
}

export interface WorkflowFormatOptions {
  style?: WorkflowConsoleStyle;
  width?: number;
}

const PLAIN_WORKFLOW_STYLE: WorkflowConsoleStyle = {
  bold: "",
  dim: "",
  accent: "",
  accentWarm: "",
  success: "",
  error: "",
  reset: "",
};

export function workflowConsoleStyle(depth: ColorDepth): WorkflowConsoleStyle {
  if (depth === "none") return { ...PLAIN_WORKFLOW_STYLE };
  if (depth === "basic") {
    return {
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      accent: "\x1b[34m",
      accentWarm: "\x1b[35m",
      success: "\x1b[32m",
      error: "\x1b[31m",
      reset: "\x1b[0m",
    };
  }
  return {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    accent: "\x1b[38;5;27m",
    accentWarm: "\x1b[38;5;176m",
    success: "\x1b[38;5;114m",
    error: "\x1b[38;5;203m",
    reset: "\x1b[0m",
  };
}

function workflowFormatOptions(opts: WorkflowFormatOptions): {
  style: WorkflowConsoleStyle;
  width: number;
} {
  return {
    style: opts.style ?? PLAIN_WORKFLOW_STYLE,
    width: Math.max(1, Math.floor(opts.width ?? 80)),
  };
}

function clipWorkflowText(text: string, width: number): string {
  const cells = Array.from(text);
  if (cells.length <= width) return text;
  if (width <= 1) return "…".slice(0, width);
  return cells.slice(0, width - 1).join("") + "…";
}

function workflowStateLine(input: {
  glyph: string;
  label: string;
  position?: string;
  detail: string;
  tone: string;
  style: WorkflowConsoleStyle;
  width: number;
}): string {
  const position = input.position ? `${input.position}  ` : "";
  const prefix = `${input.glyph} ${input.label.padEnd(8)} ${position}`;
  const plain = clipWorkflowText(prefix + input.detail, input.width);
  const detailStart = Math.min(prefix.length, Array.from(plain).length);
  const visiblePrefix = Array.from(plain).slice(0, detailStart).join("");
  const visibleDetail = Array.from(plain).slice(detailStart).join("");
  return `${input.tone}${visiblePrefix}${input.style.reset}${visibleDetail}`;
}

export function formatWorkflowStart(
  start: WorkflowRunStart,
  opts: WorkflowFormatOptions = {},
): string {
  const { style, width } = workflowFormatOptions(opts);
  const lines = [
    clipWorkflowText("╭─ DYNAMIC WORKFLOW", width),
    clipWorkflowText(
      `│  ${start.workflow}  ·  ${start.stepsTotal} step${start.stepsTotal === 1 ? "" : "s"}  ·  SEQUENTIAL`,
      width,
    ),
    clipWorkflowText("╰─ execution started", width),
  ];
  return [
    `${style.accentWarm}${lines[0]}${style.reset}`,
    `${style.bold}${lines[1]}${style.reset}`,
    `${style.dim}${lines[2]}${style.reset}`,
  ].join("\n");
}

export function formatWorkflowStepStart(
  step: WorkflowStepResult,
  stepsTotal: number,
  opts: WorkflowFormatOptions = {},
): string {
  const { style, width } = workflowFormatOptions(opts);
  const position = `${step.index + 1}/${stepsTotal}`;
  const lines = [
    workflowStateLine({
      glyph: "◆",
      label: "RUNNING",
      position,
      detail: step.prompt,
      tone: style.accentWarm,
      style,
      width,
    }),
  ];
  const remaining = Math.max(0, stepsTotal - step.index - 1);
  if (remaining > 0) {
    lines.push(
      workflowStateLine({
        glyph: "○",
        label: "QUEUED",
        detail: `${remaining} step${remaining === 1 ? "" : "s"} remaining`,
        tone: style.dim,
        style,
        width,
      }),
    );
  }
  return lines.join("\n");
}

// A redacted completion line for one step. The same formatter is used by the
// streaming and full-report paths so terminal state never diverges.
export function formatWorkflowStepLine(
  step: WorkflowStepResult,
  stepsTotal: number,
  opts: WorkflowFormatOptions = {},
): string {
  const { style, width } = workflowFormatOptions(opts);
  const line = workflowStateLine({
    glyph: step.ok ? "●" : "✕",
    label: step.ok ? "DONE" : "FAILED",
    position: `${step.index + 1}/${stepsTotal}`,
    detail: `${step.prompt}  ·  ${step.elapsedMs}ms`,
    tone: step.ok ? style.success : style.error,
    style,
    width,
  });
  if (step.ok || !step.reason) return line;
  const reason = clipWorkflowText(`│   reason  ${step.reason}`, width);
  return `${line}\n${style.error}${reason}${style.reset}`;
}

export function formatWorkflowOutcome(
  report: WorkflowRunReport,
  opts: WorkflowFormatOptions = {},
): string {
  const { style, width } = workflowFormatOptions(opts);
  const lines: string[] = [];
  const skipped = report.stepsTotal - report.stepsRun;
  if (skipped > 0) {
    lines.push(
      workflowStateLine({
        glyph: "○",
        label: "SKIPPED",
        detail: `${skipped} step${skipped === 1 ? "" : "s"}  ·  halted after ${report.stepsRun}/${report.stepsTotal}`,
        tone: style.dim,
        style,
        width,
      }),
    );
  }
  lines.push(`${style.accent}${clipWorkflowText("╭─ OUTCOME", width)}${style.reset}`);
  const completed = report.result === "completed";
  const outcome = completed
    ? `│  ✓ COMPLETED  ${report.stepsRun}/${report.stepsTotal} steps  ·  ${report.elapsedMs}ms`
    : `│  ✕ FAILED     ${report.stepsRun}/${report.stepsTotal} steps  ·  ${report.elapsedMs}ms`;
  lines.push(
    `${completed ? style.success : style.error}${clipWorkflowText(outcome, width)}${style.reset}`,
  );
  lines.push(
    `${style.dim}${clipWorkflowText(`╰─ ${report.workflow}`, width)}${style.reset}`,
  );
  return lines.join("\n");
}

// A redacted, human-readable summary of a workflow run.
export function formatWorkflowRun(
  report: WorkflowRunReport,
  opts: WorkflowFormatOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`Workflow:  ${report.workflow}`);
  lines.push(
    `Contract:  ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
  );
  lines.push(`Settings:  ${report.settings}`);
  lines.push(`Workspace: ${report.workspace}`);
  for (const step of report.steps) {
    lines.push(formatWorkflowStepLine(step, report.stepsTotal, opts));
  }
  if (report.stepsRun < report.stepsTotal) {
    lines.push(`  Steps ${report.stepsRun + 1}-${report.stepsTotal}: skipped (halted)`);
  }
  lines.push(
    `Result:    ${report.result} (${report.stepsRun}/${report.stepsTotal} steps, ${report.elapsedMs}ms)`,
  );
  return lines.join("\n");
}
