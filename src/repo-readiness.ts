// Read-only repository-readiness inspection.
//
// Autonomous work often stalls because a repository prerequisite is missing,
// and a generic failure leaves the operator guessing whether the blocker is the
// working tree, the branch, the test setup, a tool, or the remote. This module
// inspects repository-local and Git metadata only — it never installs, creates,
// edits, fetches into, or otherwise mutates anything — and explains a single
// blocked task with bounded, structured evidence and a *safe* next action (a
// recommendation, never an executed command). Every detail is redacted so
// credentials, host paths, environment values, and raw command output stay out
// of the output. Each check is a pure function so healthy and blocked fixtures
// can be exercised deterministically.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";

export const READINESS_SCHEMA = "oh-my-cli.readiness";
export const READINESS_VERSION = 1;

export type ReadinessStatus = "pass" | "fail";

export interface ReadinessCheck {
  /** Stable machine id: worktree | branch | test-command | executable | remote. */
  id: string;
  label: string;
  status: ReadinessStatus;
  /** Redacted, bounded evidence for the classification. */
  detail: string;
  /** A safe recommendation when failing; never an executed command. */
  nextAction?: string;
}

export interface RepoReadinessReport {
  schema: typeof READINESS_SCHEMA;
  v: typeof READINESS_VERSION;
  /** True when no check failed. */
  ready: boolean;
  /** The id of the first failing check (the explained blocker), or null. */
  blocker: string | null;
  checks: ReadinessCheck[];
}

const SYMBOLS: Record<ReadinessStatus, string> = { pass: "✓", fail: "✗" };

function redact(text: string): string {
  return redactSecrets(text).text;
}

// --- pure checks ------------------------------------------------------------

export function checkWorktree(state: { repo: boolean; dirtyCount: number }): ReadinessCheck {
  const id = "worktree";
  const label = "Worktree";
  if (!state.repo) {
    return {
      id,
      label,
      status: "fail",
      detail: "not a git repository",
      nextAction: "Run inside a git repository (git init or git clone).",
    };
  }
  if (state.dirtyCount <= 0) {
    return { id, label, status: "pass", detail: "clean" };
  }
  return {
    id,
    label,
    status: "fail",
    detail: `${state.dirtyCount} uncommitted change(s)`,
    nextAction: "Commit or stash local changes before starting autonomous work.",
  };
}

export function checkBranch(state: {
  repo: boolean;
  branch: string | null;
  expected?: string;
}): ReadinessCheck {
  const id = "branch";
  const label = "Branch";
  if (!state.repo || state.branch === null) {
    return {
      id,
      label,
      status: "fail",
      detail: "not a git repository",
      nextAction: "Run inside a git repository (git init or git clone).",
    };
  }
  // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached.
  if (state.branch === "HEAD") {
    return {
      id,
      label,
      status: "fail",
      detail: "detached HEAD",
      nextAction: "Check out the branch this task should run on (e.g. git switch <branch>).",
    };
  }
  const branch = redact(state.branch);
  if (state.expected && state.expected !== state.branch) {
    const expected = redact(state.expected);
    return {
      id,
      label,
      status: "fail",
      detail: `on "${branch}", expected "${expected}"`,
      nextAction: `Switch to the expected branch (git switch ${expected}).`,
    };
  }
  return { id, label, status: "pass", detail: `on "${branch}"` };
}

export function checkTestCommand(state: {
  hasCommand: boolean;
  command?: string;
  reason?: string;
}): ReadinessCheck {
  const id = "test-command";
  const label = "Test command";
  if (state.hasCommand) {
    const shown = redact(state.command ?? "configured").slice(0, 80);
    return { id, label, status: "pass", detail: shown };
  }
  return {
    id,
    label,
    status: "fail",
    detail: redact(state.reason ?? "no test command configured"),
    nextAction: "Add a 'test' script to package.json so changes can be verified.",
  };
}

export function checkExecutables(state: { required: string[]; missing: string[] }): ReadinessCheck {
  const id = "executable";
  const label = "Required tools";
  if (state.missing.length === 0) {
    return { id, label, status: "pass", detail: `${state.required.map(redact).join(", ")} available` };
  }
  const missing = state.missing.map(redact).join(", ");
  return {
    id,
    label,
    status: "fail",
    detail: `missing ${missing}`,
    nextAction: `Install ${missing} and ensure it is on PATH.`,
  };
}

export function checkRemote(state: {
  repo: boolean;
  remote: string;
  configured: boolean;
  reachable: boolean;
  reason?: string | null;
}): ReadinessCheck {
  const id = "remote";
  const label = "Remote";
  const name = redact(state.remote);
  if (!state.repo) {
    return {
      id,
      label,
      status: "fail",
      detail: "not a git repository",
      nextAction: "Run inside a git repository (git init or git clone).",
    };
  }
  if (!state.configured) {
    return {
      id,
      label,
      status: "fail",
      detail: `remote "${name}" not configured`,
      nextAction: `Add the remote (git remote add ${name} <url>) or pass --remote <name>.`,
    };
  }
  if (state.reachable) {
    return { id, label, status: "pass", detail: `remote "${name}" reachable` };
  }
  const why = state.reason ? ` (${redact(state.reason)})` : "";
  return {
    id,
    label,
    status: "fail",
    detail: `remote "${name}" unreachable${why}`,
    nextAction: `Check network connectivity and credentials for "${name}".`,
  };
}

// --- collection (read-only) -------------------------------------------------

export interface RepoReadinessOptions {
  /** Workspace to inspect (default cwd). */
  workspace?: string;
  /** Optional expected branch for the wrong-branch classification. */
  expectedBranch?: string;
  /** Git remote to probe (default "origin"). */
  remote?: string;
  /** Executables that must be on PATH (default ["git"]). */
  requiredExecutables?: string[];
  /** Bound on the remote reachability probe (ms). */
  remoteTimeoutMs?: number;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(workspace: string, args: string[], timeoutMs = 5_000): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function commandAvailable(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore", timeout: 5_000, maxBuffer: 1 << 20 });
    return true;
  } catch (err) {
    // A spawned-but-non-zero exit still means the executable exists; only a
    // spawn failure (ENOENT) means it is genuinely missing.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function detectTestCommand(workspace: string): {
  hasCommand: boolean;
  command?: string;
  reason?: string;
} {
  const pkgPath = path.join(workspace, "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch {
    return { hasCommand: false, reason: "no package.json found" };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { hasCommand: false, reason: "package.json is not valid JSON" };
  }
  const scripts = (pkg as { scripts?: Record<string, unknown> }).scripts;
  const test = scripts?.test;
  if (typeof test === "string" && test.trim()) {
    return { hasCommand: true, command: test.trim() };
  }
  return { hasCommand: false, reason: "package.json has no 'test' script" };
}

function probeRemote(
  workspace: string,
  remote: string,
  timeoutMs: number,
): { configured: boolean; reachable: boolean; reason?: string | null } {
  const remotes = git(workspace, ["remote"])
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!remotes.includes(remote)) {
    return { configured: false, reachable: false };
  }
  try {
    // No --exit-code: a reachable remote with no matching refs still exits 0,
    // so a non-zero exit (or timeout) reliably means the remote is unreachable.
    execFileSync("git", ["-C", workspace, "ls-remote", "--heads", remote], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    return { configured: true, reachable: true };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string };
    const reason = e.killed || e.signal === "SIGTERM" ? "timed out" : null;
    return { configured: true, reachable: false, reason };
  }
}

/**
 * Inspect a workspace and produce a deterministic readiness report. All probes
 * are read-only; nothing about the repository or filesystem is mutated.
 */
export function collectRepoReadiness(opts: RepoReadinessOptions = {}): RepoReadinessReport {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const remote = opts.remote ?? "origin";
  const required = opts.requiredExecutables ?? ["git"];
  const remoteTimeoutMs = opts.remoteTimeoutMs ?? 8_000;

  const isRepo =
    git(workspace, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";

  let dirtyCount = 0;
  if (isRepo) {
    dirtyCount = git(workspace, ["status", "--porcelain"])
      .stdout.split("\n")
      .filter((line) => line.trim().length > 0).length;
  }

  let branch: string | null = null;
  if (isRepo) {
    const r = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = r.ok ? r.stdout.trim() || null : null;
  }

  const testInfo = detectTestCommand(workspace);

  const missing = required.filter((name) => !commandAvailable(name));

  const remoteProbe = isRepo
    ? probeRemote(workspace, remote, remoteTimeoutMs)
    : { configured: false, reachable: false, reason: null };

  const checks: ReadinessCheck[] = [
    checkWorktree({ repo: isRepo, dirtyCount }),
    checkBranch({ repo: isRepo, branch, expected: opts.expectedBranch }),
    checkTestCommand(testInfo),
    checkExecutables({ required, missing }),
    checkRemote({ repo: isRepo, remote, ...remoteProbe }),
  ];

  const blocker = checks.find((c) => c.status === "fail")?.id ?? null;
  return {
    schema: READINESS_SCHEMA,
    v: READINESS_VERSION,
    ready: blocker === null,
    blocker,
    checks,
  };
}

// --- formatting -------------------------------------------------------------

export function formatRepoReadiness(report: RepoReadinessReport): string {
  const lines: string[] = [];
  lines.push(`Repository readiness (${report.schema} v${report.v})`);
  lines.push("─".repeat(40));
  for (const c of report.checks) {
    lines.push(`${SYMBOLS[c.status]} ${c.label.padEnd(15)} ${c.detail}`);
    if (c.status === "fail" && c.nextAction) {
      lines.push(`    → ${c.nextAction}`);
    }
  }
  lines.push("");
  if (report.ready) {
    lines.push("Ready: no blocker detected.");
  } else {
    lines.push(`Blocked by: ${report.blocker} — see the → next action above.`);
  }
  return lines.join("\n");
}
