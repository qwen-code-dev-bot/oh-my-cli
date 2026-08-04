// Resumable-session listing with a redacted usage summary.
//
// Before restoring a session a user needs to recognise it: which model and
// repository it belongs to, how long ago it was last active, and roughly how
// much context will be reloaded. This module enumerates the session store
// read-only, derives that summary per session, and renders a redacted list.
// A missing or corrupt session is reported without disturbing it or any other
// checkpoint.

import fs from "node:fs";
import { redactSecrets } from "./permission-impact.js";
import { workspaceTrustKey } from "./folder-trust.js";
import type { SessionStore } from "./session.js";

export interface SessionSummary {
  id: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  totalChars: number;
  /** Rough context-size estimate (chars / 4); labelled as an estimate. */
  approxTokens: number;
  model?: string;
  workspace?: string;
  // The user-owned session name (#249) when one is set; raw — renderers must
  // redact before display (the static list and the picker both do).
  name?: string;
  createdAt: number | null;
  lastModified: number;
  ageMs: number;
  corrupt: boolean;
}

export interface SessionSummaryOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const CHARS_PER_TOKEN = 4;

export function collectSessionSummaries(
  store: SessionStore,
  opts: SessionSummaryOptions = {},
): SessionSummary[] {
  const now = (opts.now ?? (() => Date.now()))();
  const summaries: SessionSummary[] = [];
  for (const id of store.listIds()) {
    summaries.push(summarize(store, id, now));
  }
  // Most recently active first, so the session worth resuming is on top.
  summaries.sort((a, b) => b.lastModified - a.lastModified);
  return summaries;
}

function summarize(store: SessionStore, id: string, now: number): SessionSummary {
  const diag = store.loadWithDiagnostics(id);
  // The name sidecar is independent of transcript health, so corrupt sessions
  // still carry their user-owned name when one is set (Issue #530).
  const name = store.readName(id);

  let lastModified = now;
  try {
    lastModified = fs.statSync(store.filePath(id)).mtimeMs;
  } catch {
    /* fall back to now if the file vanished between listing and stat */
  }

  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let totalChars = 0;
  for (const m of diag.messages) {
    if (m.role === "user") userTurns++;
    else if (m.role === "assistant") assistantTurns++;
    if (Array.isArray(m.tool_calls)) toolCalls += m.tool_calls.length;
    if (typeof m.content === "string") totalChars += m.content.length;
  }

  return {
    id,
    messageCount: diag.messages.length,
    userTurns,
    assistantTurns,
    toolCalls,
    totalChars,
    approxTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    model: diag.meta?.model,
    workspace: diag.meta?.workspace,
    ...(name ? { name } : {}),
    createdAt: diag.meta?.createdAt ?? null,
    lastModified,
    ageMs: Math.max(0, now - lastModified),
    corrupt: diag.corrupt,
  };
}

// The result of selecting a session for `--continue` (Issue #513). Selection is
// read-only and fail-closed: it yields either the most recent healthy session
// declared for the current workspace, or an actionable reason — never another
// workspace's session and never a corrupt one.
export type ContinuePickResult =
  | { ok: true; sessionId: string; workspace?: string; model?: string }
  | { ok: false; reason: "no-session" | "only-corrupt" };

// Pick the session `--continue` should resume from an already most-recent-first
// summary list (collectSessionSummaries guarantees the ordering). A session
// matches when its declared workspace collapses to the same canonical workspace
// identity as the current one (symlink aliases and linked git worktrees share
// their parent's identity). Corrupt matches are skipped but remembered: when
// nothing healthy matches, reporting "only corrupt" is more actionable than
// "none found". Sessions without workspace metadata never match. `keyOf` is
// injectable for deterministic tests; it defaults to the folder-trust workspace
// key.
export function pickContinueSession(
  summaries: readonly SessionSummary[],
  currentKey: string,
  keyOf: (workspacePath: string) => string = workspaceTrustKey,
): ContinuePickResult {
  let corruptMatch = false;
  for (const s of summaries) {
    if (!s.workspace) continue;
    let key: string;
    try {
      key = keyOf(s.workspace);
    } catch {
      continue;
    }
    if (key !== currentKey) continue;
    if (s.corrupt) {
      corruptMatch = true;
      continue;
    }
    return {
      ok: true,
      sessionId: s.id,
      ...(s.workspace ? { workspace: s.workspace } : {}),
      ...(s.model ? { model: s.model } : {}),
    };
  }
  return corruptMatch ? { ok: false, reason: "only-corrupt" } : { ok: false, reason: "no-session" };
}

// Versioned machine-readable record for `--list-sessions --output json`
// (Issue #542), following the `oh-my-cli.<surface>` convention of the sibling
// listings/diagnostics. Entries carry the same data the text view renders,
// redacted through the identical pipelines (secret redaction for model/name,
// home collapse for workspace paths) — never a new secret surface.
export const SESSIONS_SCHEMA = "oh-my-cli.sessions";
export const SESSIONS_VERSION = 1;

export interface SessionListEntry {
  id: string;
  /** Redacted user-owned name (#249/#530), present only when set. */
  name?: string;
  /** Redacted model identifier, or "unknown". */
  model: string;
  /** Redacted workspace path (home collapsed to ~), or "unknown". */
  workspace: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  /** Estimated tokens (ceil(chars/4)) — an estimate, stated as such. */
  approxTokens: number;
  createdAt: number | null;
  lastModified: number;
  ageMs: number;
  corrupt: boolean;
}

export interface SessionListRecord {
  schema: typeof SESSIONS_SCHEMA;
  v: typeof SESSIONS_VERSION;
  total: number;
  resumable: number;
  corrupt: number;
  sessions: SessionListEntry[];
}

// Case-insensitive substring filter over session summaries (Issue #548):
// matches id, user-owned name, model, and workspace path. Sessions are local
// user data, so matching runs on the raw values; rendering still redacts.
// An empty/blank query passes everything through; order is preserved.
export function filterSessionSummaries(
  summaries: SessionSummary[],
  query: string,
): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return summaries;
  return summaries.filter((s) => {
    const haystacks = [s.id, s.name ?? "", s.model ?? "", s.workspace ?? ""];
    return haystacks.some((h) => h.toLowerCase().includes(needle));
  });
}

export function sessionListRecord(summaries: SessionSummary[]): SessionListRecord {
  const corrupt = summaries.filter((s) => s.corrupt).length;
  return {
    schema: SESSIONS_SCHEMA,
    v: SESSIONS_VERSION,
    total: summaries.length,
    resumable: summaries.length - corrupt,
    corrupt,
    sessions: summaries.map((s) => ({
      id: s.id,
      ...(s.name ? { name: redact(s.name) } : {}),
      model: redact(s.model),
      workspace: redactPath(s.workspace),
      messageCount: s.messageCount,
      userTurns: s.userTurns,
      assistantTurns: s.assistantTurns,
      toolCalls: s.toolCalls,
      approxTokens: s.approxTokens,
      createdAt: s.createdAt,
      lastModified: s.lastModified,
      ageMs: s.ageMs,
      corrupt: s.corrupt,
    })),
  };
}

export function formatSessionList(summaries: SessionSummary[]): string {
  const lines: string[] = [];
  lines.push("Sessions");
  lines.push("─".repeat(40));

  if (summaries.length === 0) {
    lines.push("");
    lines.push("No resumable sessions found.");
    return lines.join("\n");
  }

  lines.push("");
  for (const s of summaries) lines.push(...formatSessionLines(s));

  const corrupt = summaries.filter((s) => s.corrupt).length;
  lines.push("");
  lines.push(
    `Summary: ${summaries.length - corrupt} resumable, ${corrupt} corrupt ` +
      `(${summaries.length} total)`,
  );
  lines.push("");
  lines.push(`Resume one with: oh-my-cli --resume <session-id> -p "<prompt>"`);

  return lines.join("\n");
}

function formatSessionLines(s: SessionSummary): string[] {
  const symbol = s.corrupt ? "✗" : "✓";
  // Corrupt sessions point at the salvage path that delivers the partial
  // recovery this list advertises (Issue #546).
  const flag = s.corrupt ? "  (corrupt — salvage with --salvage-session)" : "";
  // The user-owned name (#249) renders next to the id (Issue #530), redacted
  // exactly like the picker renders it — so the discovery surface and the
  // resume surfaces agree.
  const namePart = s.name ? `  "${redact(s.name)}"` : "";
  const head = `  ${symbol} ${s.id}${namePart}${flag}`;
  const provenance = `model ${redact(s.model)}  ·  repo ${redactPath(s.workspace)}`;
  const usage =
    `${s.messageCount} msgs, ${s.userTurns + s.assistantTurns} turns, ` +
    `${s.toolCalls} tool calls, ~${s.approxTokens} tokens (est.)`;
  const age = `last active ${formatSessionAge(s.ageMs)}`;
  return [head, `      ${provenance}`, `      ${usage}  ·  ${age}`];
}

function redact(value: string | undefined): string {
  if (!value) return "unknown";
  return redactSecrets(value).text;
}

function redactPath(p: string | undefined): string {
  if (!p) return "unknown";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  let out = p;
  if (home && out.startsWith(home)) out = "~" + out.slice(home.length);
  return redactSecrets(out).text;
}

// Human-friendly "last active" bucket. Exported so the interactive session
// picker (session-picker.ts) renders the same age labels as the static list.
export function formatSessionAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
