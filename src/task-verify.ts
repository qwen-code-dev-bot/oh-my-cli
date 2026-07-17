// Bounded, deterministic task verification.
//
// The CLI can plan a task (src/task-plan.ts) and list the canonical verify
// commands a repository declares, but nothing runs them, so "does this change
// actually pass its own build/test/typecheck/lint?" has no objective, machine-
// checkable answer. This module executes the repository's own detected
// canonical verify commands (build → test → typecheck → lint) against the
// current workspace, with a bounded per-command timeout and bounded output
// capture, and emits a deterministic, redacted pass/fail verdict bound to the
// repository head. It runs only the commands the repository itself declares
// (the same ones a developer runs by hand) and never accepts arbitrary command
// strings. Secrets and the absolute workspace path are scrubbed from captured
// output; the command set is exactly what the planner reports.

import { spawnSync, execFileSync } from "node:child_process";
import * as path from "node:path";
import { collectRepoContext } from "./repo-context.js";
import type { RepoContextSnapshot, CanonicalCommand } from "./repo-context.js";
import { redactSecrets } from "./permission-impact.js";

export const VERIFY_SCHEMA = "oh-my-cli.task-verify";
export const VERIFY_VERSION = 1;

// Canonical execution order, identical to the planner (src/task-plan.ts).
const CANONICAL_ORDER: CanonicalCommand[] = ["build", "test", "typecheck", "lint"];

// Bounds that keep the verdict compact and free of oversized untrusted output.
const MAX_COMMAND_LEN = 120;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_BUFFER_BYTES = 1 << 20; // 1 MiB captured per command before bounding
const DEFAULT_TIMEOUT_MS = 120_000;

export type VerifyVerdict = "pass" | "fail" | "no-verify-commands";

export interface CommandResult {
  /** Canonical command name (build, test, typecheck, lint). */
  name: CanonicalCommand;
  /** The resolved command, redacted and bounded for display. */
  command: string;
  /** Process exit code, or null when killed/timed out/failed to spawn. */
  exitCode: number | null;
  /** True when the command exited 0 within its timeout. */
  passed: boolean;
  /** True when the command was killed for exceeding its timeout. */
  timedOut: boolean;
  /** Wall-clock duration in milliseconds (a measurement, not deterministic). */
  durationMs: number;
  /** Redacted, path-scrubbed, bounded tail of captured stdout+stderr. */
  outputTail: string;
}

export interface TaskVerifyReport {
  schema: typeof VERIFY_SCHEMA;
  v: typeof VERIFY_VERSION;
  /** Repository head SHA the verdict is bound to, or null when not a repo. */
  head: string | null;
  /** Overall verdict. */
  verdict: VerifyVerdict;
  /** Per-command results, in canonical order. */
  results: CommandResult[];
}

export interface TaskVerifyOptions {
  /** Workspace to verify (default cwd). */
  workspace?: string;
  /** Per-command timeout in milliseconds (default 120s). */
  timeoutMs?: number;
}

// Redact secrets and the absolute workspace path, then keep the bounded tail.
export function scrubOutput(combined: string, workspace: string): string {
  const redacted = redactSecrets(combined ?? "").text;
  const abs = path.resolve(workspace);
  const scrubbed = redacted.split(abs).join("[workspace]");
  if (scrubbed.length <= MAX_OUTPUT_BYTES) return scrubbed;
  return scrubbed.slice(scrubbed.length - MAX_OUTPUT_BYTES);
}

// Display form of a command: secret-redacted, workspace-path-scrubbed, bounded.
export function displayCommand(command: string, workspace?: string): string {
  let text = redactSecrets(command ?? "").text;
  if (workspace) text = text.split(path.resolve(workspace)).join("[workspace]");
  return text.slice(0, MAX_COMMAND_LEN);
}

// Run one canonical command, bounded by timeout and output capture. Only ever
// called with a command the repository itself declared.
export function runCommand(
  name: CanonicalCommand,
  command: string,
  workspace: string,
  timeoutMs: number,
): CommandResult {
  const start = Date.now();
  // Mirror npm: package.json scripts resolve their tools from the workspace's
  // node_modules/.bin, which npm prepends to PATH. A bare shell would not find
  // them, so prepend it here (harmless when the directory does not exist).
  const binDir = path.join(path.resolve(workspace), "node_modules", ".bin");
  const PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const result = spawnSync("/bin/bash", ["-c", command], {
    cwd: workspace,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const durationMs = Date.now() - start;
  const timedOut = result.signal != null;
  const exitCode = typeof result.status === "number" ? result.status : null;
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    name,
    command: displayCommand(command, workspace),
    exitCode,
    passed: exitCode === 0 && !timedOut,
    timedOut,
    durationMs,
    outputTail: scrubOutput(combined, workspace),
  };
}

// Resolve the repository head SHA the verdict is bound to (null when not a repo).
function repoHead(workspace: string): string | null {
  try {
    const out = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sha = out.trim();
    return sha || null;
  } catch {
    return null;
  }
}

// Assemble the verdict deterministically from per-command results.
export function buildVerifyReport(
  head: string | null,
  results: CommandResult[],
): TaskVerifyReport {
  const verdict: VerifyVerdict =
    results.length === 0
      ? "no-verify-commands"
      : results.every((r) => r.passed)
        ? "pass"
        : "fail";
  return { schema: VERIFY_SCHEMA, v: VERIFY_VERSION, head, verdict, results };
}

/**
 * Run the repository's own detected canonical verify commands and produce a
 * bounded, redacted, head-bound pass/fail verdict. Executes only the commands
 * the repository declares (build/test/typecheck/lint); never accepts arbitrary
 * command strings and never mutates governance/protected paths.
 */
export function verifyTask(opts: TaskVerifyOptions = {}): TaskVerifyReport {
  const workspace = opts.workspace ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const snapshot: RepoContextSnapshot = collectRepoContext({ workspace });
  const head = repoHead(workspace);
  const results: CommandResult[] = [];
  for (const key of CANONICAL_ORDER) {
    const ref = snapshot.commands[key];
    if (ref) results.push(runCommand(key, ref.command, workspace, timeoutMs));
  }
  return buildVerifyReport(head, results);
}

// --- formatting -------------------------------------------------------------

export function formatVerifyReport(report: TaskVerifyReport): string {
  const lines: string[] = [];
  lines.push(`Task verification (${report.schema} v${report.v})`);
  lines.push("─".repeat(46));
  lines.push(`Head   : ${report.head ?? "(not a git repository)"}`);
  lines.push(`Verdict: ${report.verdict}`);
  if (report.results.length === 0) {
    lines.push("No canonical verification command detected.");
  } else {
    lines.push("Commands:");
    for (const r of report.results) {
      const status = r.passed ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
      const exit = r.exitCode === null ? "n/a" : String(r.exitCode);
      lines.push(
        `  [${status}] ${r.name.padEnd(10)} ${r.command}  (exit ${exit}, ${r.durationMs}ms)`,
      );
      if (!r.passed && r.outputTail) {
        for (const line of r.outputTail.split("\n")) lines.push(`      | ${line}`);
      }
    }
  }
  return lines.join("\n");
}
