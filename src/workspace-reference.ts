// Workspace reference engine for the composer's `@` picker.
//
// When the composer opens an `@` reference, the shell needs a bounded,
// deterministic, workspace-confined view of which files and directories the
// user may point at. This module supplies the pure logic behind that picker:
// it enumerates candidate paths strictly inside the active workspace (never
// following symlinks, so it cannot escape or cycle), honors the repository's
// ignore rules and a built-in set of generated directories, and excludes
// binary files and likely-secret material so a careless selection cannot pull
// unreadable or sensitive content into a prompt. The candidate universe is
// collected once and fuzzy-filtered in memory per keystroke, so selection
// stays responsive in large repositories. Every collection is bounded by
// depth, entry count, and a wall-clock deadline; oversized workspaces are
// truncated with explicit metadata rather than flooding the composer. Paths
// are workspace-relative and `/`-separated, and references round-trip through
// a stable escaping scheme so spaced or quoted paths survive insertion and
// re-parsing. Nothing here reads file *content* or mutates the filesystem: a
// reference is only a path the user chooses; content is never sent until the
// user submits the prompt.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import { IgnoreSet } from "./discovery.js";

export const WORKSPACE_REFERENCE_SCHEMA = "oh-my-cli.workspace-reference";
export const WORKSPACE_REFERENCE_VERSION = 1;

// Bounds that keep enumeration deterministic and free of composer-flooding
// output. The universe walk is bounded by depth, file count, and a wall-clock
// deadline; the filtered result is capped at a small number of rows the picker
// can render.
const MAX_UNIVERSE_ENTRIES = 5_000;
const MAX_CANDIDATES = 50;
const WALK_MAX_DEPTH = 16;
const WALK_MAX_FILES = 50_000;
const WALK_DEADLINE_MS = 5_000;
// Bytes sniffed when a content-based binary check is requested.
const SNIFF_BYTES = 8_000;
// A reference preview line is bounded so a deep path cannot overflow the band.
const MAX_PREVIEW_LEN = 200;

// Generated / tooling directories never descended into while ignore rules are
// active. Hidden directories (`.git`, `.venv`, …) are skipped separately by a
// prefix check. Entries are never followed (also avoids symlink cycles/escape).
// Mirrors discovery.ts so the picker and the discovery tools agree on what is
// out of scope.
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage", ".git",
]);

// File extensions treated as binary and excluded from references without a
// content sniff. Extension-based exclusion keeps the universe walk to readdir
// plus stat (no per-file open), so it stays responsive in large trees. A NUL
// sniff remains available via looksBinary for callers that need certainty.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff", ".heic", ".avif",
  ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".bin", ".class", ".jar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".wav", ".flac", ".ogg", ".webm", ".m4a", ".aac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".wasm",
]);

// Basename shapes that denote likely-secret material. A match excludes the path
// from references so a selection cannot pull credentials, private keys, or
// token-bearing files into a prompt (criterion 2). Conservative on purpose: a
// false positive only means the user types the path themselves, never that a
// secret leaks.
const SECRET_BASENAME_RE = new RegExp(
  "^(?:" +
    [
      "\\.env(?:\\..+)?", // .env, .env.local, .env.production
      "\\.netrc",
      "\\.pgpass",
      "\\.htpasswd",
      "id_(?:rsa|dsa|ecdsa|ed25519)", // SSH private keys (the .pub form is public)
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

// Deterministic, locale-independent ordering (matches discovery.ts /
// repo-context.ts): UTF-16 code-unit order so results are stable across hosts.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Convert a workspace-absolute path to a stable, `/`-separated workspace-relative
// path. The caller guarantees abs is within the workspace.
function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export type ReferenceType = "file" | "directory";

// A single enumerated path eligible to be referenced. `sizeBytes` is 0 for
// directories and for files whose stat failed (the path is still a valid
// reference target; readability is the consumer's concern at submit time).
export interface ReferenceEntry {
  /** Workspace-relative, `/`-separated path. */
  path: string;
  type: ReferenceType;
  sizeBytes: number;
}

// A scored candidate returned to the picker.
export interface ReferenceCandidate extends ReferenceEntry {
  /** Fuzzy score against the active query (higher is a better match). */
  score: number;
}

// Why the picker has nothing to show. `ok` means candidates are present;
// `no-match` means the query filtered them all out; `empty` means the workspace
// yielded no eligible paths; `untrusted` and `unreadable` are explicit,
// non-destructive refusals (criterion 4).
export type ReferenceState =
  | "ok"
  | "no-match"
  | "empty"
  | "untrusted"
  | "unreadable";

// Counts of paths dropped during enumeration, surfaced so the picker can name
// what it excluded rather than silently hiding it.
export interface ReferenceExclusions {
  binary: number;
  secret: number;
  ignored: number;
}

// The bounded set of eligible paths collected from a workspace. Collected once
// per picker open and re-filtered per keystroke.
export interface ReferenceUniverse {
  schema: typeof WORKSPACE_REFERENCE_SCHEMA;
  v: typeof WORKSPACE_REFERENCE_VERSION;
  entries: ReferenceEntry[];
  /** Total eligible paths seen before the universe cap. */
  total: number;
  /** True when more eligible paths existed than the universe cap retained. */
  truncated: boolean;
  filesScanned: number;
  excluded: ReferenceExclusions;
  state: ReferenceState;
}

// The filtered, scored view the picker renders for the current query.
export interface ReferenceFilter {
  query: string;
  candidates: ReferenceCandidate[];
  /** Total matches before the candidate cap. */
  total: number;
  /** True when matches exceeded the candidate cap. */
  truncated: boolean;
  state: ReferenceState;
}

export interface CollectOptions {
  /**
   * Whether the workspace is trusted. When false, enumeration is refused with
   * an explicit `untrusted` state and the filesystem is never walked
   * (non-destructive, criterion 4). Defaults to true so pure callers and tests
   * that already confine the workspace need not opt in.
   */
  trusted?: boolean;
  /** Apply .gitignore + built-in skip rules. Defaults to true. */
  ignore?: boolean;
}

// --- binary + secret detection ----------------------------------------------

// A NUL byte in the sniffed prefix is the standard, deterministic binary signal.
// Available for callers that want a content-based check beyond the extension
// table; the default universe walk uses the faster extension heuristic.
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Whether a workspace-relative path's basename looks like secret material.
export function looksLikeSecretPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return SECRET_BASENAME_RE.test(base);
}

function hasBinaryExtension(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// --- reference query parsing ------------------------------------------------

// The active `@` reference at the end of the composer text, or null when the
// caret is not inside a reference. A reference begins with `@` at the start of
// input or after whitespace (so `email@host` never triggers a picker) and runs
// to the next whitespace or `@`. Because this slice keeps the caret at
// end-of-input, only the trailing token is "active"; a reference already closed
// by a space is left as ordinary text.
export function referenceQuery(text: string): { query: string; start: number } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (!match) return null;
  const query = match[1];
  return { query, start: text.length - query.length - 1 };
}

// --- escaping (round-trip) --------------------------------------------------

// A path that needs no quoting: only unreserved characters, no whitespace, no
// quotes/backticks/backslashes. Such paths insert verbatim after the `@`.
const BARE_REFERENCE_RE = /^[A-Za-z0-9._/@+-]+$/;

// Escape a workspace-relative path into a stable reference token. Bare paths
// insert verbatim; anything with whitespace or quoting-sensitive characters is
// wrapped in double quotes with `"` and `\` escaped, so the token is a single
// unit that parseReferenceToken inverts exactly.
export function escapeReference(relPath: string): string {
  if (relPath.length > 0 && BARE_REFERENCE_RE.test(relPath)) return relPath;
  const escaped = relPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Invert escapeReference: recover the workspace-relative path from a reference
// token. A leading `"` selects the quoted form (unescaping `"` and `\`);
// otherwise the token is the path verbatim.
export function parseReferenceToken(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    const inner = token.slice(1, -1);
    return inner.replace(/\\(["\\])/g, "$1");
  }
  return token;
}

// Extract every reference token from a span of composer text. A token is an `@`
// at start or after whitespace followed by either a double-quoted string or a
// run of non-whitespace, non-`@` characters. Used to deduplicate references.
function referenceTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = /(?:^|\s)@("(?:[^"\\]|\\.)*"|[^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tokens.push(m[1]);
  return tokens;
}

// Collapse duplicate references in composer text deterministically: the first
// occurrence of each path (by parsed value) is kept and later occurrences of
// the same path are removed along with their leading `@`. Surrounding text and
// the first reference's exact escaping are preserved (criterion 3).
export function dedupeReferences(text: string): string {
  const seen = new Set<string>();
  const re = /((?:^|\s)@)("(?:[^"\\]|\\.)*"|[^\s@]+)/g;
  return text.replace(re, (whole, prefix: string, token: string) => {
    const value = parseReferenceToken(token);
    if (seen.has(value)) return ""; // drop the duplicate reference entirely
    seen.add(value);
    return whole;
  });
}

// The set of paths already referenced in composer text, by parsed value. The
// driver uses this so completing a selection that is already present is a
// no-op instead of inserting a duplicate.
export function existingReferencePaths(text: string): Set<string> {
  return new Set(referenceTokens(text).map(parseReferenceToken));
}

// --- fuzzy scoring ----------------------------------------------------------

// Score a query against a target path as a case-insensitive subsequence, with
// bonuses for contiguous runs and matches at segment boundaries (after `/`,
// `-`, `_`, `.`, or at the start). Returns null when the query is not a
// subsequence of the target, so non-matches drop out. An empty query matches
// everything with a neutral score so an unfiltered picker still lists paths.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === prev + 1) score += 3; // contiguity
      if (ti === 0 || "/-_. ".includes(t[ti - 1])) score += 2; // boundary
      prev = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  // Prefer shorter, earlier-matching paths so deep nesting ranks below a direct
  // hit. The penalty is small relative to the match bonuses.
  score -= Math.floor(t.length / 16);
  return score;
}

// --- universe collection ----------------------------------------------------

interface WalkContext {
  root: string;
  ignore: boolean;
  ignoreSet: IgnoreSet;
  deadline: number;
  filesScanned: number;
  budgetExceeded: boolean;
  entries: ReferenceEntry[];
  excluded: ReferenceExclusions;
}

function safeSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

// Bounded, symlink-safe DFS that fills the universe with eligible files and
// directories. Honors ignore rules, depth/file-count bounds, and a wall-clock
// deadline; binary and secret files are excluded with counts.
function walkUniverse(ctx: WalkContext, startAbs: string, startDepth: number): void {
  const stack: Array<{ abs: string; depth: number }> = [{ abs: startAbs, depth: startDepth }];
  while (stack.length > 0) {
    if (ctx.entries.length >= MAX_UNIVERSE_ENTRIES || ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
      ctx.budgetExceeded = true;
      return;
    }
    const { abs, depth } = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abort
    }
    for (const ent of dirents) {
      if (ctx.entries.length >= MAX_UNIVERSE_ENTRIES || ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
        ctx.budgetExceeded = true;
        break;
      }
      // Never follow symlinks: confines the walk to the workspace and avoids
      // cycles/escape. Symlinks themselves are not reference targets here.
      if (ent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, ent.name);
      const rel = toRelative(ctx.root, childAbs);
      if (ent.isDirectory()) {
        if (ctx.ignore && (ent.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(ent.name))) {
          continue;
        }
        if (ctx.ignore && ctx.ignoreSet.isIgnored(rel, true)) {
          ctx.excluded.ignored++;
          continue;
        }
        if (depth + 1 > WALK_MAX_DEPTH) {
          ctx.budgetExceeded = true;
          continue;
        }
        ctx.entries.push({ path: rel, type: "directory", sizeBytes: 0 });
        stack.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (ctx.ignore && ctx.ignoreSet.isIgnored(rel, false)) {
          ctx.excluded.ignored++;
          continue;
        }
        if (hasBinaryExtension(rel)) {
          ctx.excluded.binary++;
          continue;
        }
        if (looksLikeSecretPath(rel)) {
          ctx.excluded.secret++;
          continue;
        }
        ctx.filesScanned++;
        ctx.entries.push({ path: rel, type: "file", sizeBytes: safeSize(childAbs) });
      }
      // Special files (fifo, socket, device) are intentionally never referenced.
    }
  }
}

// Enumerate the eligible reference paths within a workspace. The walk is
// bounded, never follows symlinks, and stays confined to the workspace root;
// binary, secret, and ignored paths are excluded with counts. When `trusted`
// is false the filesystem is never touched and the result is an explicit
// `untrusted` refusal.
export function collectWorkspaceReferences(
  workspace: Workspace,
  opts: CollectOptions = {},
): ReferenceUniverse {
  const trusted = opts.trusted ?? true;
  const ignore = opts.ignore ?? true;
  const empty = (state: ReferenceState): ReferenceUniverse => ({
    schema: WORKSPACE_REFERENCE_SCHEMA,
    v: WORKSPACE_REFERENCE_VERSION,
    entries: [],
    total: 0,
    truncated: false,
    filesScanned: 0,
    excluded: { binary: 0, secret: 0, ignored: 0 },
    state,
  });

  if (!trusted) return empty("untrusted");

  // Confirm the workspace root is a readable directory; a missing or
  // permission-denied root is an explicit, non-destructive refusal.
  let rootStat: fs.Stats | null = null;
  try {
    rootStat = fs.statSync(workspace.root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) return empty("unreadable");

  const ctx: WalkContext = {
    root: workspace.root,
    ignore,
    ignoreSet: ignore ? IgnoreSet.load(workspace) : new IgnoreSet(),
    deadline: Date.now() + WALK_DEADLINE_MS,
    filesScanned: 0,
    budgetExceeded: false,
    entries: [],
    excluded: { binary: 0, secret: 0, ignored: 0 },
  };
  walkUniverse(ctx, workspace.root, 0);

  // Deterministic order before capping so truncation keeps a stable prefix.
  ctx.entries.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.type, b.type));
  const total = ctx.entries.length;
  const truncated = ctx.budgetExceeded || total > MAX_UNIVERSE_ENTRIES;
  const entries = ctx.entries.slice(0, MAX_UNIVERSE_ENTRIES);

  return {
    schema: WORKSPACE_REFERENCE_SCHEMA,
    v: WORKSPACE_REFERENCE_VERSION,
    entries,
    total,
    truncated,
    filesScanned: ctx.filesScanned,
    excluded: ctx.excluded,
    state: entries.length === 0 ? "empty" : "ok",
  };
}

// Fuzzy-filter a collected universe by a query, scoring and sorting matches and
// capping the result for the picker. The universe's refusal states
// (untrusted/unreadable/empty) pass through unchanged so the picker shows the
// right reason instead of a bare "no matches".
export function filterReferences(
  universe: ReferenceUniverse,
  query: string,
  limit: number = MAX_CANDIDATES,
): ReferenceFilter {
  if (universe.state !== "ok") {
    return { query, candidates: [], total: 0, truncated: false, state: universe.state };
  }
  const scored: ReferenceCandidate[] = [];
  for (const entry of universe.entries) {
    const score = fuzzyScore(query, entry.path);
    if (score === null) continue;
    scored.push({ ...entry, score });
  }
  // Best score first; ties broken by path for determinism.
  scored.sort((a, b) => b.score - a.score || byCodeUnit(a.path, b.path));
  const total = scored.length;
  const candidates = scored.slice(0, Math.max(0, limit));
  return {
    query,
    candidates,
    total,
    truncated: total > candidates.length,
    state: total === 0 ? "no-match" : "ok",
  };
}

// Convenience: collect and filter in one call. The driver instead collects the
// universe once and filters per keystroke for responsiveness; this is for tests
// and simple callers.
export function collectReferenceCandidates(
  workspace: Workspace,
  query: string,
  opts: CollectOptions & { limit?: number } = {},
): ReferenceFilter {
  const universe = collectWorkspaceReferences(workspace, opts);
  return filterReferences(universe, query, opts.limit ?? MAX_CANDIDATES);
}

// --- formatting -------------------------------------------------------------

// Human-readable byte size for the preview, using binary units. Directories and
// zero-size files render as a dash so the column stays compact.
export function formatReferenceSize(type: ReferenceType, sizeBytes: number): string {
  if (type === "directory") return "dir";
  if (sizeBytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${units[unit]}`;
}

// A compact, color-independent preview of one candidate: a type glyph + ASCII
// label, the path, and the size, clipped to width. The glyph + label keep the
// type identifiable without color (matching the shell's accessibility rule).
export function formatReferencePreview(
  candidate: ReferenceCandidate,
  width: number = MAX_PREVIEW_LEN,
): string {
  const typeLabel = candidate.type === "directory" ? "dir" : "file";
  const glyph = candidate.type === "directory" ? "▸" : "·";
  const size = formatReferenceSize(candidate.type, candidate.sizeBytes);
  const line = `${glyph} ${typeLabel}  ${candidate.path}  ${size}`;
  if (Array.from(line).length <= width) return line;
  return Array.from(line).slice(0, Math.max(0, width - 1)).join("") + "…";
}
