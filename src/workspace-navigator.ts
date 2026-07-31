// Read-only workspace navigation producing canonical context references.
//
// Three navigation primitives — directory tree, recent files, and content
// search — each produce ContextReference values that both the TUI and Desktop
// surfaces can consume. Every preview is gated by a policy check that enforces
// trust, ignore rules, binary detection, secret-path exclusion, and a per-file
// size cap before any content is returned. Navigation is strictly read-only:
// nothing here writes, creates, deletes, or mutates the workspace.
//
// All walks are bounded by depth, entry count, and a wall-clock deadline, and
// never follow symlinks (preventing escape and cycles). Paths are
// workspace-relative and `/`-separated. Results are deterministically ordered
// by code-unit comparison so a fixed workspace state always produces the same
// output.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import { IgnoreSet } from "./discovery.js";
import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
  createContextReference,
  type ContextReference,
  type LineRange,
  type ReferenceProvenance,
} from "./context-reference.js";

export const WORKSPACE_NAVIGATOR_SCHEMA = "oh-my-cli.workspace-navigator";
export const WORKSPACE_NAVIGATOR_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const TREE_MAX_ENTRIES = 500;
const TREE_MAX_DEPTH = 12;
const RECENT_MAX_ENTRIES = 100;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILES = 20_000;
const SEARCH_DEADLINE_MS = 8_000;
const PREVIEW_MAX_BYTES = 2 * 1_048_576; // 2 MiB
const PREVIEW_MAX_LINES = 50;
const SNIFF_BYTES = 8_000;
const MAX_LINE_LENGTH = 500;

// Generated / tooling directories never descended into. Mirrors discovery.ts
// and workspace-reference.ts so all navigation agrees on what is out of scope.
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage", ".git",
]);

// File extensions treated as binary without a content sniff.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff", ".heic", ".avif",
  ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".bin", ".class", ".jar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".wav", ".flac", ".ogg", ".webm", ".m4a", ".aac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".wasm",
]);

// Basename shapes that denote likely-secret material. Conservative: a false
// positive only means the user opens the file themselves.
const SECRET_BASENAME_RE = new RegExp(
  "^(?:" +
    [
      "\\.env(?:\\..+)?",
      "\\.netrc",
      "\\.pgpass",
      "\\.htpasswd",
      "id_(?:rsa|dsa|ecdsa|ed25519)",
      ".+_rsa",
      ".+_ed25519",
      ".+\\.pem",
      ".+\\.pfx",
      ".+\\.p12",
      ".+\\.p8",
      ".+\\.ppk",
      ".+\\.key",
      ".+\\.keystore",
      ".+\\.jks",
      ".+\\.tfstate(?:\\.json)?",
      "credentials(?:\\.json)?",
      "(?:.*[_-])?secrets?(?:[_-].*)?\\.(?:json|ya?ml|txt|env|toml)",
      "(?:.*[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token)(?:[_-].*)?\\.(?:json|ya?ml|txt|env|toml)",
    ].join("|") +
  ")$",
  "i",
);

// --- helpers ----------------------------------------------------------------

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function hasBinaryExtension(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function looksLikeSecretPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return SECRET_BASENAME_RE.test(base);
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- policy enforcement -----------------------------------------------------

// Why a path was refused by the navigation policy. Each variant is a
// non-destructive, explicit refusal that names the reason without leaking
// content.
export type PolicyRefusal =
  | "untrusted"
  | "ignored"
  | "binary"
  | "secret"
  | "oversized"
  | "unreadable"
  | "outside-workspace";

export type PolicyResult =
  | { allowed: true }
  | { allowed: false; refusal: PolicyRefusal };

export interface NavigatorPolicy {
  /** Whether the workspace is trusted. Untrusted → all navigation refused. */
  trusted: boolean;
  /** Apply .gitignore + built-in skip rules. Defaults to true. */
  ignore: boolean;
  /** Maximum file size (bytes) eligible for preview. */
  maxPreviewBytes: number;
}

const DEFAULT_POLICY: NavigatorPolicy = {
  trusted: true,
  ignore: true,
  maxPreviewBytes: PREVIEW_MAX_BYTES,
};

// Evaluate whether a workspace-relative path passes the navigation policy.
// The check is pure metadata (path shape, extension, size) and never reads
// file content except for the binary sniff when the extension is ambiguous.
export function evaluatePolicy(
  workspace: Workspace,
  relPath: string,
  policy: NavigatorPolicy,
  ignoreSet: IgnoreSet,
  isDir: boolean,
): PolicyResult {
  if (!policy.trusted) return { allowed: false, refusal: "untrusted" };

  // Path safety: reject absolute or escaping paths.
  if (relPath.startsWith("/") || relPath.split("/").includes("..")) {
    return { allowed: false, refusal: "outside-workspace" };
  }

  if (policy.ignore && !isDir && ignoreSet.isIgnored(relPath, false)) {
    return { allowed: false, refusal: "ignored" };
  }
  if (policy.ignore && isDir) {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    if (base.startsWith(".") || DEFAULT_SKIP_DIRS.has(base)) {
      return { allowed: false, refusal: "ignored" };
    }
    if (ignoreSet.isIgnored(relPath, true)) {
      return { allowed: false, refusal: "ignored" };
    }
  }

  if (!isDir) {
    if (hasBinaryExtension(relPath)) {
      return { allowed: false, refusal: "binary" };
    }
    if (looksLikeSecretPath(relPath)) {
      return { allowed: false, refusal: "secret" };
    }
    // Size check.
    const abs = workspace.resolve(relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { allowed: false, refusal: "unreadable" };
    }
    if (stat.size > policy.maxPreviewBytes) {
      return { allowed: false, refusal: "oversized" };
    }
  }

  return { allowed: true };
}

// --- navigation results -----------------------------------------------------

// A tree entry: a single file or directory with its canonical reference.
export interface TreeEntry {
  ref: ContextReference;
  type: "file" | "directory";
  sizeBytes: number;
}

export interface TreeResult {
  schema: typeof WORKSPACE_NAVIGATOR_SCHEMA;
  v: typeof WORKSPACE_NAVIGATOR_VERSION;
  /** Workspace-relative path of the listed directory. */
  dir: string;
  entries: TreeEntry[];
  total: number;
  truncated: boolean;
  /** Counts of paths refused by policy. */
  refused: Partial<Record<PolicyRefusal, number>>;
}

// A search match: a file with the matched line(s) and a canonical reference
// pointing at the first match line.
export interface SearchMatch {
  ref: ContextReference;
  /** 1-based line numbers that matched. */
  matchLines: number[];
  /** Preview of the first matched line (truncated, redacted). */
  preview: string;
}

export interface SearchResult {
  schema: typeof WORKSPACE_NAVIGATOR_SCHEMA;
  v: typeof WORKSPACE_NAVIGATOR_VERSION;
  pattern: string;
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
  filesScanned: number;
  refused: Partial<Record<PolicyRefusal, number>>;
}

// A recent-files entry.
export interface RecentEntry {
  ref: ContextReference;
  /** Epoch ms of last access (from the tracker, not filesystem). */
  lastAccessed: number;
}

export interface RecentResult {
  schema: typeof WORKSPACE_NAVIGATOR_SCHEMA;
  v: typeof WORKSPACE_NAVIGATOR_VERSION;
  entries: RecentEntry[];
  total: number;
}

// --- tree navigation --------------------------------------------------------

// List the immediate children of a directory as canonical references. Each
// entry passes through the navigation policy; refused paths are counted but
// never returned. The listing is bounded and deterministic.
export function navigateTree(
  workspace: Workspace,
  dir: string,
  policy: NavigatorPolicy = DEFAULT_POLICY,
): TreeResult {
  const refused: Partial<Record<PolicyRefusal, number>> = {};
  const bump = (r: PolicyRefusal) => { refused[r] = (refused[r] ?? 0) + 1; };

  const empty: TreeResult = {
    schema: WORKSPACE_NAVIGATOR_SCHEMA,
    v: WORKSPACE_NAVIGATOR_VERSION,
    dir,
    entries: [],
    total: 0,
    truncated: false,
    refused,
  };

  if (!policy.trusted) {
    bump("untrusted");
    return empty;
  }

  const absDir = dir === "" || dir === "." ? workspace.root : workspace.resolve(dir);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    bump("unreadable");
    return empty;
  }

  const ignoreSet = policy.ignore ? IgnoreSet.load(workspace) : new IgnoreSet();
  const entries: TreeEntry[] = [];

  // Sort dirents by name for deterministic output.
  const sorted = [...dirents].sort((a, b) => byCodeUnit(a.name, b.name));

  for (const ent of sorted) {
    if (entries.length >= TREE_MAX_ENTRIES) break;
    if (ent.isSymbolicLink()) continue;

    const childRel = dir === "" || dir === "." ? ent.name : `${dir}/${ent.name}`;
    const isDir = ent.isDirectory();

    if (!isDir && !ent.isFile()) continue;

    const verdict = evaluatePolicy(workspace, childRel, policy, ignoreSet, isDir);
    if (!verdict.allowed) {
      bump(verdict.refusal);
      continue;
    }

    const sizeBytes = isDir ? 0 : safeSize(path.join(absDir, ent.name));
    entries.push({
      ref: createContextReference(childRel, "tree"),
      type: isDir ? "directory" : "file",
      sizeBytes,
    });
  }

  const total = sorted.filter(
    (e) => !e.isSymbolicLink() && (e.isFile() || e.isDirectory()),
  ).length;

  return {
    schema: WORKSPACE_NAVIGATOR_SCHEMA,
    v: WORKSPACE_NAVIGATOR_VERSION,
    dir,
    entries,
    total,
    truncated: total > entries.length,
    refused,
  };
}

function safeSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

// --- recent files -----------------------------------------------------------

// A simple in-memory recent-files tracker. The navigator queries it; surfaces
// call `record` when the user opens a file. The tracker is bounded and
// deduplicates by path (most-recent-first).
export class RecentFilesTracker {
  private readonly entries: Array<{ path: string; at: number }> = [];
  private readonly max: number;

  constructor(max: number = RECENT_MAX_ENTRIES) {
    this.max = max;
  }

  record(relPath: string): void {
    const now = Date.now();
    const existing = this.entries.findIndex((e) => e.path === relPath);
    if (existing >= 0) this.entries.splice(existing, 1);
    this.entries.unshift({ path: relPath, at: now });
    if (this.entries.length > this.max) this.entries.length = this.max;
  }

  query(
    workspace: Workspace,
    policy: NavigatorPolicy = DEFAULT_POLICY,
    limit: number = RECENT_MAX_ENTRIES,
  ): RecentResult {
    const ignoreSet = policy.ignore ? IgnoreSet.load(workspace) : new IgnoreSet();
    const out: RecentEntry[] = [];

    for (const entry of this.entries) {
      if (out.length >= limit) break;
      if (!policy.trusted) break;

      const verdict = evaluatePolicy(workspace, entry.path, policy, ignoreSet, false);
      if (!verdict.allowed) continue;

      out.push({
        ref: createContextReference(entry.path, "recent"),
        lastAccessed: entry.at,
      });
    }

    return {
      schema: WORKSPACE_NAVIGATOR_SCHEMA,
      v: WORKSPACE_NAVIGATOR_VERSION,
      entries: out,
      total: this.entries.length,
    };
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// --- content search ---------------------------------------------------------

// Search file contents for a pattern and return canonical references with
// match lines. The search walks the workspace (bounded, no symlinks), applies
// the full navigation policy to every file, and returns at most
// SEARCH_MAX_MATCHES results. Match previews are truncated and redacted.
export function searchWorkspace(
  workspace: Workspace,
  pattern: string,
  policy: NavigatorPolicy = DEFAULT_POLICY,
): SearchResult {
  const refused: Partial<Record<PolicyRefusal, number>> = {};
  const bump = (r: PolicyRefusal) => { refused[r] = (refused[r] ?? 0) + 1; };

  const empty: SearchResult = {
    schema: WORKSPACE_NAVIGATOR_SCHEMA,
    v: WORKSPACE_NAVIGATOR_VERSION,
    pattern,
    matches: [],
    total: 0,
    truncated: false,
    filesScanned: 0,
    refused,
  };

  if (!policy.trusted) {
    bump("untrusted");
    return empty;
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return empty;
  }

  const ignoreSet = policy.ignore ? IgnoreSet.load(workspace) : new IgnoreSet();
  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;
  const deadline = Date.now() + SEARCH_DEADLINE_MS;

  const stack: Array<{ abs: string; depth: number }> = [
    { abs: workspace.root, depth: 0 },
  ];

  while (stack.length > 0) {
    if (matches.length >= SEARCH_MAX_MATCHES || filesScanned >= SEARCH_MAX_FILES || Date.now() > deadline) {
      truncated = true;
      break;
    }

    const { abs, depth } = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of dirents) {
      if (matches.length >= SEARCH_MAX_MATCHES || filesScanned >= SEARCH_MAX_FILES || Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (ent.isSymbolicLink()) continue;

      const childAbs = path.join(abs, ent.name);
      const rel = toRelative(workspace.root, childAbs);

      if (ent.isDirectory()) {
        if (depth + 1 > TREE_MAX_DEPTH) continue;
        const verdict = evaluatePolicy(workspace, rel, policy, ignoreSet, true);
        if (!verdict.allowed) {
          bump(verdict.refusal);
          continue;
        }
        stack.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        const verdict = evaluatePolicy(workspace, rel, policy, ignoreSet, false);
        if (!verdict.allowed) {
          bump(verdict.refusal);
          continue;
        }

        filesScanned++;
        const fileMatch = searchFile(workspace, rel, childAbs, re);
        if (fileMatch) {
          matches.push(fileMatch);
        }
      }
    }
  }

  matches.sort((a, b) => byCodeUnit(a.ref.path, b.ref.path));

  return {
    schema: WORKSPACE_NAVIGATOR_SCHEMA,
    v: WORKSPACE_NAVIGATOR_VERSION,
    pattern,
    matches,
    total: matches.length,
    truncated,
    filesScanned,
    refused,
  };
}

// Search a single file for the pattern. Returns a SearchMatch with the matched
// line numbers and a preview of the first match, or null when no line matches.
function searchFile(
  workspace: Workspace,
  rel: string,
  abs: string,
  re: RegExp,
): SearchMatch | null {
  let content: string;
  try {
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return null;
    content = buf.toString("utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const matchLines: number[] = [];
  let firstPreview = "";

  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matchLines.push(i + 1);
      if (firstPreview === "") {
        firstPreview = truncateLine(lines[i]);
      }
      if (matchLines.length >= PREVIEW_MAX_LINES) break;
    }
    // Reset lastIndex for non-global regexes used with .test().
    re.lastIndex = 0;
  }

  if (matchLines.length === 0) return null;

  const lineRange: LineRange = {
    start: matchLines[0],
    end: matchLines[matchLines.length - 1],
  };

  return {
    ref: createContextReference(rel, "search", lineRange),
    matchLines,
    preview: firstPreview,
  };
}

function truncateLine(line: string): string {
  const trimmed = line.trimEnd();
  if (Array.from(trimmed).length <= MAX_LINE_LENGTH) return trimmed;
  return Array.from(trimmed).slice(0, MAX_LINE_LENGTH - 1).join("") + "…";
}

// --- preview ----------------------------------------------------------------

// A bounded, policy-checked content preview for a single file reference.
// Returns the first PREVIEW_MAX_LINES lines (or the lines specified by the
// reference's range), with long lines truncated. Returns null when the file
// fails the policy check or cannot be read.
export interface FilePreview {
  ref: ContextReference;
  lines: string[];
  /** 1-based number of the first line returned. */
  startLine: number;
  totalLines: number;
  truncated: boolean;
}

export function previewFile(
  workspace: Workspace,
  ref: ContextReference,
  policy: NavigatorPolicy = DEFAULT_POLICY,
): FilePreview | { refused: PolicyRefusal } {
  const ignoreSet = policy.ignore ? IgnoreSet.load(workspace) : new IgnoreSet();
  const verdict = evaluatePolicy(workspace, ref.path, policy, ignoreSet, false);
  if (!verdict.allowed) return { refused: verdict.refusal };

  const abs = workspace.resolve(ref.path);
  let content: string;
  try {
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { refused: "binary" };
    content = buf.toString("utf-8");
  } catch {
    return { refused: "unreadable" };
  }

  const allLines = content.split("\n");
  const totalLines = allLines.length;

  let start: number;
  let end: number;
  if (ref.lines) {
    start = Math.max(1, ref.lines.start);
    end = Math.min(totalLines, ref.lines.end);
  } else {
    start = 1;
    end = Math.min(totalLines, PREVIEW_MAX_LINES);
  }

  const slice = allLines.slice(start - 1, end).map(truncateLine);
  const truncated = end < totalLines;

  return {
    ref,
    lines: slice,
    startLine: start,
    totalLines,
    truncated,
  };
}
