// Read-only repository-context snapshot.
//
// The CLI executes repository tasks without a shared, observable model of the
// repository it is working in. This module inspects workspace-local files and
// Git metadata only — it never installs, creates, edits, executes, fetches
// into, or otherwise mutates anything — and emits a bounded, schema-stable
// description of how the CLI understands the repository: the toolchain
// (package manager + lockfile), the canonical build/test/typecheck/lint
// commands, the primary languages, a bounded top-level structure outline, and
// the current VCS state. Detected commands are *reported*, never run. Every
// detail is redacted so credentials, host paths, and secret-shaped values stay
// out of the output, and every collection is bounded so a large repository
// cannot produce high-cardinality output. The result is deterministic for a
// fixed repository state.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";

export const REPO_CONTEXT_SCHEMA = "oh-my-cli.repo-context";
export const REPO_CONTEXT_VERSION = 1;

// Bounds that keep the snapshot free of high-cardinality or oversized content.
const MAX_STRUCTURE_ENTRIES = 200;
const MAX_LANGUAGES = 25;
const MAX_EXTENSIONS_PER_LANGUAGE = 12;
const WALK_MAX_DEPTH = 8;
const WALK_MAX_FILES = 20_000;
const MAX_COMMAND_LEN = 120;
const MAX_NAME_LEN = 200;
const MAX_MANIFEST_SCAN_BYTES = 8_192;

// Non-hidden directories skipped by the bounded language walk: heavy,
// generated, or irrelevant to the primary-language signal. Hidden directories
// (`.git`, `.venv`, …) are skipped separately by a prefix check. Entries are
// never followed (also avoids symlink cycles and workspace escape).
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", "venv", "env", "coverage",
]);

export type CanonicalCommand = "build" | "test" | "typecheck" | "lint";

const CANONICAL_COMMANDS: CanonicalCommand[] = ["build", "test", "typecheck", "lint"];

export interface ToolchainRef {
  /** Package manager / ecosystem name (npm, pnpm, cargo, go, …). */
  manager: string;
  /** Manifest file (relative to the workspace root), when known. */
  manifest?: string;
  /** Lockfile (relative to the workspace root), when present. */
  lockfile?: string;
}

export interface CommandRef {
  /** Where the command was resolved from. */
  source: "package.json" | "Makefile" | "pyproject.toml";
  /** The redacted, bounded command text (reported, never executed). */
  command: string;
}

export interface LanguageSignal {
  /** Language name (TypeScript, Python, …) or "Other" for unmapped extensions. */
  language: string;
  /** Distinct file extensions attributed to this language (sorted, bounded). */
  extensions: string[];
  /** Number of files counted for this language within the bounded walk. */
  files: number;
}

export interface StructureEntry {
  name: string;
  type: "dir" | "file";
}

export interface VcsState {
  repo: boolean;
  /** Current branch name, or null when detached or not a repository. */
  branch: string | null;
  /** True when HEAD is detached. */
  detached: boolean;
  /** True when the worktree has no uncommitted changes. */
  clean: boolean;
  /** Count of uncommitted changes (0 when not a repository). */
  dirtyCount: number;
}

export interface RepoContextSnapshot {
  schema: typeof REPO_CONTEXT_SCHEMA;
  v: typeof REPO_CONTEXT_VERSION;
  /** Detected package managers / ecosystems (sorted by manager). */
  toolchains: ToolchainRef[];
  /** Canonical commands resolved from manifests/build files (null when absent). */
  commands: Record<CanonicalCommand, CommandRef | null>;
  /** Primary languages by file count (sorted, bounded). */
  languages: LanguageSignal[];
  /** True when more distinct languages were seen than are reported. */
  languagesTruncated: boolean;
  /** Number of files inspected by the bounded language walk. */
  filesScanned: number;
  /** True when the walk stopped at a depth or file-count bound. */
  scanTruncated: boolean;
  /** Bounded top-level structure outline (sorted by name). */
  structure: StructureEntry[];
  /** Number of top-level entries omitted beyond the cap (0 when none). */
  structureOverflow: number;
  /** Current VCS state. */
  vcs: VcsState;
}

// --- redaction helpers ------------------------------------------------------

function redact(text: string): string {
  return redactSecrets(text).text;
}

function redactName(text: string): string {
  return redactSecrets(text).text.slice(0, MAX_NAME_LEN);
}

function redactCommand(text: string): string {
  return redactSecrets(text).text.slice(0, MAX_COMMAND_LEN);
}

// A locale-independent comparator (UTF-16 code-unit order) so ordering is
// deterministic across environments rather than depending on the host locale.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- file helpers (read-only, workspace-confined) ---------------------------

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readBounded(p: string, maxBytes: number): string | null {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString("utf8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// --- toolchain detection ----------------------------------------------------

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
  ".c": "C", ".h": "C",
  ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++", ".hxx": "C++",
  ".cs": "C#",
  ".swift": "Swift",
  ".kt": "Kotlin", ".kts": "Kotlin",
  ".scala": "Scala", ".sc": "Scala",
  ".sh": "Shell", ".bash": "Shell",
  ".md": "Markdown", ".mdx": "Markdown",
  ".json": "JSON",
  ".yaml": "YAML", ".yml": "YAML",
  ".toml": "TOML",
  ".html": "HTML", ".htm": "HTML",
  ".css": "CSS", ".scss": "CSS", ".sass": "CSS", ".less": "CSS",
  ".sql": "SQL",
  ".vue": "Vue",
  ".dart": "Dart",
  ".lua": "Lua",
  ".r": "R",
};

function detectToolchains(workspace: string): ToolchainRef[] {
  const has = (name: string): boolean => existsFile(path.join(workspace, name));
  const refs: ToolchainRef[] = [];

  // JavaScript ecosystem: resolve to a single manager by lockfile precedence,
  // defaulting to npm when only the manifest is present.
  if (has("package.json")) {
    let manager = "npm";
    let lockfile: string | undefined;
    if (has("package-lock.json")) { manager = "npm"; lockfile = "package-lock.json"; }
    else if (has("pnpm-lock.yaml")) { manager = "pnpm"; lockfile = "pnpm-lock.yaml"; }
    else if (has("yarn.lock")) { manager = "yarn"; lockfile = "yarn.lock"; }
    else if (has("bun.lockb")) { manager = "bun"; lockfile = "bun.lockb"; }
    refs.push({ manager, manifest: "package.json", ...(lockfile ? { lockfile } : {}) });
  }

  // Python ecosystem: requirements.txt, Pipfile, and pyproject.toml may coexist.
  if (has("requirements.txt")) {
    refs.push({ manager: "pip", manifest: "requirements.txt" });
  }
  if (has("Pipfile")) {
    refs.push({ manager: "pipenv", manifest: "Pipfile", ...(has("Pipfile.lock") ? { lockfile: "Pipfile.lock" } : {}) });
  }
  if (has("pyproject.toml")) {
    const body = readBounded(path.join(workspace, "pyproject.toml"), MAX_MANIFEST_SCAN_BYTES) ?? "";
    const manager = /\[\s*tool\s*\.\s*poetry\s*\]/.test(body) ? "poetry" : "python";
    refs.push({ manager, manifest: "pyproject.toml" });
  }

  // Rust.
  if (has("Cargo.toml")) {
    refs.push({ manager: "cargo", manifest: "Cargo.toml", ...(has("Cargo.lock") ? { lockfile: "Cargo.lock" } : {}) });
  }

  // Go.
  if (has("go.mod")) {
    refs.push({ manager: "go", manifest: "go.mod", ...(has("go.sum") ? { lockfile: "go.sum" } : {}) });
  }

  // PHP (Composer).
  if (has("composer.json")) {
    refs.push({ manager: "composer", manifest: "composer.json", ...(has("composer.lock") ? { lockfile: "composer.lock" } : {}) });
  }

  // Ruby (Bundler).
  if (has("Gemfile")) {
    refs.push({ manager: "bundler", manifest: "Gemfile", ...(has("Gemfile.lock") ? { lockfile: "Gemfile.lock" } : {}) });
  }

  // JVM build tools.
  if (has("pom.xml")) {
    refs.push({ manager: "maven", manifest: "pom.xml" });
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    refs.push({ manager: "gradle", manifest: has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle" });
  }

  return refs.sort((a, b) => byCodeUnit(a.manager, b.manager));
}

// --- canonical command detection --------------------------------------------

function detectPackageJsonCommands(
  workspace: string,
): Partial<Record<CanonicalCommand, CommandRef>> {
  const found: Partial<Record<CanonicalCommand, CommandRef>> = {};
  const raw = readBounded(path.join(workspace, "package.json"), 1 << 20);
  if (raw === null) return found;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return found;
  }
  const scripts = (pkg as { scripts?: Record<string, unknown> }).scripts;
  if (!scripts || typeof scripts !== "object") return found;
  const keys: Record<CanonicalCommand, string[]> = {
    build: ["build"],
    test: ["test"],
    typecheck: ["typecheck", "type-check", "tsc"],
    lint: ["lint"],
  };
  for (const cmd of CANONICAL_COMMANDS) {
    for (const key of keys[cmd]) {
      const value = scripts[key];
      if (typeof value === "string" && value.trim()) {
        found[cmd] = { source: "package.json", command: redactCommand(value.trim()) };
        break;
      }
    }
  }
  return found;
}

function detectMakefileCommands(
  workspace: string,
): Partial<Record<CanonicalCommand, CommandRef>> {
  const found: Partial<Record<CanonicalCommand, CommandRef>> = {};
  const body = readBounded(path.join(workspace, "Makefile"), MAX_MANIFEST_SCAN_BYTES);
  if (body === null) return found;
  const targets = new Set<string>();
  for (const line of body.split("\n").slice(0, 500)) {
    // A Make target line: "name:" or "name: deps" at column 0 (no leading tab).
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (m) targets.add(m[1]);
  }
  for (const cmd of CANONICAL_COMMANDS) {
    if (targets.has(cmd)) {
      found[cmd] = { source: "Makefile", command: `make ${cmd}` };
    }
  }
  return found;
}

function detectPyprojectCommands(
  workspace: string,
): Partial<Record<CanonicalCommand, CommandRef>> {
  const found: Partial<Record<CanonicalCommand, CommandRef>> = {};
  const body = readBounded(path.join(workspace, "pyproject.toml"), MAX_MANIFEST_SCAN_BYTES);
  if (body === null) return found;
  const has = (re: RegExp): boolean => re.test(body);
  if (has(/\[\s*tool\s*\.\s*pytest(\s|\.|\])/)) {
    found.test = { source: "pyproject.toml", command: "pytest" };
  }
  if (has(/\[\s*tool\s*\.\s*mypy(\s|\.|\])/)) {
    found.typecheck = { source: "pyproject.toml", command: "mypy" };
  }
  const lintTool =
    has(/\[\s*tool\s*\.\s*ruff(\s|\.|\])/) ? "ruff"
    : has(/\[\s*tool\s*\.\s*pylint(\s|\.|\])/) ? "pylint"
    : has(/\[\s*tool\s*\.\s*flake8(\s|\.|\])/) ? "flake8"
    : has(/\[\s*tool\s*\.\s*black(\s|\.|\])/) ? "black"
    : null;
  if (lintTool) {
    found.lint = { source: "pyproject.toml", command: lintTool };
  }
  return found;
}

function detectCommands(workspace: string): Record<CanonicalCommand, CommandRef | null> {
  // Precedence: package.json scripts, then Makefile targets, then pyproject
  // tool sections. The first source to define a canonical command wins.
  const sources = [
    detectPackageJsonCommands(workspace),
    detectMakefileCommands(workspace),
    detectPyprojectCommands(workspace),
  ];
  const commands = {} as Record<CanonicalCommand, CommandRef | null>;
  for (const cmd of CANONICAL_COMMANDS) {
    commands[cmd] = null;
    for (const source of sources) {
      const ref = source[cmd];
      if (ref) {
        commands[cmd] = ref;
        break;
      }
    }
  }
  return commands;
}

// --- bounded language walk --------------------------------------------------

interface WalkStats {
  extCounts: Map<string, number>;
  filesScanned: number;
  truncated: boolean;
}

function walkForLanguages(root: string): WalkStats {
  const extCounts = new Map<string, number>();
  let filesScanned = 0;
  let truncated = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (filesScanned >= WALK_MAX_FILES) {
        truncated = true;
        break;
      }
      // Never follow symlinks: confines the walk to the workspace and avoids
      // cycles.
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        // Skip hidden directories (VCS metadata, agent runtime, editor config):
        // they are tooling, not the repository's primary-language signal. The
        // top-level structure outline still lists them honestly.
        if (ent.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth + 1 > WALK_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      } else if (ent.isFile()) {
        filesScanned++;
        const ext = path.extname(ent.name).toLowerCase();
        if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }
    }
  }
  return { extCounts, filesScanned, truncated };
}

function buildLanguages(stats: WalkStats): {
  languages: LanguageSignal[];
  truncated: boolean;
} {
  // Aggregate extensions into languages (unmapped extensions fall into "Other").
  const byLanguage = new Map<string, { extensions: Set<string>; files: number }>();
  for (const [ext, count] of stats.extCounts) {
    const language = EXT_LANGUAGE[ext] ?? "Other";
    const bucket = byLanguage.get(language) ?? { extensions: new Set<string>(), files: 0 };
    bucket.extensions.add(ext);
    bucket.files += count;
    byLanguage.set(language, bucket);
  }

  const all = [...byLanguage.entries()].map(([language, b]) => ({
    language,
    extensions: [...b.extensions].sort().slice(0, MAX_EXTENSIONS_PER_LANGUAGE),
    files: b.files,
  }));
  // Deterministic: by file count descending, then language name ascending.
  all.sort((a, b) => b.files - a.files || byCodeUnit(a.language, b.language));

  const languages = all.slice(0, MAX_LANGUAGES);
  return { languages, truncated: all.length > languages.length };
}

// --- structure outline ------------------------------------------------------

function buildStructure(workspace: string): {
  structure: StructureEntry[];
  overflow: number;
} {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return { structure: [], overflow: 0 };
  }
  const mapped: StructureEntry[] = entries.map((ent) => ({
    name: redactName(ent.name),
    type: ent.isDirectory() ? "dir" : "file",
  }));
  // Deterministic: by name, then type for stable tie-breaking.
  mapped.sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.type, b.type));
  const overflow = Math.max(0, mapped.length - MAX_STRUCTURE_ENTRIES);
  return { structure: mapped.slice(0, MAX_STRUCTURE_ENTRIES), overflow };
}

// --- VCS state --------------------------------------------------------------

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

function detectVcs(workspace: string): VcsState {
  const isRepo =
    git(workspace, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  if (!isRepo) {
    return { repo: false, branch: null, detached: false, clean: false, dirtyCount: 0 };
  }
  const branchRaw = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached.
  const detached = branchRaw === "HEAD" || branchRaw === "";
  const branch = detached ? null : redact(branchRaw);
  const dirtyCount = git(workspace, ["status", "--porcelain"])
    .stdout.split("\n")
    .filter((line) => line.trim().length > 0).length;
  return { repo: true, branch, detached, clean: dirtyCount === 0, dirtyCount };
}

// --- collection (read-only) -------------------------------------------------

export interface RepoContextOptions {
  /** Workspace to inspect (default cwd). */
  workspace?: string;
}

/**
 * Inspect a workspace and produce a deterministic, bounded, redacted snapshot
 * of how the CLI models the repository. All probes are read-only; nothing about
 * the repository or filesystem is mutated, and detected commands are reported
 * but never executed.
 */
export function collectRepoContext(opts: RepoContextOptions = {}): RepoContextSnapshot {
  const workspace = path.resolve(opts.workspace ?? process.cwd());

  const toolchains = detectToolchains(workspace);
  const commands = detectCommands(workspace);
  const stats = walkForLanguages(workspace);
  const { languages, truncated: languagesTruncated } = buildLanguages(stats);
  const { structure, overflow: structureOverflow } = buildStructure(workspace);
  const vcs = detectVcs(workspace);

  return {
    schema: REPO_CONTEXT_SCHEMA,
    v: REPO_CONTEXT_VERSION,
    toolchains,
    commands,
    languages,
    languagesTruncated,
    filesScanned: stats.filesScanned,
    scanTruncated: stats.truncated,
    structure,
    structureOverflow,
    vcs,
  };
}

// --- formatting -------------------------------------------------------------

function formatToolchain(ref: ToolchainRef): string {
  const parts = [ref.manifest, ref.lockfile].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? `${ref.manager} (${parts.join(", ")})` : ref.manager;
}

export function formatRepoContext(snapshot: RepoContextSnapshot): string {
  const lines: string[] = [];
  lines.push(`Repository context (${snapshot.schema} v${snapshot.v})`);
  lines.push("─".repeat(46));

  lines.push(
    `Toolchains : ${
      snapshot.toolchains.length > 0
        ? snapshot.toolchains.map(formatToolchain).join("; ")
        : "unknown"
    }`,
  );

  lines.push("Commands   :");
  for (const cmd of CANONICAL_COMMANDS) {
    const ref = snapshot.commands[cmd];
    const detail = ref ? `[${ref.source}] ${ref.command}` : "—";
    lines.push(`  ${cmd.padEnd(10)} ${detail}`);
  }

  if (snapshot.languages.length > 0) {
    const rendered = snapshot.languages.map(
      (l) => `${l.language} (${l.files} file${l.files === 1 ? "" : "s"}; ${l.extensions.join(", ")})`,
    );
    lines.push(`Languages  : ${rendered.join(", ")}${snapshot.languagesTruncated ? ", …" : ""}`);
  } else {
    lines.push("Languages  : unknown");
  }

  if (snapshot.structure.length > 0) {
    const rendered = snapshot.structure.map((e) => (e.type === "dir" ? `${e.name}/` : e.name));
    let line = rendered.join("  ");
    if (snapshot.structureOverflow > 0) line += `  … (+${snapshot.structureOverflow} more)`;
    lines.push(`Structure  : ${line}`);
  } else {
    lines.push("Structure  : (empty)");
  }

  if (!snapshot.vcs.repo) {
    lines.push("VCS        : not a git repository");
  } else if (snapshot.vcs.detached) {
    lines.push("VCS        : detached HEAD");
  } else {
    const state = snapshot.vcs.clean ? "clean" : `${snapshot.vcs.dirtyCount} uncommitted change(s)`;
    lines.push(`VCS        : on "${snapshot.vcs.branch}" — ${state}`);
  }

  if (snapshot.scanTruncated) {
    lines.push("");
    lines.push(`Note: language scan was bounded (${snapshot.filesScanned} files inspected).`);
  }

  return lines.join("\n");
}
