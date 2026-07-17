// Bounded, deterministic change review.
//
// The CLI can understand a repository (src/repo-context.ts), plan a task
// (src/task-plan.ts), and verify a task by running its canonical commands
// (src/task-verify.ts), but nothing inspects the change itself before it ships.
// "What does this change actually alter, and does it introduce an obvious,
// reviewable risk?" has no objective, machine-checkable answer. This module
// computes the change set between a base ref and the current head/worktree
// using Git only, and emits a deterministic, redacted, head-bound review brief:
// what changed, whether tests accompanied source changes, whether runtime
// dependencies shifted, whether oversized files or protected governance paths
// were touched, and how many added lines look secret-like. It runs no commands
// and calls no provider; every signal is objective and reproducible. Secrets
// are reported only as a count (never literals) and the absolute workspace path
// never appears in the output.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";

export const CHANGE_REVIEW_SCHEMA = "oh-my-cli.change-review";
export const CHANGE_REVIEW_VERSION = 1;

// Bounds that keep the brief compact and free of oversized untrusted content.
const MAX_FILES_LIST = 60;
const MAX_TOTAL_LINES = 4_000;
const LARGE_FILE_ADDED_LINES = 800;
const MAX_DEPS_LISTED = 40;
const MAX_DIFF_SCAN_BYTES = 256 * 1024;
const MAX_PATH_LEN = 200;
const MAX_NAME_LEN = 200;
const MAX_UNTRACKED = 200;
const BIG_BUFFER = 16 << 20;

// Directories that count as "source" for the source-without-tests signal. A
// repository that does not use these simply never trips the signal (no false
// positives), keeping the verdict conservative.
const SOURCE_DIRS = ["src", "lib", "app", "bin", "pkg", "internal", "cmd", "packages"];

// Code file extensions (used together with SOURCE_DIRS to classify source).
const CODE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".rb", ".php", ".c", ".h", ".cpp", ".cc",
  ".hpp", ".cs", ".swift", ".kt", ".kts", ".scala", ".vue", ".dart", ".lua",
]);

// Governance, security, and license paths a reviewer should always notice.
const PROTECTED_FILES = new Set([
  "AUTONOMY.md", "SECURITY.md", "LICENSE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
]);

export type ChangeReviewVerdict = "no-change" | "clean" | "needs-attention";

export interface FileChange {
  /** Redacted, repository-relative path. */
  path: string;
  /** Change-type code from git (A, M, D, R, C, …). */
  status: string;
  /** Lines added (0 for binary files). */
  added: number;
  /** Lines removed (0 for binary files). */
  removed: number;
  /** True when git reported the file as binary. */
  binary: boolean;
}

export interface DependencyChange {
  /** Runtime dependencies added relative to the base (sorted, bounded). */
  added: string[];
  /** Runtime dependencies removed relative to the base (sorted, bounded). */
  removed: string[];
}

export interface ChangeReviewSignals {
  /** Count of added lines that contain a secret-like string (literals never stored). */
  secretsIntroduced: number;
  /** Redacted protected/governance paths touched by the change. */
  protectedPaths: string[];
  /** True when source files changed but no test files did. */
  sourceWithoutTests: boolean;
  /** True when the change exceeds a file-count, line-count, or per-file bound. */
  oversized: boolean;
  /** Runtime dependency delta when package.json changed, else null. */
  dependencies: DependencyChange | null;
}

export interface ChangeReviewReport {
  schema: typeof CHANGE_REVIEW_SCHEMA;
  v: typeof CHANGE_REVIEW_VERSION;
  /** Repository head SHA the brief is bound to, or null when not a repo. */
  head: string | null;
  /** Base ref the change is measured against and its resolved SHA. */
  base: { ref: string; sha: string | null };
  /** Overall verdict. */
  verdict: ChangeReviewVerdict;
  /** Total number of files in the change set. */
  filesChanged: number;
  /** Total lines added across the change set. */
  linesAdded: number;
  /** Total lines removed across the change set. */
  linesRemoved: number;
  /** Number of files git reported as binary. */
  binaryFiles: number;
  /** True when more files were in the change set than are listed. */
  filesTruncated: boolean;
  /** Bounded, redacted per-file change list (canonical order). */
  files: FileChange[];
  /** Objective risk signals. */
  signals: ChangeReviewSignals;
}

export interface ChangeReviewOptions {
  /** Workspace to review (default cwd). */
  workspace?: string;
  /** Base ref to measure against (default origin/main when present, else HEAD). */
  base?: string;
}

// --- redaction helpers ------------------------------------------------------

function redactPath(text: string): string {
  return redactSecrets(text).text.slice(0, MAX_PATH_LEN);
}

function redactName(text: string): string {
  return redactSecrets(text).text.slice(0, MAX_NAME_LEN);
}

// A locale-independent comparator (UTF-16 code-unit order) for deterministic
// ordering regardless of host locale.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- path classification (pure) ---------------------------------------------

/** True when a path looks like a test file (test dir or .test/.spec suffix). */
export function isTestPath(p: string): boolean {
  if (/(^|\/)(tests?|__tests__|spec|specs)\//i.test(p)) return true;
  return /\.(test|spec)\.[^/]+$/i.test(p);
}

/** True when a path is a source file under a known source directory. */
export function isSourcePath(p: string): boolean {
  if (isTestPath(p)) return false;
  const top = p.split("/")[0];
  if (!SOURCE_DIRS.includes(top)) return false;
  return CODE_EXT.has(path.extname(p).toLowerCase());
}

/** True when a path is a protected governance / security / license file. */
export function isProtectedPath(p: string): boolean {
  return PROTECTED_FILES.has(p) || p.startsWith(".autonomy/");
}

// --- git collection (read-only) ---------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(
  workspace: string,
  args: string[],
  timeoutMs = 10_000,
  maxBuffer = 2 << 20,
): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function repoHead(workspace: string): string | null {
  const sha = git(workspace, ["rev-parse", "HEAD"], 5_000).stdout.trim();
  return sha || null;
}

// Resolve the base ref to measure against. Prefers an explicit base, then
// origin/main, then HEAD; falls back to a null SHA when nothing resolves.
function resolveBase(workspace: string, base?: string): { ref: string; sha: string | null } {
  const candidates = base ? [base] : ["origin/main", "HEAD"];
  for (const ref of candidates) {
    const sha = git(workspace, ["rev-parse", "--verify", "--quiet", ref], 5_000).stdout.trim();
    if (sha) return { ref, sha };
  }
  return { ref: base ?? "HEAD", sha: null };
}

interface RawFileChange {
  path: string;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

// Parse `git diff --name-status` into an authoritative file list with status.
function parseNameStatus(stdout: string): Array<{ path: string; status: string }> {
  const out: Array<{ path: string; status: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = (fields[0] ?? "").charAt(0) || "?";
    // Renames/copies carry two paths (old, new); the new path is the last field.
    const p = fields.length >= 3 ? fields[fields.length - 1] : fields[1];
    if (p) out.push({ path: p, status });
  }
  return out;
}

interface Numstat {
  linesAdded: number;
  linesRemoved: number;
  binaryFiles: number;
  maxFileAdded: number;
  perPath: Map<string, { added: number; removed: number; binary: boolean }>;
}

// Parse `git diff --numstat` into aggregate counts plus a best-effort per-path
// map (used to attach line counts and detect oversized single files).
function parseNumstat(stdout: string): Numstat {
  const perPath = new Map<string, { added: number; removed: number; binary: boolean }>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let binaryFiles = 0;
  let maxFileAdded = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, r] = parts;
    const raw = parts.slice(2).join("\t");
    const binary = a === "-" && r === "-";
    const added = binary ? 0 : Number.parseInt(a, 10) || 0;
    const removed = binary ? 0 : Number.parseInt(r, 10) || 0;
    linesAdded += added;
    linesRemoved += removed;
    if (binary) binaryFiles++;
    if (added > maxFileAdded) maxFileAdded = added;
    // A rename prints "old => new"; keep the new side for best-effort matching.
    const norm = raw.includes(" => ") ? raw.split(" => ").pop()! : raw;
    perPath.set(norm, { added, removed, binary });
  }
  return { linesAdded, linesRemoved, binaryFiles, maxFileAdded, perPath };
}

// Count added lines in the diff that look secret-like. The diff is read only to
// be scanned; its content (which may contain a literal secret) is never stored
// or returned — only the count. Bounded to MAX_DIFF_SCAN_BYTES.
function scanAddedLinesForSecrets(workspace: string, ref: string): number {
  const diff = git(workspace, ["diff", "--no-color", ref], 20_000, BIG_BUFFER);
  if (!diff.ok) return 0;
  const text = diff.stdout.slice(0, MAX_DIFF_SCAN_BYTES);
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (redactSecrets(line).count > 0) count++;
    }
  }
  return count;
}

function readWorkspaceFile(workspace: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(workspace, rel), "utf8");
  } catch {
    return null;
  }
}

// List untracked (and not ignored) files. `git diff` never shows untracked
// files, so a review brief that relied on the diff alone would silently omit
// brand-new files — the very thing a reviewer most wants to notice. Bounded.
function untrackedFiles(workspace: string): string[] {
  const r = git(workspace, ["ls-files", "--others", "--exclude-standard"], 5_000);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).slice(0, MAX_UNTRACKED);
}

// Count added lines in an untracked file (bounded) and detect binary content.
function countAddedLines(workspace: string, rel: string): { added: number; binary: boolean } {
  try {
    const fd = fs.openSync(path.join(workspace, rel), "r");
    try {
      const buf = Buffer.alloc(MAX_DIFF_SCAN_BYTES);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytes);
      if (slice.includes(0)) return { added: 0, binary: true };
      const text = slice.toString("utf8");
      if (text.length === 0) return { added: 0, binary: false };
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      return { added: Math.max(0, lines), binary: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { added: 0, binary: false };
  }
}

// Count secret-like lines in an untracked file (bounded). The file content is
// scanned only to be counted; it is never stored or returned.
function scanFileForSecrets(workspace: string, rel: string): number {
  const text = readWorkspaceFile(workspace, rel);
  if (text === null) return 0;
  let count = 0;
  for (const line of text.slice(0, MAX_DIFF_SCAN_BYTES).split("\n")) {
    if (redactSecrets(line).count > 0) count++;
  }
  return count;
}

function dependencyKeys(json: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const deps = (parsed as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== "object") return [];
  return Object.keys(deps as Record<string, unknown>);
}

// Diff the runtime dependencies declared in package.json against the base. Only
// the `dependencies` map is considered (not devDependencies). Returns null when
// either side is missing or unparseable.
function diffDependencies(workspace: string, ref: string): DependencyChange | null {
  const newText = readWorkspaceFile(workspace, "package.json");
  const shown = git(workspace, ["show", `${ref}:package.json`], 5_000);
  const oldText = shown.ok ? shown.stdout : null;
  if (newText === null || oldText === null) return null;
  const oldDeps = dependencyKeys(oldText);
  const newDeps = dependencyKeys(newText);
  if (oldDeps === null || newDeps === null) return null;
  const oldSet = new Set(oldDeps);
  const newSet = new Set(newDeps);
  const added = newDeps.filter((d) => !oldSet.has(d)).sort(byCodeUnit);
  const removed = oldDeps.filter((d) => !newSet.has(d)).sort(byCodeUnit);
  return { added, removed };
}

// --- report assembly (pure) -------------------------------------------------

/**
 * Assemble a deterministic, redacted change-review report from collected diff
 * facts. Pure: identical facts always produce an identical report.
 */
export function buildChangeReviewReport(facts: {
  head: string | null;
  base: { ref: string; sha: string | null };
  files: RawFileChange[];
  linesAdded: number;
  linesRemoved: number;
  binaryFiles: number;
  maxFileAdded: number;
  secretLines: number;
  dependencyChange: DependencyChange | null;
}): ChangeReviewReport {
  const emptySignals: ChangeReviewSignals = {
    secretsIntroduced: 0,
    protectedPaths: [],
    sourceWithoutTests: false,
    oversized: false,
    dependencies: null,
  };

  if (facts.files.length === 0) {
    return {
      schema: CHANGE_REVIEW_SCHEMA,
      v: CHANGE_REVIEW_VERSION,
      head: facts.head,
      base: facts.base,
      verdict: "no-change",
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      binaryFiles: 0,
      filesTruncated: false,
      files: [],
      signals: emptySignals,
    };
  }

  const protectedPaths = [
    ...new Set(facts.files.filter((f) => isProtectedPath(f.path)).map((f) => redactPath(f.path))),
  ].sort(byCodeUnit);
  const sourceCount = facts.files.filter((f) => isSourcePath(f.path)).length;
  const testCount = facts.files.filter((f) => isTestPath(f.path)).length;
  const sourceWithoutTests = sourceCount > 0 && testCount === 0;
  const oversized =
    facts.files.length > MAX_FILES_LIST ||
    facts.linesAdded + facts.linesRemoved > MAX_TOTAL_LINES ||
    facts.maxFileAdded > LARGE_FILE_ADDED_LINES;
  const secretsIntroduced = facts.secretLines;
  const depAdded = (facts.dependencyChange?.added.length ?? 0) > 0;

  const needsAttention =
    secretsIntroduced > 0 ||
    protectedPaths.length > 0 ||
    sourceWithoutTests ||
    oversized ||
    depAdded;

  const sorted = [...facts.files].sort((a, b) => byCodeUnit(a.path, b.path));
  const filesTruncated = sorted.length > MAX_FILES_LIST;
  const files: FileChange[] = sorted.slice(0, MAX_FILES_LIST).map((f) => ({
    path: redactPath(f.path),
    status: f.status,
    added: f.added,
    removed: f.removed,
    binary: f.binary,
  }));

  const dependencies: DependencyChange | null = facts.dependencyChange
    ? {
        added: facts.dependencyChange.added.slice(0, MAX_DEPS_LISTED).map(redactName),
        removed: facts.dependencyChange.removed.slice(0, MAX_DEPS_LISTED).map(redactName),
      }
    : null;

  return {
    schema: CHANGE_REVIEW_SCHEMA,
    v: CHANGE_REVIEW_VERSION,
    head: facts.head,
    base: facts.base,
    verdict: needsAttention ? "needs-attention" : "clean",
    filesChanged: facts.files.length,
    linesAdded: facts.linesAdded,
    linesRemoved: facts.linesRemoved,
    binaryFiles: facts.binaryFiles,
    filesTruncated,
    files,
    signals: {
      secretsIntroduced,
      protectedPaths,
      sourceWithoutTests,
      oversized,
      dependencies,
    },
  };
}

/**
 * Review the current change against a base ref and produce a bounded, redacted,
 * head-bound review brief. Read-only: it inspects Git and package.json only,
 * runs no commands, calls no provider, and never mutates the repository or
 * governance paths.
 */
export function reviewChange(opts: ChangeReviewOptions = {}): ChangeReviewReport {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const base = resolveBase(workspace, opts.base);
  const head = repoHead(workspace);

  const nameStatus = git(workspace, ["diff", "--name-status", base.ref], 15_000);
  const numstat = git(workspace, ["diff", "--numstat", base.ref], 15_000);
  const entries = nameStatus.ok ? parseNameStatus(nameStatus.stdout) : [];
  const num = numstat.ok
    ? parseNumstat(numstat.stdout)
    : { linesAdded: 0, linesRemoved: 0, binaryFiles: 0, maxFileAdded: 0, perPath: new Map() };

  const files: RawFileChange[] = entries.map((e) => {
    const counts = num.perPath.get(e.path);
    return {
      path: e.path,
      status: e.status,
      added: counts?.added ?? 0,
      removed: counts?.removed ?? 0,
      binary: counts?.binary ?? false,
    };
  });

  // Fold in untracked (new) files, which `git diff` never reports. Without this
  // a brand-new module would be invisible to the brief.
  const trackedPaths = new Set(entries.map((e) => e.path));
  let linesAdded = num.linesAdded;
  let binaryFiles = num.binaryFiles;
  let maxFileAdded = num.maxFileAdded;
  let secretLines = scanAddedLinesForSecrets(workspace, base.ref);
  for (const rel of untrackedFiles(workspace)) {
    if (trackedPaths.has(rel)) continue;
    const { added, binary } = countAddedLines(workspace, rel);
    files.push({ path: rel, status: "A", added, removed: 0, binary });
    linesAdded += added;
    if (binary) binaryFiles++;
    if (added > maxFileAdded) maxFileAdded = added;
    if (!binary) secretLines += scanFileForSecrets(workspace, rel);
  }

  const paths = files.map((f) => f.path);
  const dependencyChange = paths.includes("package.json")
    ? diffDependencies(workspace, base.ref)
    : null;

  return buildChangeReviewReport({
    head,
    base,
    files,
    linesAdded,
    linesRemoved: num.linesRemoved,
    binaryFiles,
    maxFileAdded,
    secretLines,
    dependencyChange,
  });
}

// --- formatting -------------------------------------------------------------

export function formatChangeReviewReport(report: ChangeReviewReport): string {
  const lines: string[] = [];
  lines.push(`Change review (${report.schema} v${report.v})`);
  lines.push("─".repeat(46));
  lines.push(`Head   : ${report.head ?? "(not a git repository)"}`);
  lines.push(`Base   : ${report.base.ref} (${report.base.sha ?? "unknown"})`);
  lines.push(`Verdict: ${report.verdict}`);

  if (report.verdict === "no-change") {
    lines.push("No changes relative to base.");
    return lines.join("\n");
  }

  const bin = report.binaryFiles > 0 ? `, ${report.binaryFiles} binary` : "";
  lines.push(
    `Changes: ${report.filesChanged} file(s), +${report.linesAdded} -${report.linesRemoved}${bin}`,
  );

  lines.push("Files:");
  for (const f of report.files) {
    const counts = f.binary ? "(binary)" : `(+${f.added} -${f.removed})`;
    lines.push(`  ${f.status.padEnd(2)} ${f.path}  ${counts}`);
  }
  if (report.filesTruncated) {
    lines.push(`  … (+${report.filesChanged - report.files.length} more)`);
  }

  const s = report.signals;
  lines.push("Signals:");
  lines.push(`  Secrets introduced : ${s.secretsIntroduced} added line(s)`);
  lines.push(
    `  Protected paths    : ${s.protectedPaths.length > 0 ? s.protectedPaths.join(", ") : "none"}`,
  );
  lines.push(`  Source w/o tests   : ${s.sourceWithoutTests ? "yes" : "no"}`);
  lines.push(`  Oversized change   : ${s.oversized ? "yes" : "no"}`);
  if (s.dependencies) {
    const added = s.dependencies.added.length > 0 ? `+${s.dependencies.added.join(", ")}` : "";
    const removed = s.dependencies.removed.length > 0 ? `-${s.dependencies.removed.join(", ")}` : "";
    const detail = [added, removed].filter(Boolean).join("  ") || "no runtime dependency change";
    lines.push(`  Runtime deps       : ${detail}`);
  } else {
    lines.push("  Runtime deps       : n/a");
  }

  return lines.join("\n");
}
