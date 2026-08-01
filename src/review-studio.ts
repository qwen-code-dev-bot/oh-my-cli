// Read-only review studio: browses the exact active worktree's changed files
// and hunks through one authoritative diff model.
//
// Users can distinguish staged, unstaged, untracked, conflict, and
// detached-head states, inspect bounded hunks, and trace available
// checkpoint or producing-turn provenance. Browsing never stages, reverts,
// commits, pushes, or changes repository state. The model is
// surface-independent: the same worktree produces the same output for the
// TUI and a future Desktop pane.

import { execFileSync } from "node:child_process";
import path from "node:path";

export const REVIEW_STUDIO_SCHEMA = "oh-my-cli.review-studio";
export const REVIEW_STUDIO_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const MAX_FILES = 200;
const MAX_HUNKS_PER_FILE = 50;
const MAX_HUNK_LINES = 100;
const GIT_TIMEOUT_MS = 10_000;

// --- worktree state ---------------------------------------------------------

export type HeadState = "branch" | "detached";

export type FileStatus =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflict"
  | "staged+unstaged";

export interface WorktreeState {
  /** Absolute path to the worktree root. */
  root: string;
  /** Whether HEAD is on a branch or detached. */
  headState: HeadState;
  /** Current branch name (null when detached). */
  branch: string | null;
  /** HEAD commit SHA (short). */
  headSha: string;
  /** Whether any merge/rebase conflict is in progress. */
  conflictInProgress: boolean;
}

// --- changed files ----------------------------------------------------------

export interface ChangedFile {
  /** Workspace-relative path. */
  path: string;
  status: FileStatus;
  /** Staged hunks (from git diff --cached). */
  stagedHunks: Hunk[];
  /** Unstaged hunks (from git diff). */
  unstagedHunks: Hunk[];
}

// --- hunks ------------------------------------------------------------------

export interface HunkLine {
  type: "add" | "remove" | "context";
  content: string;
  /** Old line number (for context/remove). */
  oldLine?: number;
  /** New line number (for context/add). */
  newLine?: number;
}

export interface Hunk {
  /** Hunk header (e.g. @@ -1,5 +1,7 @@). */
  header: string;
  lines: HunkLine[];
  /** Provenance: producing turn or checkpoint, when available. */
  provenance?: string;
}

// --- review result ----------------------------------------------------------

export interface ReviewResult {
  schema: typeof REVIEW_STUDIO_SCHEMA;
  v: typeof REVIEW_STUDIO_VERSION;
  worktree: WorktreeState;
  files: ChangedFile[];
  totalFiles: number;
  truncated: boolean;
  /** Snapshot time (epoch ms). */
  snapshotAt: number;
}

// --- git helpers (read-only) ------------------------------------------------

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1_048_576,
    }).trim();
  } catch {
    return "";
  }
}

function detectWorktreeState(root: string): WorktreeState {
  const headSha = git(root, ["rev-parse", "--short", "HEAD"]);
  const symbolicRef = git(root, ["symbolic-ref", "--short", "HEAD"]);
  const headState: HeadState = symbolicRef ? "branch" : "detached";
  const branch = symbolicRef || null;

  // Check for conflict state (MERGE_HEAD, REBASE_HEAD, or unmerged paths).
  const mergeHead = git(root, ["rev-parse", "--verify", "MERGE_HEAD"]);
  const rebaseHead = git(root, ["rev-parse", "--verify", "REBASE_HEAD"]);
  const unmerged = git(root, ["diff", "--name-only", "--diff-filter=U"]);
  const conflictInProgress = !!(mergeHead || rebaseHead || unmerged);

  return { root, headState, branch, headSha, conflictInProgress };
}

// Parse `git status --porcelain=v1` output into file statuses.
function parseStatus(root: string): Map<string, FileStatus> {
  const output = git(root, ["status", "--porcelain=v1"]);
  const files = new Map<string, FileStatus>();
  if (!output) return files;

  for (const line of output.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0]; // index status
    const y = line[1]; // worktree status
    const filePath = line.slice(3).trim();

    // Handle rename: "R  old -> new"
    const actualPath = filePath.includes(" -> ")
      ? filePath.split(" -> ").pop()!
      : filePath;

    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      files.set(actualPath, "conflict");
    } else if (x === "?" && y === "?") {
      files.set(actualPath, "untracked");
    } else if (x !== " " && x !== "?" && y !== " ") {
      files.set(actualPath, "staged+unstaged");
    } else if (x !== " " && x !== "?") {
      files.set(actualPath, "staged");
    } else if (y !== " ") {
      files.set(actualPath, "unstaged");
    }
  }

  return files;
}

// Parse unified diff output into hunks.
function parseDiff(diffOutput: string): Hunk[] {
  const hunks: Hunk[] = [];
  if (!diffOutput) return hunks;

  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffOutput.split("\n")) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch) {
      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }
      if (hunks.length >= MAX_HUNKS_PER_FILE) break;
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (!currentHunk) continue;
    if (currentHunk.lines.length >= MAX_HUNK_LINES) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLine });
      oldLine++;
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  if (currentHunk && currentHunk.lines.length > 0 && hunks.length < MAX_HUNKS_PER_FILE) {
    hunks.push(currentHunk);
  }

  return hunks;
}

// Get the diff for a specific file (staged or unstaged).
function getFileDiff(root: string, filePath: string, staged: boolean): string {
  const args = staged
    ? ["diff", "--cached", "-U3", "--", filePath]
    : ["diff", "-U3", "--", filePath];
  return git(root, args);
}

// --- review -----------------------------------------------------------------

// Produce a read-only review of the active worktree's changed files and
// hunks. Never stages, reverts, commits, pushes, or changes repository state.
export function reviewWorktree(root: string): ReviewResult {
  const worktree = detectWorktreeState(root);
  const statusMap = parseStatus(root);
  const files: ChangedFile[] = [];

  const sortedPaths = [...statusMap.keys()].sort();
  const limit = Math.min(sortedPaths.length, MAX_FILES);

  for (let i = 0; i < limit; i++) {
    const filePath = sortedPaths[i];
    const status = statusMap.get(filePath)!;

    let stagedHunks: Hunk[] = [];
    let unstagedHunks: Hunk[] = [];

    if (status === "staged" || status === "staged+unstaged") {
      stagedHunks = parseDiff(getFileDiff(root, filePath, true));
    }
    if (status === "unstaged" || status === "staged+unstaged") {
      unstagedHunks = parseDiff(getFileDiff(root, filePath, false));
    }
    // Conflict and untracked files have no diff hunks in the standard sense.

    files.push({ path: filePath, status, stagedHunks, unstagedHunks });
  }

  return {
    schema: REVIEW_STUDIO_SCHEMA,
    v: REVIEW_STUDIO_VERSION,
    worktree,
    files,
    totalFiles: statusMap.size,
    truncated: statusMap.size > MAX_FILES,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format a review result as a compact, color-independent TUI view.
export function formatReview(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push("Review Studio");
  lines.push("═".repeat(50));

  // Worktree state.
  const wt = result.worktree;
  const headLabel = wt.headState === "detached"
    ? `DETACHED @ ${wt.headSha}`
    : `${wt.branch} @ ${wt.headSha}`;
  lines.push(`Head:    ${headLabel}`);
  if (wt.conflictInProgress) {
    lines.push("⚠ CONFLICT IN PROGRESS");
  }
  lines.push(`Files:   ${result.files.length}${result.truncated ? ` / ${result.totalFiles} (truncated)` : ""}`);

  // Changed files.
  for (const file of result.files) {
    lines.push("");
    const icon = statusIcon(file.status);
    lines.push(`${icon} ${file.path} [${file.status}]`);

    if (file.stagedHunks.length > 0) {
      lines.push(`  Staged (${file.stagedHunks.length} hunks):`);
      for (const hunk of file.stagedHunks.slice(0, 3)) {
        lines.push(`    ${hunk.header}`);
        for (const hl of hunk.lines.slice(0, 5)) {
          const prefix = hl.type === "add" ? "+" : hl.type === "remove" ? "-" : " ";
          lines.push(`    ${prefix} ${hl.content}`);
        }
        if (hunk.lines.length > 5) lines.push(`    … ${hunk.lines.length - 5} more lines`);
      }
      if (file.stagedHunks.length > 3) lines.push(`    … ${file.stagedHunks.length - 3} more hunks`);
    }

    if (file.unstagedHunks.length > 0) {
      lines.push(`  Unstaged (${file.unstagedHunks.length} hunks):`);
      for (const hunk of file.unstagedHunks.slice(0, 3)) {
        lines.push(`    ${hunk.header}`);
        for (const hl of hunk.lines.slice(0, 5)) {
          const prefix = hl.type === "add" ? "+" : hl.type === "remove" ? "-" : " ";
          lines.push(`    ${prefix} ${hl.content}`);
        }
        if (hunk.lines.length > 5) lines.push(`    … ${hunk.lines.length - 5} more lines`);
      }
      if (file.unstagedHunks.length > 3) lines.push(`    … ${file.unstagedHunks.length - 3} more hunks`);
    }

    if (file.status === "untracked") {
      lines.push("  (untracked — no diff available)");
    }
    if (file.status === "conflict") {
      lines.push("  ⚠ CONFLICTED");
    }
  }

  lines.push("");
  lines.push("Read-only: no mutations performed.");

  return lines.join("\n");
}

function statusIcon(status: FileStatus): string {
  switch (status) {
    case "staged": return "●";
    case "unstaged": return "○";
    case "untracked": return "?";
    case "conflict": return "✗";
    case "staged+unstaged": return "◐";
  }
}
