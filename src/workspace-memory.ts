// Durable workspace-scoped memory store (Issue #570, roadmap #280's first
// step: the local schema and security boundary). A user may manually record
// engineering knowledge (conventions, verified decisions) that outlives a
// session; every entry carries provenance (recording time, git head when
// available) and can be listed or forgotten. Security boundaries: secrets are
// redacted BEFORE persistence, the store is one file per canonical workspace
// identity (symlink/worktree aliases share one store; different workspaces
// never see each other's entries), writes are atomic (temp+rename, 0600), a
// corrupt store never crashes and is never overwritten by a read, and the
// whole feature refuses when OMC_MEMORY_DISABLED=1. This slice deliberately
// adds no retrieval into turns, no auto-extraction, and no authority:
// memories never bypass repository instructions, approvals, or governance.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { workspaceTrustKey } from "./folder-trust.js";
import { formatSessionAge } from "./session-summary.js";

export const WORKSPACE_MEMORY_SCHEMA = "oh-my-cli.memory" as const;
export const WORKSPACE_MEMORY_VERSION = 1 as const;
export const MEMORY_DISABLED_ENV = "OMC_MEMORY_DISABLED";
// Bounds keep the store small by design; overflow fails closed with guidance.
export const MEMORY_MAX_ENTRIES = 200;
export const MEMORY_MAX_TEXT_CHARS = 2_000;

export type MemoryStatus = "active" | "forgotten";

export interface MemoryProvenance {
  /** Recording time (ISO 8601). */
  at: string;
  /** Git head at recording time, when the workspace was a repository. */
  head?: string;
}

export interface MemoryEntry {
  id: string;
  /** Already redacted — secrets never reach the durable store. */
  text: string;
  status: MemoryStatus;
  provenance: MemoryProvenance;
  /** ISO time of a forget, retained as an auditable tombstone. */
  forgottenAt?: string;
}

export interface WorkspaceMemoryFile {
  schema: typeof WORKSPACE_MEMORY_SCHEMA;
  v: typeof WORKSPACE_MEMORY_VERSION;
  entries: MemoryEntry[];
}

export interface WorkspaceMemoryLoad {
  entries: MemoryEntry[];
  /** True when a store file exists but cannot be parsed; it is preserved. */
  corrupt: boolean;
  filePath: string;
}

// Mirrors the session store's HOME convention so an isolated test HOME (or a
// relocated user home) scopes memories like sessions and drafts.
export function defaultMemoryDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.HOME ?? os.homedir(), ".oh-my-cli", "memory");
}

// The canonical workspace key is an absolute path; hash it to a flat,
// collision-resistant file name so aliases share one store and no path
// separator can escape the memory directory.
export function memoryFileName(workspaceKey: string): string {
  return crypto.createHash("sha256").update(workspaceKey).digest("hex") + ".json";
}

export interface WorkspaceMemoryOptions {
  memoryDir?: string;
  /** Injectable canonical-key function for deterministic tests. */
  keyOf?: (workspacePath: string) => string;
  /** Injectable clock for deterministic provenance timestamps. */
  now?: () => number;
}

function resolvePaths(workspacePath: string, opts: WorkspaceMemoryOptions = {}): { filePath: string } {
  const key = (opts.keyOf ?? workspaceTrustKey)(workspacePath);
  return { filePath: path.join(opts.memoryDir ?? defaultMemoryDir(), memoryFileName(key)) };
}

/** Read the store; a corrupt file yields an empty entry list + corrupt flag. */
export function loadWorkspaceMemory(
  workspacePath: string,
  opts: WorkspaceMemoryOptions = {},
): WorkspaceMemoryLoad {
  const { filePath } = resolvePaths(workspacePath, opts);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { entries: [], corrupt: false, filePath };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceMemoryFile>;
    if (!Array.isArray(parsed.entries)) return { entries: [], corrupt: true, filePath };
    const entries = parsed.entries.filter(
      (e): e is MemoryEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as MemoryEntry).id === "string" &&
        typeof (e as MemoryEntry).text === "string",
    );
    return { entries, corrupt: false, filePath };
  } catch {
    return { entries: [], corrupt: true, filePath };
  }
}

function saveWorkspaceMemory(filePath: string, entries: MemoryEntry[]): void {
  const file: WorkspaceMemoryFile = {
    schema: WORKSPACE_MEMORY_SCHEMA,
    v: WORKSPACE_MEMORY_VERSION,
    entries,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file) + "\n", "utf8");
  // Owner-only regardless of umask: memories are private user content.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export type MemoryOpResult = { ok: true; entry?: MemoryEntry } | { ok: false; reason: string };

/**
 * Record a manual memory. Redaction happens BEFORE persistence; empty input,
 * a corrupt store, and a full store fail closed.
 */
export function addWorkspaceMemory(
  workspacePath: string,
  text: string,
  opts: WorkspaceMemoryOptions = {},
  provenance: { head?: string } = {},
): MemoryOpResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "usage: --memory-add <text> — the memory text must not be empty" };
  }
  const { filePath } = resolvePaths(workspacePath, opts);
  const load = loadWorkspaceMemory(workspacePath, opts);
  if (load.corrupt) {
    return {
      ok: false,
      reason: `the memory store is unreadable; refusing to write (move or delete ${redactHomePath(filePath)} to start fresh)`,
    };
  }
  if (load.entries.length >= MEMORY_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `the memory store is full (${MEMORY_MAX_ENTRIES} entries); forget unused memories first`,
    };
  }
  let redactedText = redactSecrets(trimmed).text;
  if (redactedText.length > MEMORY_MAX_TEXT_CHARS) {
    redactedText = `${redactedText.slice(0, MEMORY_MAX_TEXT_CHARS)}… [truncated]`;
  }
  const now = (opts.now ?? (() => Date.now()))();
  const entry: MemoryEntry = {
    id: newMemoryId(load.entries),
    text: redactedText,
    status: "active",
    provenance: {
      at: new Date(now).toISOString(),
      ...(provenance.head ? { head: provenance.head } : {}),
    },
  };
  saveWorkspaceMemory(filePath, [...load.entries, entry]);
  return { ok: true, entry };
}

/** Forget a memory by id (soft delete; the tombstone stays auditable). */
export function forgetWorkspaceMemory(
  workspacePath: string,
  id: string,
  opts: WorkspaceMemoryOptions = {},
): MemoryOpResult {
  const { filePath } = resolvePaths(workspacePath, opts);
  const load = loadWorkspaceMemory(workspacePath, opts);
  if (load.corrupt) {
    return {
      ok: false,
      reason: `the memory store is unreadable; refusing to write (move or delete ${redactHomePath(filePath)} to start fresh)`,
    };
  }
  const target = load.entries.find((e) => e.id === id);
  if (!target) {
    return { ok: false, reason: `no memory with id "${id}" in this workspace` };
  }
  const now = (opts.now ?? (() => Date.now()))();
  const entries = load.entries.map((e) =>
    e.id === id
      ? { ...e, status: "forgotten" as const, forgottenAt: new Date(now).toISOString() }
      : e,
  );
  saveWorkspaceMemory(filePath, entries);
  return { ok: true };
}

function newMemoryId(existing: MemoryEntry[]): string {
  const taken = new Set(existing.map((e) => e.id));
  for (;;) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!taken.has(id)) return id;
  }
}

// --- rendering ---------------------------------------------------------------

export interface MemoryListRecord {
  schema: typeof WORKSPACE_MEMORY_SCHEMA;
  v: typeof WORKSPACE_MEMORY_VERSION;
  workspace: string;
  corrupt: boolean;
  /** Active entries only; forgotten tombstones stay out of default views. */
  entries: Array<{
    id: string;
    text: string;
    recordedAt: string;
    head: string | null;
  }>;
}

export function buildMemoryListRecord(
  workspacePath: string,
  opts: WorkspaceMemoryOptions = {},
): MemoryListRecord {
  const load = loadWorkspaceMemory(workspacePath, opts);
  return {
    schema: WORKSPACE_MEMORY_SCHEMA,
    v: WORKSPACE_MEMORY_VERSION,
    workspace: redactHomePath(workspacePath),
    corrupt: load.corrupt,
    entries: load.entries
      .filter((e) => e.status === "active")
      .map((e) => ({
        id: e.id,
        text: e.text,
        recordedAt: e.provenance.at,
        head: e.provenance.head ?? null,
      })),
  };
}

const DISPLAY_TEXT_CHARS = 500;

export function formatMemoryList(
  workspacePath: string,
  opts: WorkspaceMemoryOptions = {},
): string[] {
  const load = loadWorkspaceMemory(workspacePath, opts);
  const now = (opts.now ?? (() => Date.now()))();
  const lines: string[] = [];
  lines.push(`Workspace memory — ${redactHomePath(workspacePath)}`);
  lines.push("─".repeat(40));
  if (load.corrupt) {
    lines.push("");
    lines.push("Warning: the memory store is unreadable; showing no memories.");
    return lines;
  }
  const active = load.entries.filter((e) => e.status === "active");
  const forgotten = load.entries.length - active.length;
  const forgottenLine =
    forgotten > 0
      ? `${forgotten} forgotten entr${forgotten === 1 ? "y" : "ies"} hidden from this list.`
      : null;
  if (active.length === 0) {
    lines.push("");
    lines.push("No workspace memories recorded.");
    if (forgottenLine) {
      lines.push("");
      lines.push(forgottenLine);
    }
    return lines;
  }
  lines.push("");
  for (const entry of active) {
    const age = formatSessionAge(Math.max(0, now - Date.parse(entry.provenance.at)));
    const head = entry.provenance.head ? `head ${entry.provenance.head.slice(0, 12)}` : "no git head";
    lines.push(`${entry.id}  ·  recorded ${age}  ·  ${head}`);
    const text = entry.text.length > DISPLAY_TEXT_CHARS
      ? `${entry.text.slice(0, DISPLAY_TEXT_CHARS)}…`
      : entry.text;
    for (const line of text.split("\n")) {
      lines.push(`    ${redactSecrets(line).text}`);
    }
  }
  if (forgottenLine) {
    lines.push("");
    lines.push(forgottenLine);
  }
  return lines;
}
