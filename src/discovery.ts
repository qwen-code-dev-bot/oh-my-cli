// Bounded, read-only repository discovery: list, glob, and grep.
//
// Repository exploration should not require approval-gated shell commands. This
// module provides three read-only primitives — directory listing, path globbing,
// and content search — that operate strictly inside a canonical workspace. It
// never writes, executes, follows symlinks, or leaves the workspace: every base
// path is confined with Workspace.resolveSafe (which rejects `..` traversal and
// symlink escape), the walk never follows symbolic links (so it cannot escape or
// cycle), and only regular files and directories are reported (special files are
// skipped). Repository ignore rules (root .gitignore plus a built-in set of
// generated directories) and explicit include/exclude options are applied
// consistently. Every collection is bounded by depth, file count, match count,
// per-file size, and a wall-clock deadline, and oversized inputs are skipped or
// truncated with explicit metadata rather than silently flooding context. Output
// paths are workspace-relative and every collection is sorted by a stable,
// locale-independent code-unit comparator, so results are deterministic for a
// fixed workspace state. No subprocess is ever spawned, so cancellation and time
// limits cannot leave background processes behind.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";

export const DISCOVERY_SCHEMA = "oh-my-cli.discovery";
export const DISCOVERY_VERSION = 1;

// Bounds that keep discovery deterministic and free of context-flooding output.
const MAX_LIST_ENTRIES = 1_000;
const MAX_GLOB_MATCHES = 2_000;
const MAX_GREP_MATCHES = 1_000;
const WALK_MAX_DEPTH = 16;
const WALK_MAX_FILES = 50_000;
const WALK_DEADLINE_MS = 10_000;
const MAX_GREP_FILE_BYTES = 2 * 1_048_576; // 2 MiB per file
const MAX_LINE_LENGTH = 1_000; // grep lines beyond this are truncated
const SNIFF_BYTES = 8_000; // bytes inspected for binary detection

// Generated / tooling directories never descended into while ignore rules are
// active. Hidden directories (`.git`, `.venv`, …) are skipped separately by a
// prefix check. Entries are never followed (also avoids symlink cycles/escape).
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage", ".git",
]);

// Deterministic, locale-independent ordering (matches repo-context.ts).
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Convert a workspace-absolute path to a stable, `/`-separated workspace-relative
// path. The caller guarantees abs is within the workspace.
function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

// --- glob matching ----------------------------------------------------------

// Translate a glob pattern into a regex source string. Supports `*` (any run of
// non-separator characters), `**` (any characters including separators), `?`
// (one non-separator), and `[...]` character classes. Regex metacharacters are
// escaped so the pattern is matched literally otherwise.
function globToRegexSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (glob[i] === "/") i++; // `**/` collapses the separator
        continue;
      }
      out += "[^/]*";
      i++;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (glob[j] === "!" || glob[j] === "^") {
        cls += "^";
        j++;
      }
      while (j < glob.length && glob[j] !== "]") {
        const ch = glob[j];
        if (ch === "\\") cls += "\\\\";
        else if (ch === "^" || ch === "-") cls += "\\" + ch;
        else cls += ch;
        j++;
      }
      if (j >= glob.length) {
        out += "\\["; // unmatched `[` is a literal
        i++;
      } else {
        out += cls + "]";
        i = j + 1;
      }
    } else if ("\\^$.|+(){}".includes(c)) {
      out += "\\" + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Compile a glob into an anchored, full-match regex against a `/`-separated path.
export function compileGlob(pattern: string): RegExp {
  return new RegExp("^" + globToRegexSource(pattern) + "$");
}

// --- ignore rules -----------------------------------------------------------

interface IgnoreRule {
  regex: RegExp;
  basename: boolean; // match the final path segment only
  dirOnly: boolean;
  negated: boolean;
}

// A gitignore-style matcher anchored at the workspace root. Only the root
// `.gitignore` is consulted (the high-value, common case); rules are applied in
// order with later rules overriding earlier ones and `!` re-including a path.
export class IgnoreSet {
  private readonly rules: IgnoreRule[] = [];

  static load(workspace: Workspace): IgnoreSet {
    const set = new IgnoreSet();
    try {
      const content = fs.readFileSync(path.join(workspace.root, ".gitignore"), "utf-8");
      for (const raw of content.split(/\r?\n/)) set.addPattern(raw);
    } catch {
      // No .gitignore is fine: only the built-in defaults apply.
    }
    return set;
  }

  addPattern(raw: string): void {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#")) return;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    // A leading slash anchors to the root; a slash anywhere else also anchors.
    // A pattern with no slash matches the final path segment at any depth.
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    const basename = !anchored && !pattern.includes("/");
    if (pattern === "") return;
    this.rules.push({
      regex: new RegExp("^" + globToRegexSource(pattern) + "$"),
      basename,
      dirOnly,
      negated,
    });
  }

  isIgnored(relPath: string, isDir: boolean): boolean {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const matched = rule.basename ? rule.regex.test(base) : rule.regex.test(relPath);
      if (matched) ignored = !rule.negated;
    }
    return ignored;
  }
}

// --- binary detection -------------------------------------------------------

// A NUL byte in the sniffed prefix is the standard, deterministic binary signal.
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- confined, bounded walk -------------------------------------------------

interface WalkContext {
  root: string;
  ignore: boolean;
  ignoreSet: IgnoreSet;
  deadline: number;
  filesScanned: number;
  budgetExceeded: boolean;
}

function shouldSkipDir(ctx: WalkContext, name: string, relDir: string): boolean {
  if (!ctx.ignore) return false;
  if (name.startsWith(".")) return true;
  if (DEFAULT_SKIP_DIRS.has(name)) return true;
  return ctx.ignoreSet.isIgnored(relDir, true);
}

// Resolve and confine a workspace-relative base path. Throws on traversal or
// symlink escape (Workspace.resolveSafe) so callers never operate outside root.
function confineBase(workspace: Workspace, baseRel: string): string {
  const rel = baseRel === "" ? "." : baseRel;
  return workspace.resolveSafe(rel);
}

// --- list -------------------------------------------------------------------

export type EntryType = "file" | "directory" | "symlink" | "other";

export interface ListEntry {
  path: string; // workspace-relative
  type: EntryType;
}

export interface ListResult {
  base: string; // workspace-relative
  entries: ListEntry[];
  totalEntries: number;
  truncated: boolean;
}

function entryType(ent: fs.Dirent): EntryType {
  if (ent.isSymbolicLink()) return "symlink";
  if (ent.isDirectory()) return "directory";
  if (ent.isFile()) return "file";
  return "other";
}

// List the immediate entries of a single directory (non-recursive). Hidden
// entries are reported honestly; ignore rules (when active) omit generated and
// gitignored entries. Symlinks are reported but never followed.
export function listDirectory(
  workspace: Workspace,
  opts: { path?: string; ignore?: boolean } = {},
): ListResult {
  const base = confineBase(workspace, opts.path ?? ".");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    throw new Error(`list: not a directory: ${opts.path ?? "."}`);
  }
  const ignore = opts.ignore ?? true;
  const ignoreSet = ignore ? IgnoreSet.load(workspace) : new IgnoreSet();

  const mapped: ListEntry[] = [];
  for (const ent of entries) {
    const type = entryType(ent);
    const rel = toRelative(workspace.root, path.join(base, ent.name));
    if (ignore) {
      const isDir = type === "directory";
      if (isDir && (ent.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(ent.name))) continue;
      if (ignoreSet.isIgnored(rel, isDir)) continue;
    }
    mapped.push({ path: rel, type });
  }
  mapped.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.type, b.type));

  const totalEntries = mapped.length;
  const truncated = totalEntries > MAX_LIST_ENTRIES;
  return {
    base: toRelative(workspace.root, base) || ".",
    entries: mapped.slice(0, MAX_LIST_ENTRIES),
    totalEntries,
    truncated,
  };
}

// --- glob -------------------------------------------------------------------

export interface GlobResult {
  pattern: string;
  base: string;
  matches: string[]; // workspace-relative paths
  totalMatches: number;
  filesScanned: number;
  truncated: boolean;
  budgetExceeded: boolean;
}

// Match workspace-relative paths against a glob pattern. The walk is bounded and
// never follows symlinks; both files and directories may match.
export function globPaths(
  workspace: Workspace,
  opts: { pattern: string; path?: string; ignore?: boolean },
): GlobResult {
  if (typeof opts.pattern !== "string" || opts.pattern === "") {
    throw new Error("glob: pattern is required");
  }
  const base = confineBase(workspace, opts.path ?? ".");
  const matcher = compileGlob(opts.pattern);
  const ignore = opts.ignore ?? true;
  const ctx: WalkContext = {
    root: workspace.root,
    ignore,
    ignoreSet: ignore ? IgnoreSet.load(workspace) : new IgnoreSet(),
    deadline: Date.now() + WALK_DEADLINE_MS,
    filesScanned: 0,
    budgetExceeded: false,
  };

  const matches: string[] = [];
  let truncated = false;

  walk(ctx, base, 0, (relPath, isDir) => {
    if (matches.length >= MAX_GLOB_MATCHES) {
      truncated = true;
      return;
    }
    if (matcher.test(relPath)) {
      matches.push(relPath);
      if (matches.length >= MAX_GLOB_MATCHES) truncated = true;
    }
  });

  matches.sort(byCodeUnit);
  return {
    pattern: opts.pattern,
    base: toRelative(workspace.root, base) || ".",
    matches,
    totalMatches: matches.length,
    filesScanned: ctx.filesScanned,
    truncated: truncated || ctx.budgetExceeded,
    budgetExceeded: ctx.budgetExceeded,
  };
}

// --- grep -------------------------------------------------------------------

export interface GrepMatch {
  path: string; // workspace-relative
  lineNumber: number; // 1-based
  line: string; // possibly truncated
  truncatedLine: boolean;
}

export interface GrepResult {
  pattern: string;
  base: string;
  matches: GrepMatch[];
  totalMatches: number;
  filesScanned: number;
  filesSkippedBinary: number;
  filesSkippedLarge: number;
  truncated: boolean;
  budgetExceeded: boolean;
}

// Search file contents for a regular expression. Binary and oversized files are
// skipped with explicit counts; long lines are truncated; the search stops at the
// match cap or deadline with a truncation flag.
export function grepContent(
  workspace: Workspace,
  opts: { pattern: string; path?: string; include?: string; ignore?: boolean },
): GrepResult {
  if (typeof opts.pattern !== "string" || opts.pattern === "") {
    throw new Error("grep: pattern is required");
  }
  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern);
  } catch (err) {
    throw new Error(`grep: invalid regex: ${(err as Error).message}`);
  }
  const include = opts.include !== undefined ? compileGlob(opts.include) : undefined;
  const base = confineBase(workspace, opts.path ?? ".");
  const ignore = opts.ignore ?? true;
  const ctx: WalkContext = {
    root: workspace.root,
    ignore,
    ignoreSet: ignore ? IgnoreSet.load(workspace) : new IgnoreSet(),
    deadline: Date.now() + WALK_DEADLINE_MS,
    filesScanned: 0,
    budgetExceeded: false,
  };

  const matches: GrepMatch[] = [];
  let filesSkippedBinary = 0;
  let filesSkippedLarge = 0;
  let truncated = false;

  // A single file may also be passed as the base; handle it without a walk.
  const baseStat = safeStat(base);
  if (baseStat?.isFile()) {
    scanFile(workspace, base, regex, matches, () => filesSkippedBinary++, () => filesSkippedLarge++);
  } else {
    walk(ctx, base, 0, (relPath, isDir, absPath) => {
      if (isDir) return;
      if (matches.length >= MAX_GREP_MATCHES) {
        truncated = true;
        return;
      }
      if (include && !include.test(relPath)) return;
      const counters = {
        binary: () => filesSkippedBinary++,
        large: () => filesSkippedLarge++,
      };
      scanFile(workspace, absPath, regex, matches, counters.binary, counters.large);
      if (matches.length >= MAX_GREP_MATCHES) truncated = true;
    });
  }

  matches.sort((a, b) => byCodeUnit(a.path, b.path) || a.lineNumber - b.lineNumber);
  return {
    pattern: opts.pattern,
    base: toRelative(workspace.root, base) || ".",
    matches,
    totalMatches: matches.length,
    filesScanned: ctx.filesScanned,
    filesSkippedBinary,
    filesSkippedLarge,
    truncated: truncated || ctx.budgetExceeded,
    budgetExceeded: ctx.budgetExceeded,
  };
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function scanFile(
  workspace: Workspace,
  absPath: string,
  regex: RegExp,
  matches: GrepMatch[],
  onBinary: () => void,
  onLarge: () => void,
): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, "r");
    const size = fs.fstatSync(fd).size;
    if (size > MAX_GREP_FILE_BYTES) {
      onLarge();
      return;
    }
    const buf = Buffer.alloc(Math.min(size, MAX_GREP_FILE_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (looksBinary(buf)) {
      onBinary();
      return;
    }
    const rel = toRelative(workspace.root, absPath);
    const text = buf.toString("utf-8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) return;
      const line = lines[i];
      if (regex.test(line)) {
        const truncatedLine = line.length > MAX_LINE_LENGTH;
        matches.push({
          path: rel,
          lineNumber: i + 1,
          line: truncatedLine ? line.slice(0, MAX_LINE_LENGTH) : line,
          truncatedLine,
        });
      }
    }
  } catch {
    // Unreadable or vanished mid-walk: skip silently rather than abort discovery.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Bounded, symlink-safe DFS. The visitor receives the workspace-relative path,
// whether it is a directory, and the confined absolute path. Honors ignore
// rules, depth/file-count bounds, and a wall-clock deadline.
function walk(
  ctx: WalkContext,
  startAbs: string,
  startDepth: number,
  visit: (relPath: string, isDir: boolean, absPath: string) => void,
): void {
  const stack: Array<{ abs: string; depth: number }> = [{ abs: startAbs, depth: startDepth }];
  while (stack.length > 0) {
    if (ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
      ctx.budgetExceeded = true;
      return;
    }
    const { abs, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // Re-check the budget per entry so a single flat directory cannot exhaust
      // the time/file budget before the next loop iteration.
      if (ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
        ctx.budgetExceeded = true;
        break;
      }
      const childAbs = path.join(abs, ent.name);
      const rel = toRelative(ctx.root, childAbs);
      // Never follow symlinks: confines the walk and avoids cycles/escape.
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ctx, ent.name, rel)) continue;
        if (depth + 1 > WALK_MAX_DEPTH) {
          ctx.budgetExceeded = true;
          continue;
        }
        visit(rel, true, childAbs);
        stack.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (ctx.ignore && ctx.ignoreSet.isIgnored(rel, false)) continue;
        ctx.filesScanned++;
        visit(rel, false, childAbs);
      }
      // Special files (fifo, socket, device) are intentionally never reported.
    }
  }
}

// --- formatting (model-facing tool output) ----------------------------------

export function formatListResult(result: ListResult): string {
  if (result.entries.length === 0) {
    return `(empty directory: ${result.base})`;
  }
  const lines = result.entries.map((e) => `${e.type === "directory" ? "d" : e.type === "symlink" ? "l" : "-"} ${e.path}`);
  if (result.truncated) {
    lines.push(`… truncated: showing ${MAX_LIST_ENTRIES} of ${result.totalEntries} entries`);
  }
  return lines.join("\n");
}

export function formatGlobResult(result: GlobResult): string {
  if (result.matches.length === 0) {
    return `(no matches for ${result.pattern})`;
  }
  const lines = [...result.matches];
  if (result.truncated) {
    lines.push(`… truncated: ${result.totalMatches}+ matches (bounds reached)`);
  }
  return lines.join("\n");
}

export function formatGrepResult(result: GrepResult): string {
  const lines: string[] = [];
  for (const m of result.matches) {
    lines.push(`${m.path}:${m.lineNumber}: ${m.line}${m.truncatedLine ? " …" : ""}`);
  }
  const meta: string[] = [];
  if (result.filesSkippedBinary > 0) meta.push(`${result.filesSkippedBinary} binary skipped`);
  if (result.filesSkippedLarge > 0) meta.push(`${result.filesSkippedLarge} oversized skipped`);
  if (result.truncated) meta.push("results truncated at bounds");
  if (result.matches.length === 0) {
    lines.push(`(no matches for ${result.pattern})`);
  }
  if (meta.length > 0) lines.push(`[${meta.join("; ")}]`);
  return lines.join("\n");
}
