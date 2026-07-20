// Bounded, ranked repository map for automatic model context.
//
// A fresh session used to begin with no automatic view of the workspace: to use
// existing code the model had to be told which files to read (explicit `@`
// references, #196) or guess paths and call read/glob/grep. On a fresh or large
// workspace it started blind, under-using existing modules and proposing edits
// that ignored existing abstractions. This module produces a concise, bounded,
// ranked map of the workspace's key files and their top-level symbols (the
// declarations a model needs to reuse existing APIs), inspired by Aider's
// token-budgeted repository map. It complements — does not replace — the manual
// `@` picker and the read/glob/grep tools.
//
// Trust and containment mirror workspace-reference.ts (#196): the walk never
// follows symlinks (so it cannot escape or cycle), stays confined to the
// workspace root, honors .gitignore plus a built-in skip set, and excludes
// binary and likely-secret paths. Only declaration *signatures* are surfaced —
// never file bodies — and every signature is secret-redacted and length-capped.
// Collection is bounded by depth, file count, and a wall-clock deadline, and the
// rendered map is bounded by a configurable token/char budget so a large
// repository cannot flood context. Ordering is deterministic (UTF-16 code-unit)
// for a fixed workspace state. The ranking and budgeting core (buildRepoMap) is
// pure: it operates on in-memory file inputs so symbol extraction, ranking, and
// budget truncation are unit-testable without a filesystem.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import { IgnoreSet } from "./discovery.js";
import { looksBinary, looksLikeSecretPath } from "./workspace-reference.js";
import { redactSecrets } from "./permission-impact.js";

export const REPO_MAP_SCHEMA = "oh-my-cli.repo-map";
export const REPO_MAP_VERSION = 1;

// Bounds that keep map construction deterministic and free of context-flooding
// output. The walk mirrors workspace-reference.ts; the per-file read and symbol
// caps keep extraction cheap; the budget bounds the rendered map.
const WALK_MAX_DEPTH = 16;
const WALK_MAX_FILES = 50_000;
const WALK_DEADLINE_MS = 5_000;
const MAX_CANDIDATE_FILES = 2_000; // symbol-bearing files retained before ranking
const MAX_SYMBOLS_PER_FILE = 40; // extraction cap (bounds work + scoring signal)
// Render cap: a concise map favors breadth (many files, their key symbols) over
// depth (one file, all symbols). The budget therefore spreads across files; the
// first N top-level declarations of each file are the ones surfaced.
const MAX_RENDERED_SYMBOLS_PER_FILE = 10;
const MAX_FILE_READ_BYTES = 16 * 1024; // per-file prefix read for symbol extraction
const MAX_SIGNATURE_LEN = 160;

// The map budget is expressed in tokens (Aider's framing) and approximated in
// characters so no tokenizer/provider call is needed for construction.
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_MAP_TOKENS = 1_024;
export const DEFAULT_MAP_BUDGET_CHARS = DEFAULT_MAP_TOKENS * CHARS_PER_TOKEN;

// Generated / tooling directories never descended into while ignore rules are
// active. Hidden directories (`.git`, `.venv`, …) are skipped separately by a
// prefix check. Mirrors discovery.ts / workspace-reference.ts so the map agrees
// with the other read-only primitives on what is out of scope.
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage", ".git",
]);

// Deterministic, locale-independent ordering (matches discovery.ts /
// repo-context.ts / workspace-reference.ts).
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Convert a workspace-absolute path to a stable, `/`-separated relative path.
function toRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

// Convert a token budget to a character budget (bounded, never below zero).
export function tokensToBudgetChars(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return DEFAULT_MAP_BUDGET_CHARS;
  return Math.max(1, Math.floor(tokens)) * CHARS_PER_TOKEN;
}

// --- language detection -----------------------------------------------------

// Recognized source languages and the extensions that map to them. Files whose
// extension is not a recognized code language yield no symbols and never enter
// the map, which keeps prose, data, and config out of a symbol map.
type Language = "ts" | "js" | "py" | "rs" | "go" | "java" | "clike";

const EXT_LANGUAGE: Record<string, Language> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".rs": "rs",
  ".go": "go",
  ".java": "java",
  // Conservative declaration-only extraction for other curly-brace languages.
  ".c": "clike", ".h": "clike",
  ".cpp": "clike", ".cc": "clike", ".cxx": "clike", ".hpp": "clike", ".hh": "clike",
  ".cs": "clike",
  ".swift": "clike",
  ".kt": "clike", ".kts": "clike",
  ".scala": "clike", ".sc": "clike",
  ".php": "clike",
  ".rb": "clike",
  ".dart": "clike",
};

export function languageForPath(relPath: string): Language | null {
  const ext = path.extname(relPath).toLowerCase();
  return EXT_LANGUAGE[ext] ?? null;
}

// --- symbol extraction (pure) -----------------------------------------------

export interface MapSymbol {
  /** The declared identifier. */
  name: string;
  /** Declaration kind (function, class, interface, …). */
  kind: string;
  /** The redacted, length-capped declaration signature (no body). */
  signature: string;
  /** 1-based line number of the declaration. */
  line: number;
}

interface Pattern {
  kind: string;
  re: RegExp; // group 1 is the identifier
}

// Top-level declarations start at column 0; nested declarations are indented and
// are intentionally not mapped. Each pattern set is applied line-by-line.
const TS_PATTERNS: Pattern[] = [
  { kind: "function", re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: "enum", re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "const", re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];

const JS_PATTERNS: Pattern[] = [
  { kind: "function", re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "const", re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
];

const PY_PATTERNS: Pattern[] = [
  { kind: "class", re: /^class\s+([A-Za-z_]\w*)/ },
  { kind: "function", re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
];

const RS_PATTERNS: Pattern[] = [
  { kind: "function", re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: "struct", re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
  { kind: "trait", re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
  { kind: "impl", re: /^impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/ },
];

const GO_PATTERNS: Pattern[] = [
  { kind: "function", re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/ },
  { kind: "type", re: /^type\s+([A-Za-z_]\w*)/ },
];

const JAVA_PATTERNS: Pattern[] = [
  { kind: "class", re: /^(?:public\s+|final\s+|abstract\s+|sealed\s+)*class\s+([A-Za-z_]\w*)/ },
  { kind: "interface", re: /^(?:public\s+)*interface\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^(?:public\s+)*enum\s+([A-Za-z_]\w*)/ },
  { kind: "record", re: /^(?:public\s+)*record\s+([A-Za-z_]\w*)/ },
];

// Other curly-brace languages: declaration shapes only (class/interface/struct/
// enum/trait/protocol). Free-function matching is skipped here because a generic
// `type name(` regex is too noisy across these languages (control flow, macros).
const CLIKE_PATTERNS: Pattern[] = [
  { kind: "class", re: /^(?:public\s+|final\s+|abstract\s+|sealed\s+|open\s+|data\s+)*class\s+([A-Za-z_]\w*)/ },
  { kind: "interface", re: /^(?:public\s+)*interface\s+([A-Za-z_]\w*)/ },
  { kind: "struct", re: /^(?:public\s+|typedef\s+)*struct\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^(?:public\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/ },
  { kind: "trait", re: /^(?:public\s+)*(?:trait|protocol)\s+([A-Za-z_]\w*)/ },
];

function patternsFor(lang: Language): Pattern[] {
  switch (lang) {
    case "ts": return TS_PATTERNS;
    case "js": return JS_PATTERNS;
    case "py": return PY_PATTERNS;
    case "rs": return RS_PATTERNS;
    case "go": return GO_PATTERNS;
    case "java": return JAVA_PATTERNS;
    case "clike": return CLIKE_PATTERNS;
  }
}

// Clean a raw declaration line into a bounded, redacted signature: trim, drop a
// trailing block/statement opener, secret-redact, and length-cap.
function cleanSignature(raw: string): string {
  const trimmed = raw.trim().replace(/\s*[{;]\s*$/, "");
  const redacted = redactSecrets(trimmed).text;
  if (Array.from(redacted).length <= MAX_SIGNATURE_LEN) return redacted;
  return Array.from(redacted).slice(0, MAX_SIGNATURE_LEN - 1).join("") + "…";
}

// Extract top-level symbol declarations from a file's content. Pure: no I/O.
// Only column-0 declarations are considered; the result is bounded by
// MAX_SYMBOLS_PER_FILE. Returns an empty array for unrecognized languages.
export function extractSymbols(relPath: string, content: string): MapSymbol[] {
  const lang = languageForPath(relPath);
  if (lang === null) return [];
  const patterns = patternsFor(lang);
  const symbols: MapSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    const line = lines[i];
    // Top-level only: a leading whitespace/tab means a nested declaration.
    if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) {
        symbols.push({
          name: m[1],
          kind: p.kind,
          signature: cleanSignature(line),
          line: i + 1,
        });
        break;
      }
    }
  }
  return symbols;
}

// --- ranking + budgeting (pure) ---------------------------------------------

// Relevance score for a symbol-bearing file. More symbols (more API surface)
// ranks higher; entry-point-ish names and top-level source dirs get a bonus;
// depth and test files get a penalty. Deterministic; ties break by path.
export function scoreMapFile(relPath: string, symbolCount: number): number {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const depth = relPath.split("/").length - 1;
  let score = symbolCount * 2;
  if (/^(index|main|app|mod|lib|server|cli|program|run)(\.|$)/i.test(base)) score += 4;
  if (/^(src|lib)\//.test(relPath)) score += 2;
  if (/(^|\/)(tests?|__tests__|spec|specs)\//.test(relPath) || /\.(test|spec)\./i.test(base) || /_test\./i.test(base)) {
    score -= 3;
  }
  score -= depth;
  return score;
}

export interface MapFileEntry {
  /** Workspace-relative, `/`-separated path. */
  path: string;
  /** Top-level symbols retained for this file (after budget truncation). */
  symbols: MapSymbol[];
  /** Relevance score (higher = more central). */
  score: number;
}

// Raw file input to the pure engine (path + content already read).
export interface MapFileInput {
  path: string;
  content: string;
}

// The pure core of the map: extract symbols, keep symbol-bearing files, rank,
// and truncate to the budget. No I/O — fully unit-testable.
export interface RepoMapCore {
  files: MapFileEntry[];
  /** Total symbol-bearing files seen before budget truncation. */
  totalFiles: number;
  /** Char budget the map was truncated to. */
  budgetChars: number;
  /** Chars of rendered map actually used. */
  usedChars: number;
  /** True when the budget cut files or symbols. */
  truncated: boolean;
}

// Char cost of one rendered file block (path header + symbol lines + newlines).
// Must match the rendering in formatRepoMap so the reported usage is accurate.
function fileBlockChars(path: string, symbols: MapSymbol[]): number {
  let chars = path.length + 1; // header line + newline
  for (const s of symbols) chars += 2 + s.signature.length + 1; // "  sig" + newline
  return chars;
}

export function buildRepoMap(
  inputs: MapFileInput[],
  opts: { budgetChars?: number } = {},
): RepoMapCore {
  const budgetChars = Math.max(0, Math.floor(opts.budgetChars ?? DEFAULT_MAP_BUDGET_CHARS));

  // Extract symbols and keep only symbol-bearing files, capped before ranking.
  const collected: Array<{ path: string; symbols: MapSymbol[]; score: number }> = [];
  for (const input of inputs) {
    const symbols = extractSymbols(input.path, input.content);
    if (symbols.length === 0) continue;
    collected.push({ path: input.path, symbols, score: scoreMapFile(input.path, symbols.length) });
  }
  // Highest score first; deterministic tie-break by path.
  collected.sort((a, b) => b.score - a.score || byCodeUnit(a.path, b.path));
  const totalFiles = collected.length;
  const ranked = collected.slice(0, MAX_CANDIDATE_FILES);
  const candidatesTruncated = totalFiles > ranked.length;

  // Budget: include whole files while they fit; when a file only partially fits,
  // include the symbols that fit and stop. A path header is only emitted when at
  // least its own line fits, so the map never ends on a dangling header.
  const files: MapFileEntry[] = [];
  let usedChars = 0;
  let truncated = candidatesTruncated;
  for (const entry of ranked) {
    if (usedChars >= budgetChars) {
      truncated = true;
      break;
    }
    const headerCost = entry.path.length + 1;
    if (usedChars + headerCost > budgetChars) {
      truncated = true;
      break;
    }
    const included: MapSymbol[] = [];
    let local = usedChars + headerCost;
    const renderable = entry.symbols.slice(0, MAX_RENDERED_SYMBOLS_PER_FILE);
    for (const sym of renderable) {
      const lineCost = 2 + sym.signature.length + 1;
      if (local + lineCost > budgetChars) {
        truncated = true;
        break;
      }
      included.push(sym);
      local += lineCost;
    }
    usedChars = local;
    files.push({ path: entry.path, symbols: included, score: entry.score });
    // Stop when this file's renderable symbols did not all fit (budget cut it).
    if (included.length < renderable.length) break;
  }

  return { files, totalFiles, budgetChars, usedChars, truncated };
}

// --- snapshot (I/O collection) ----------------------------------------------

export type RepoMapState = "ok" | "empty" | "untrusted" | "unreadable";

export interface RepoMapExclusions {
  binary: number;
  secret: number;
  ignored: number;
}

export interface RepoMapSnapshot {
  schema: typeof REPO_MAP_SCHEMA;
  v: typeof REPO_MAP_VERSION;
  /** Budgeted, ranked files with their retained top-level symbols. */
  files: MapFileEntry[];
  /** Total symbol-bearing files seen before budget truncation. */
  totalFiles: number;
  /** Number of files retained in the rendered map. */
  includedFiles: number;
  /** Char budget the map was truncated to. */
  budgetChars: number;
  /** Chars of rendered map actually used. */
  usedChars: number;
  /** True when the budget or a walk bound cut content. */
  truncated: boolean;
  /** Number of files inspected by the bounded walk. */
  filesScanned: number;
  /** Counts of paths dropped during the walk. */
  excluded: RepoMapExclusions;
  /** Why the map is empty (ok means content is present). */
  state: RepoMapState;
}

export interface RepoMapOptions {
  /**
   * Whether the workspace is trusted. When false, the filesystem is never
   * walked and the result is an explicit `untrusted` refusal (non-destructive).
   * Defaults to true so pure callers and confined tests need not opt in.
   */
  trusted?: boolean;
  /** Apply .gitignore + built-in skip rules. Defaults to true. */
  ignore?: boolean;
  /** Rendered map budget in chars (default DEFAULT_MAP_BUDGET_CHARS). */
  budgetChars?: number;
}

interface WalkContext {
  root: string;
  ignore: boolean;
  ignoreSet: IgnoreSet;
  deadline: number;
  filesScanned: number;
  budgetExceeded: boolean;
  inputs: MapFileInput[];
  excluded: RepoMapExclusions;
}

function readPrefix(abs: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(MAX_FILE_READ_BYTES);
    const bytes = fs.readSync(fd, buf, 0, MAX_FILE_READ_BYTES, 0);
    return buf.subarray(0, bytes);
  } catch {
    return null; // unreadable or vanished mid-walk: skip rather than abort
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

// Bounded, symlink-safe DFS that collects symbol-extraction inputs for eligible
// files. Honors ignore rules, depth/file-count bounds, and a wall-clock deadline;
// binary and secret files are excluded with counts. Mirrors the containment of
// workspace-reference.ts: symlinks are never followed, so the walk cannot escape.
function walkForMap(ctx: WalkContext, startAbs: string, startDepth: number): void {
  const stack: Array<{ abs: string; depth: number }> = [{ abs: startAbs, depth: startDepth }];
  while (stack.length > 0) {
    if (ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
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
      if (ctx.filesScanned >= WALK_MAX_FILES || Date.now() > ctx.deadline) {
        ctx.budgetExceeded = true;
        break;
      }
      // Never follow symlinks: confines the walk and avoids cycles/escape.
      if (ent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, ent.name);
      const rel = toRelative(ctx.root, childAbs);
      if (ent.isDirectory()) {
        if (ctx.ignore && (ent.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(ent.name))) continue;
        if (ctx.ignore && ctx.ignoreSet.isIgnored(rel, true)) {
          ctx.excluded.ignored++;
          continue;
        }
        if (depth + 1 > WALK_MAX_DEPTH) {
          ctx.budgetExceeded = true;
          continue;
        }
        stack.push({ abs: childAbs, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (ctx.ignore && ctx.ignoreSet.isIgnored(rel, false)) {
          ctx.excluded.ignored++;
          continue;
        }
        if (looksLikeSecretPath(rel)) {
          ctx.excluded.secret++;
          continue;
        }
        // Only read files that can carry symbols; everything else is skipped
        // without an open so the walk stays responsive in large trees.
        if (languageForPath(rel) === null) continue;
        const buf = readPrefix(childAbs);
        if (buf === null) continue;
        if (looksBinary(buf)) {
          ctx.excluded.binary++;
          continue;
        }
        ctx.filesScanned++;
        ctx.inputs.push({ path: rel, content: buf.toString("utf8") });
        if (ctx.inputs.length >= MAX_CANDIDATE_FILES * 4) {
          // Bound how much we read before ranking; ranking keeps the best.
          ctx.budgetExceeded = true;
          return;
        }
      }
      // Special files (fifo, socket, device) are intentionally never read.
    }
  }
}

// Collect a bounded, ranked, redacted repository map for a workspace. Read-only:
// nothing on disk is mutated, and only declaration signatures are surfaced. When
// `trusted` is false the filesystem is never touched (explicit `untrusted`).
export function collectRepoMap(
  workspace: Workspace,
  opts: RepoMapOptions = {},
): RepoMapSnapshot {
  const trusted = opts.trusted ?? true;
  const ignore = opts.ignore ?? true;
  const budgetChars = Math.max(0, Math.floor(opts.budgetChars ?? DEFAULT_MAP_BUDGET_CHARS));
  const empty = (state: RepoMapState): RepoMapSnapshot => ({
    schema: REPO_MAP_SCHEMA,
    v: REPO_MAP_VERSION,
    files: [],
    totalFiles: 0,
    includedFiles: 0,
    budgetChars,
    usedChars: 0,
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
    inputs: [],
    excluded: { binary: 0, secret: 0, ignored: 0 },
  };
  walkForMap(ctx, workspace.root, 0);

  const core = buildRepoMap(ctx.inputs, { budgetChars });
  const state: RepoMapState = core.files.length === 0 ? "empty" : "ok";
  return {
    schema: REPO_MAP_SCHEMA,
    v: REPO_MAP_VERSION,
    files: core.files,
    totalFiles: core.totalFiles,
    includedFiles: core.files.length,
    budgetChars,
    usedChars: core.usedChars,
    truncated: core.truncated || ctx.budgetExceeded,
    filesScanned: ctx.filesScanned,
    excluded: ctx.excluded,
    state,
  };
}

// --- formatting -------------------------------------------------------------

// Render a bounded repository map as compact, color-independent text: a header
// with budget/usage and counts, then each retained file with its top-level
// signatures. The per-line format matches fileBlockChars so the reported usage
// is exact.
export function formatRepoMap(snapshot: RepoMapSnapshot): string {
  const lines: string[] = [];
  lines.push(`Repository map (${snapshot.schema} v${snapshot.v})`);
  lines.push("─".repeat(46));

  if (snapshot.state === "untrusted") {
    lines.push("State      : untrusted (workspace not walked)");
    return lines.join("\n");
  }
  if (snapshot.state === "unreadable") {
    lines.push("State      : unreadable workspace root");
    return lines.join("\n");
  }
  if (snapshot.files.length === 0) {
    lines.push("State      : empty (no symbol-bearing files)");
    return lines.join("\n");
  }

  lines.push(
    `Files      : ${snapshot.includedFiles} of ${snapshot.totalFiles} symbol-bearing` +
      `; budget ${snapshot.budgetChars} chars, used ${snapshot.usedChars}`,
  );
  for (const file of snapshot.files) {
    lines.push(file.path);
    for (const sym of file.symbols) {
      lines.push(`  ${sym.signature}`);
    }
  }
  if (snapshot.truncated) {
    const omitted = Math.max(0, snapshot.totalFiles - snapshot.includedFiles);
    lines.push(`… truncated: ${omitted} more symbol-bearing file(s) omitted`);
  }
  return lines.join("\n");
}
