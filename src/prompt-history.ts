// Durable, workspace-scoped prompt history (Issue #711). Submitted prompts
// otherwise leave composer recall the moment their session ends; this store
// makes them durable state keyed by the canonical workspace identity — the
// same `workspaceTrustKey` folder trust, --continue, and the #554/#556
// lineage use — so symlink aliases and linked worktrees of one repository
// share one history while different workspaces never see each other's.
// Prompts are private user content (possibly secret-bearing): owner-only
// files under the user's config directory, bounded in entries and entry
// size, never part of session transcripts, summaries, telemetry, or provider
// requests, and disposable by design — a corrupt record fails closed to an
// empty recall instead of blocking the composer.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceTrustKey } from "./folder-trust.js";

export const PROMPT_HISTORY_SCHEMA = "oh-my-cli.prompt-history";
export const PROMPT_HISTORY_VERSION = 1;

// Bound the durable history so daily use cannot grow the file without limit;
// the oldest entries are evicted first.
export const PROMPT_HISTORY_MAX_ENTRIES = 200;

// A recalled prompt must stay recomposable as sent; entries beyond this size
// are rejected at append time (and dropped at load time) rather than
// truncated into something the user did not submit.
export const PROMPT_HISTORY_MAX_ENTRY_CHARS = 8_192;

export interface PromptHistoryLoad {
  // Chronological, oldest first; empty when no trusted record exists.
  entries: string[];
  // True when a record exists but cannot be trusted; the caller starts with
  // an empty recall and may surface a bounded notice. The file is preserved,
  // never deleted here.
  corrupt: boolean;
}

export interface PromptHistoryStore {
  // The workspace-scoped history file (diagnostics and tests).
  readonly filePath: string;
  load(): PromptHistoryLoad;
  // Record a submitted prompt as the newest entry. Empty, whitespace-only,
  // and oversized entries are rejected; a consecutive duplicate is skipped.
  // Atomic (write temp + rename) so a crash never leaves a torn record.
  append(text: string): void;
  // Remove the durable record; a fresh launch afterwards recalls nothing.
  clear(): void;
}

// Mirrors the session store's HOME convention so an isolated test HOME (or a
// relocated user home) scopes histories the same way sessions are scoped.
export function defaultPromptHistoryDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(env.HOME ?? "/root", ".oh-my-cli", "prompt-history");
}

// The canonical workspace key is an absolute path; hash it to a flat,
// collision-resistant file name so no path separator or alias can escape the
// history directory.
export function promptHistoryFileName(workspaceKey: string): string {
  return crypto.createHash("sha256").update(workspaceKey).digest("hex") + ".json";
}

export interface OpenPromptHistoryStoreOptions {
  workspacePath: string;
  historyDir?: string;
  // Injectable canonical-key function for deterministic tests; defaults to
  // the folder-trust workspace key (same identity as --continue, #554/#556).
  keyOf?: (workspacePath: string) => string;
}

// Keep a stored record bounded and well-typed regardless of what wrote it:
// non-string, empty, and oversized entries are dropped; the newest
// PROMPT_HISTORY_MAX_ENTRIES survive. Returns null when the shape itself is
// not an array (corrupt record).
function sanitizeEntries(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (entry.trim() === "") continue;
    if (entry.length > PROMPT_HISTORY_MAX_ENTRY_CHARS) continue;
    out.push(entry);
  }
  return out.length > PROMPT_HISTORY_MAX_ENTRIES
    ? out.slice(out.length - PROMPT_HISTORY_MAX_ENTRIES)
    : out;
}

export function openPromptHistoryStore(opts: OpenPromptHistoryStoreOptions): PromptHistoryStore {
  const key = (opts.keyOf ?? workspaceTrustKey)(opts.workspacePath);
  const filePath = path.join(
    opts.historyDir ?? defaultPromptHistoryDir(),
    promptHistoryFileName(key),
  );

  const load = (): PromptHistoryLoad => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return { entries: [], corrupt: false };
    }
    let parsed: { schema?: unknown; v?: unknown; entries?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return { entries: [], corrupt: true };
    }
    if (parsed.schema !== PROMPT_HISTORY_SCHEMA || parsed.v !== PROMPT_HISTORY_VERSION) {
      return { entries: [], corrupt: true };
    }
    const entries = sanitizeEntries(parsed.entries);
    if (entries === null) return { entries: [], corrupt: true };
    return { entries, corrupt: false };
  };

  const persist = (entries: string[]): void => {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Owner-only regardless of umask: prompts are private user content.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort containment */
    }
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        schema: PROMPT_HISTORY_SCHEMA,
        v: PROMPT_HISTORY_VERSION,
        entries,
        updatedAt: Date.now(),
      }),
      "utf8",
    );
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  };

  const append = (text: string): void => {
    if (text.trim() === "") return;
    if (text.length > PROMPT_HISTORY_MAX_ENTRY_CHARS) return;
    const current = load().entries;
    // Consecutive duplicates collapse so recall never repeats a prompt the
    // user just sent (matches the in-session pushPromptHistory semantics).
    if (current[current.length - 1] === text) return;
    const entries = [...current, text];
    const bounded =
      entries.length > PROMPT_HISTORY_MAX_ENTRIES
        ? entries.slice(entries.length - PROMPT_HISTORY_MAX_ENTRIES)
        : entries;
    persist(bounded);
  };

  const clear = (): void => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* absent is already clear */
    }
  };

  return { filePath, load, append, clear };
}
