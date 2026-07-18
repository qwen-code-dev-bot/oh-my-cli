// Tool extension invocation: governed, non-interactive execution of exactly one
// resolved-`ready` versioned tool extension through its contract (#135), gated by
// the command trust policy (#51) and the existing approval mode, confined to the
// workspace, and bounded by a hard timeout and an output-size cap. The result is
// redacted (secrets and home/workspace paths) and emitted as text or JSON. This
// is the "invoke" step of the tool extension lifecycle that the read-only tool
// contract (tool-contract.ts) deliberately deferred; it reuses #135's version
// negotiation, deterministic selection, and readiness resolution and #51's
// policy decision rather than re-implementing them.
//
// Trust boundary: tool definitions and their output are untrusted input. The
// selected tool must resolve to `ready` (a disabled, misconfigured, or missing
// command is never invoked). The declared command and its arguments are evaluated
// against the command policy with untrusted (`repository`) provenance, so
// dangerous shapes (destructive git, credential access, path escape, destructive
// removal, device overwrite) are denied before execution. The command is run
// directly (no shell) so its arguments cannot be reinterpreted by a shell; it is
// confined to the workspace (cwd) and bounded in time and output. Any failure —
// unresolved readiness, policy denial, missing approval, timeout, oversized
// output, non-zero exit, or a spawn error — fails closed with a safe redacted
// result and never crashes the run.

import path from "node:path";
import { spawn } from "node:child_process";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { evaluateCommandPolicy, policyDenialMessage } from "./command-policy.js";
import type { ApprovalMode } from "./approval.js";
import { needsApproval, promptApproval } from "./approval.js";
import { resolveSelectedTool, type ResolvedTool } from "./tool-contract.js";

export const TOOL_INVOCATION_SCHEMA = "oh-my-cli.tool-invocation";
export const TOOL_INVOCATION_VERSION = 1;

// Bounded execution window (milliseconds) for one invocation. A tool that runs
// longer than its timeout is killed and resolves to a safe failure result, so a
// hung tool can never block the run. Mirrors the probe-timeout bounds of the
// read-only contract but allows a longer ceiling for real work.
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
export const MIN_INVOKE_TIMEOUT_MS = 50;
export const MAX_INVOKE_TIMEOUT_MS = 300_000;

// Bounded captured output (bytes, across stdout + stderr). Once exceeded, the
// process is killed and the result is marked oversized, so an unbounded producer
// cannot exhaust memory or flood the report.
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

// The command policy treats a declared tool command as untrusted input: the same
// denial rules that govern a repository-derived command apply, so a tool can
// never widen the trust boundary by being declared in settings.
const TOOL_COMMAND_PROVENANCE = "repository" as const;

// A tool runs an arbitrary local command, so it is gated as the most cautious
// built-in category (a shell mutation). Under `default`/`auto-edit` it therefore
// requires approval; only `yolo` auto-approves it.
const TOOL_APPROVAL_CATEGORY = "mutate-shell" as const;

export function clampInvokeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INVOKE_TIMEOUT_MS;
  return Math.min(MAX_INVOKE_TIMEOUT_MS, Math.max(MIN_INVOKE_TIMEOUT_MS, Math.floor(value)));
}

// The gate that decided whether the tool was invoked:
//   passed        — resolved-`ready`, policy-allowed, and approved; executed.
//   not-ready     — readiness was `declared` or `isolated`; never executed.
//   policy-denied — the command policy (#51) denied the command; never executed.
//   unapproved    — approval was required and not granted; never executed.
export type InvocationGate = "passed" | "not-ready" | "policy-denied" | "unapproved";

export interface CommandRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
}

// The raw, unredacted outcome of running the command. Redaction happens when the
// report is built, never here.
export interface CommandRunResult {
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  /** Present when the process could not be spawned (e.g. command not found). */
  spawnError?: string;
}

// Runs the declared command and reports its raw outcome. Injectable so tests can
// drive the gate logic deterministically without spawning real processes.
export type CommandRunner = (opts: CommandRunOptions) => Promise<CommandRunResult>;

// Default runner: spawn the command directly (no shell, so arguments cannot be
// reinterpreted), confined to `cwd`, bounded by a hard timeout and an output-size
// cap. On timeout or cap the process is killed; the outcome is reported, never
// thrown.
export const spawnCommandRunner: CommandRunner = (opts) =>
  new Promise<CommandRunResult>((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let total = 0;
    let timedOut = false;
    let outputCapped = false;
    let settled = false;

    const proc = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env });

    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process already exited; nothing to kill.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (outputCapped || timedOut) return;
      const text = chunk.toString("utf8");
      if (total + text.length > opts.maxOutputBytes) {
        const remaining = Math.max(0, opts.maxOutputBytes - total);
        if (stream === "stdout") stdout += text.slice(0, remaining);
        else stderr += text.slice(0, remaining);
        total = opts.maxOutputBytes;
        outputCapped = true;
        kill();
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
      total += text.length;
    };

    proc.stdout.on("data", onData("stdout"));
    proc.stderr.on("data", onData("stderr"));

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut,
        outputCapped,
        stdout: "",
        stderr: "",
        elapsedMs: Date.now() - start,
        spawnError: err.message,
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        outputCapped,
        stdout,
        stderr,
        elapsedMs: Date.now() - start,
      });
    });
  });

// Quote one argument for a faithful, policy-evaluable command line. Safe tokens
// pass through; anything else is single-quoted (with embedded quotes escaped) so
// the policy tokenizer sees it as one literal argument rather than operators or
// extra tokens.
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Build the representative command line the policy evaluates: the command and its
// arguments, each safely quoted. The policy then classifies and (for untrusted
// provenance) applies its denial rules to this exact shape.
export function buildPolicyCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

// Redact captured output for the report: strip secrets, then collapse any
// occurrence of the home path and the workspace path so a tool that echoes its
// environment cannot leak host locations.
export function redactToolOutput(text: string, workspace?: string): string {
  let redacted = redactSecrets(text).text;
  // Collapse the workspace before the home path: a workspace nested under the
  // home directory would otherwise be partially rewritten (home → ~) and no
  // longer match the workspace string.
  if (workspace && workspace.length > 1) {
    redacted = redacted.split(workspace).join("<workspace>");
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && home.length > 1) {
    redacted = redacted.split(home).join("~");
  }
  return redacted;
}

export interface ToolInvocationReport {
  schema: string;
  version: number;
  contractVersion: number;
  toolId: string;
  kind: "command";
  command: string;
  argCount: number;
  workspace: string;
  gate: InvocationGate;
  invoked: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  outputCapBytes: number;
  timeoutMs: number;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  reason: string;
  settings: string;
}

// Map a resolved invocation report to a process exit code:
//   2 — refused before execution (not ready, policy-denied, or unapproved).
//   1 — executed but failed at runtime (timeout, oversized, non-zero, spawn err).
//   0 — executed and succeeded (exit 0, bounded, not timed out).
// Contract/selection/version errors are thrown by resolveSelectedTool and mapped
// to exit 2 by the caller, distinct from a tool runtime failure.
export function invocationExitCode(report: ToolInvocationReport): number {
  if (report.gate !== "passed") return 2;
  if (report.timedOut || report.outputCapped) return 1;
  return report.exitCode === 0 ? 0 : 1;
}

export interface InvokeToolOptions {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  toolId?: string;
  workspace: string;
  approvalMode: ApprovalMode;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Override the command runner (tests). Defaults to spawning the command. */
  runner?: CommandRunner;
}

// Resolve, gate, and (if every gate passes) invoke one tool extension. Throws the
// same redacted errors as the read-only contract for contract/selection/version
// failures (caller maps to exit 2); every other failure resolves to a safe
// redacted report (gate refusal or bounded runtime failure) and never throws.
export async function invokeTool(opts: InvokeToolOptions): Promise<ToolInvocationReport> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? spawnCommandRunner;
  const timeoutMs = clampInvokeTimeout(opts.timeoutMs);
  const maxOutputBytes =
    typeof opts.maxOutputBytes === "number" && opts.maxOutputBytes > 0
      ? Math.floor(opts.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  const workspace = path.resolve(opts.workspace);

  // Resolve via #135's contract (version negotiation, selection, readiness). A
  // contract/selection/version error throws here (caller → exit 2).
  const resolved: ResolvedTool = resolveSelectedTool({
    settingsPath: opts.settingsPath,
    env,
    toolId: opts.toolId,
    probe: true,
  });
  const entry = resolved.entry;
  const args = entry.args ?? [];

  const base = {
    schema: TOOL_INVOCATION_SCHEMA,
    version: TOOL_INVOCATION_VERSION,
    contractVersion: resolved.contractVersion,
    toolId: entry.id,
    kind: "command" as const,
    command: redactHomePath(entry.command),
    argCount: args.length,
    workspace: redactHomePath(workspace),
    timeoutMs,
    outputCapBytes: maxOutputBytes,
    settings: resolved.settingsFound
      ? redactHomePath(resolved.settingsPath)
      : `${redactHomePath(resolved.settingsPath)} (not found)`,
  };

  const refused = (gate: InvocationGate, reason: string): ToolInvocationReport => ({
    ...base,
    gate,
    invoked: false,
    exitCode: null,
    timedOut: false,
    outputCapped: false,
    elapsedMs: 0,
    stdout: "",
    stderr: "",
    reason,
  });

  // Gate 1 — readiness: only a resolved-`ready` tool may be invoked.
  if (resolved.readiness.state !== "ready") {
    return refused(
      "not-ready",
      `tool readiness is "${resolved.readiness.state}": ${resolved.readiness.reason}; ` +
        'invocation requires "ready"',
    );
  }

  // Gate 2 — command policy (#51): evaluate the declared command + args as
  // untrusted input, confined to the workspace. A denied command is not executed.
  const policyCommand = buildPolicyCommand(entry.command, args);
  const decision = evaluateCommandPolicy(policyCommand, {
    provenance: TOOL_COMMAND_PROVENANCE,
    workspace,
  });
  if (!decision.allowed) {
    return refused("policy-denied", policyDenialMessage(decision));
  }

  // Gate 3 — approval mode: a command tool is gated as a shell mutation. When
  // approval is required, an interactive terminal may grant it; a non-interactive
  // run fails closed unless the mode is `yolo`.
  if (needsApproval(opts.approvalMode, TOOL_APPROVAL_CATEGORY)) {
    const approved = await promptApproval("shell", { command: policyCommand });
    if (!approved) {
      return refused(
        "unapproved",
        `tool invocation requires approval under approval mode "${opts.approvalMode}"; not executed`,
      );
    }
  }

  // Every gate passed: invoke the command, confined and bounded.
  const run = await runner({
    command: entry.command,
    args,
    cwd: workspace,
    env,
    timeoutMs,
    maxOutputBytes,
  });

  return {
    ...base,
    gate: "passed",
    invoked: true,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    outputCapped: run.outputCapped,
    elapsedMs: run.elapsedMs,
    stdout: redactToolOutput(run.stdout, workspace),
    stderr: redactToolOutput(run.stderr, workspace),
    reason: runtimeReason(run, timeoutMs, maxOutputBytes),
  };
}

// A redacted, human-readable reason for an executed tool's outcome.
function runtimeReason(run: CommandRunResult, timeoutMs: number, maxOutputBytes: number): string {
  if (run.spawnError) {
    return `tool failed to start: ${redactSecrets(run.spawnError).text}`;
  }
  if (run.timedOut) {
    return `tool exceeded the ${timeoutMs}ms hard timeout`;
  }
  if (run.outputCapped) {
    return `tool output exceeded the ${maxOutputBytes}-byte output cap`;
  }
  if (run.exitCode === 0) {
    return "invoked; exit 0";
  }
  if (run.exitCode === null) {
    return "tool terminated without an exit code";
  }
  return `tool exited with code ${run.exitCode}`;
}

// A redacted, human-readable summary of a tool invocation.
export function formatToolInvocation(report: ToolInvocationReport): string {
  const command = redactSecrets(report.command).text;
  const reason = redactSecrets(report.reason).text;
  const lines: string[] = [
    `Tool:         ${report.toolId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Command:      ${command}`,
    `Arguments:    ${report.argCount}`,
    `Workspace:    ${report.workspace}`,
    `Gate:         ${report.gate}`,
    `Invoked:      ${report.invoked}`,
  ];
  if (report.invoked) {
    lines.push(`Exit code:    ${report.exitCode === null ? "(none)" : report.exitCode}`);
    lines.push(
      `Bounds:       ${report.elapsedMs}ms (timeout ${report.timeoutMs}ms, output cap ${report.outputCapBytes} bytes)`,
    );
    if (report.timedOut) lines.push("Timed out:    yes");
    if (report.outputCapped) lines.push("Output cap:   exceeded");
  }
  lines.push(`Reason:       ${reason}`);
  if (report.invoked && report.stdout) {
    lines.push(`Stdout:       ${collapse(report.stdout)}`);
  }
  if (report.invoked && report.stderr) {
    lines.push(`Stderr:       ${collapse(report.stderr)}`);
  }
  lines.push(`Settings:     ${report.settings}`);
  return lines.join("\n");
}

// Collapse whitespace and bound a captured stream for the one-line text view.
const MAX_DISPLAY_OUTPUT = 240;
function collapse(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_DISPLAY_OUTPUT) return oneLine;
  return `${oneLine.slice(0, MAX_DISPLAY_OUTPUT)} …[+${oneLine.length - MAX_DISPLAY_OUTPUT} chars]`;
}
