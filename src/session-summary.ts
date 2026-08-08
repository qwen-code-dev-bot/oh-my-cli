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
import { readSessionNotes } from "./session-notes.js";
import { readSessionLock, isPidAlive } from "./session-lock.js";

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
  // Advisory lock state (Issue #793): the lock sidecar exists for this
  // session. `lockPid` is the holder pid; `lockStale` is true when the
  // holder is no longer alive per isPidAlive semantics. The listing is
  // strictly read-only: it reports the store's advisory state as-is and
  // never creates, removes, or heals locks (healing stays on open, #741).
  locked: boolean;
  lockPid?: number;
  lockStale?: boolean;
  ageMs: number;
  corrupt: boolean;
  // Archived out of discovery (Issue #598); resumable by exact id/name.
  archived: boolean;
  // Pinned to the top of discovery (Issue #610), independent of recency.
  pinned: boolean;
  /** Epoch ms when the session was pinned; present only when pinned. */
  pinnedAt?: number;
  /** Durable notes entries (Issue #624); 0 when absent or unreadable. */
  noteCount: number;
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
    // The archive marker is integrity-agnostic metadata (Issue #598), exactly
    // like the name sidecar read above.
    archived: store.readArchived(id) !== null,
    // The pin marker follows the same conventions (Issue #610).
    ...((): { pinned: boolean; pinnedAt?: number } => {
      const pinned = store.readPinned(id);
      return pinned !== null ? { pinned: true, pinnedAt: pinned.at } : { pinned: false };
    })(),
    // Durable notes presence (Issue #624): an unreadable sidecar contributes
    // nothing (honest absence), matching the inspect/journal semantics.
    ...((): { noteCount: number } => {
      const notes = readSessionNotes(store, id);
      return { noteCount: notes.corrupt ? 0 : notes.notes.length };
    })(),
    // Advisory lock state (Issue #793): read-only — the sidecar is read,
    // never created/removed/healed here. Staleness follows the existing
    // isPidAlive semantics; PID reuse remains the documented advisory
    // limitation (a reused pid reads as alive, same as on the open path).
    ...((): { locked: boolean; lockPid?: number; lockStale?: boolean } => {
      const lock = readSessionLock(store.lockPath(id));
      if (lock === null) return { locked: false };
      return { locked: true, lockPid: lock.pid, lockStale: !isPidAlive(lock.pid) };
    })(),
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
// their parent's identity). Discovery semantics apply exactly as in the
// listing surfaces (Issue #616, completing the #598/#610 story): archived
// sessions are never picked (archive prevails over pinning), and pinned
// sessions take precedence — the most recently modified pinned candidate wins
// when any exists, otherwise the most recent unpinned candidate. Corrupt
// matches are skipped but remembered: when nothing healthy matches, reporting
// "only corrupt" is more actionable than "none found" (a corrupt-and-archived
// session is fully retired from discovery, so it counts toward neither).
// Sessions without workspace metadata never match. `keyOf` is injectable for
// deterministic tests; it defaults to the folder-trust workspace key.
export function pickContinueSession(
  summaries: readonly SessionSummary[],
  currentKey: string,
  keyOf: (workspacePath: string) => string = workspaceTrustKey,
): ContinuePickResult {
  let corruptMatch = false;
  let pinnedPick: SessionSummary | null = null;
  let recencyPick: SessionSummary | null = null;
  for (const s of summaries) {
    if (!s.workspace) continue;
    let key: string;
    try {
      key = keyOf(s.workspace);
    } catch {
      continue;
    }
    if (key !== currentKey) continue;
    if (s.archived) continue;
    if (s.corrupt) {
      corruptMatch = true;
      continue;
    }
    // Summaries arrive most-recent-first, so the first pinned candidate seen
    // is the newest pinned one, and the first unpinned candidate is the
    // plain recency pick.
    if (s.pinned) {
      if (pinnedPick === null) pinnedPick = s;
    } else if (recencyPick === null) {
      recencyPick = s;
    }
  }
  const chosen = pinnedPick ?? recencyPick;
  if (chosen !== null) {
    return {
      ok: true,
      sessionId: chosen.id,
      ...(chosen.workspace ? { workspace: chosen.workspace } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
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
  /** Advisory lock state (Issue #793): always present; explicit false when unlocked. */
  locked: boolean;
  /** Lock holder pid (Issue #793); present only when locked. */
  lockPid?: number;
  /** Holder no longer alive per isPidAlive (Issue #793); present only when locked. */
  lockStale?: boolean;
  /** True when the entry is archived and shown via --include-archived (#598). */
  archived?: boolean;
  /** True when the entry is pinned (listed first, Issue #610). */
  pinned?: boolean;
  /** Epoch ms when the session was pinned; present only when pinned. */
  pinnedAt?: number;
  /** Durable notes count (Issue #624); present only when the session has notes. */
  noteCount?: number;
}

export interface SessionListRecord {
  schema: typeof SESSIONS_SCHEMA;
  v: typeof SESSIONS_VERSION;
  total: number;
  resumable: number;
  corrupt: number;
  /** Pinned entries among the listed sessions (Issue #610). */
  pinned: number;
  sessions: SessionListEntry[];
  // Workspace scoping (Issue #596): present only when --workspace-scoped was
  // active. Names the redacted scope target and counts the sessions excluded
  // because their workspace could not be verified.
  scopedWorkspace?: string;
  excludedUnverifiable?: number;
  // Archived retirement (Issue #598): present only when archived sessions
  // exist and --include-archived is not set (they are hidden from the list).
  archivedHidden?: number;
}

// The active workspace scope as reported by the listing/search surfaces
// (Issue #596). `workspace` is the declared scope target (redacted by the
// renderers); `excludedUnverifiable` counts the sessions whose workspace
// could not be verified.
export interface SessionScopeInfo {
  workspace: string;
  excludedUnverifiable: number;
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

// Pin-first ordering for session listing (Issue #610): the pinned block comes
// first, and recency order (the input order from collectSessionSummaries) is
// preserved within each block. Applied only by the listing surface — continue
// selection and the picker keep pure recency semantics for now.
export function orderSummariesPinnedFirst(
  summaries: SessionSummary[],
): SessionSummary[] {
  return [
    ...summaries.filter((s) => s.pinned),
    ...summaries.filter((s) => !s.pinned),
  ];
}

// The outcome of workspace scoping for session enumeration (Issue #596).
export interface WorkspaceScopeResult {
  kept: SessionSummary[];
  // Sessions whose workspace could not be verified (absent/legacy metadata,
  // or a declared path that fails canonicalization).
  excludedUnverifiable: number;
}

// Workspace scoping for session enumeration (Issue #596): keep sessions whose
// declared workspace collapses to the same canonical identity as the target —
// symlink aliases and linked git worktrees match, exactly like `--continue`
// and the #554 resume-binding check. Sessions whose workspace cannot be
// verified are excluded and counted, never silently dropped; sessions that
// verifiably belong to another workspace are simply out of scope and not
// counted as excluded. Read-only; order is preserved. `keyOf` is injectable
// for deterministic tests; it defaults to the folder-trust workspace key.
export function scopeSessionSummariesByWorkspace(
  summaries: SessionSummary[],
  currentKey: string,
  keyOf: (workspacePath: string) => string = workspaceTrustKey,
): WorkspaceScopeResult {
  const kept: SessionSummary[] = [];
  let excludedUnverifiable = 0;
  for (const s of summaries) {
    if (!s.workspace) {
      excludedUnverifiable++;
      continue;
    }
    let key: string;
    try {
      key = keyOf(s.workspace);
    } catch {
      excludedUnverifiable++;
      continue;
    }
    if (key === currentKey) kept.push(s);
  }
  return { kept, excludedUnverifiable };
}

export function sessionListRecord(
  summaries: SessionSummary[],
  scope?: SessionScopeInfo,
  archivedHidden = 0,
): SessionListRecord {
  const corrupt = summaries.filter((s) => s.corrupt).length;
  return {
    schema: SESSIONS_SCHEMA,
    v: SESSIONS_VERSION,
    total: summaries.length,
    resumable: summaries.length - corrupt,
    corrupt,
    pinned: summaries.filter((s) => s.pinned).length,
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
      locked: s.locked,
      ...(s.locked ? { lockPid: s.lockPid, lockStale: s.lockStale } : {}),
      ...(s.archived ? { archived: true } : {}),
      ...(s.pinned
        ? { pinned: true, ...(s.pinnedAt !== undefined ? { pinnedAt: s.pinnedAt } : {}) }
        : {}),
      ...(s.noteCount > 0 ? { noteCount: s.noteCount } : {}),
    })),
    ...(scope !== undefined
      ? {
          scopedWorkspace: redactPath(scope.workspace),
          excludedUnverifiable: scope.excludedUnverifiable,
        }
      : {}),
    ...(archivedHidden > 0 ? { archivedHidden } : {}),
  };
}

export function formatSessionList(
  summaries: SessionSummary[],
  scope?: SessionScopeInfo,
  archivedHidden = 0,
): string {
  const lines: string[] = [];
  lines.push("Sessions");
  if (scope !== undefined) {
    lines.push(`Scoped to workspace: ${redactPath(scope.workspace)}`);
  }
  lines.push("─".repeat(40));

  if (summaries.length === 0) {
    lines.push("");
    lines.push("No resumable sessions found.");
    if (scope !== undefined && scope.excludedUnverifiable > 0) {
      lines.push(
        `(${scope.excludedUnverifiable} session(s) excluded: workspace unverifiable)`,
      );
    }
    if (archivedHidden > 0) {
      lines.push(
        `(${archivedHidden} archived session(s) hidden — use --include-archived to see them)`,
      );
    }
    return lines.join("\n");
  }

  lines.push("");
  for (const s of summaries) lines.push(...formatSessionLines(s));

  const corrupt = summaries.filter((s) => s.corrupt).length;
  const excluded =
    scope !== undefined
      ? `, ${scope.excludedUnverifiable} excluded (workspace unverifiable)`
      : "";
  const hidden =
    archivedHidden > 0
      ? `\n${archivedHidden} archived session(s) hidden — use --include-archived to see them`
      : "";
  lines.push("");
  lines.push(
    `Summary: ${summaries.length - corrupt} resumable, ${corrupt} corrupt ` +
      `(${summaries.length} total${excluded})${hidden}`,
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
  // Archived sessions are shown only via --include-archived (Issue #598);
  // flag them so the inclusion is never mistaken for active discovery.
  const archivedFlag = s.archived ? "  (archived)" : "";
  // Pinned sessions are flagged where they render (Issue #610); their
  // top-of-list position comes from orderSummariesPinnedFirst.
  const pinnedFlag = s.pinned ? "  (pinned)" : "";
  // Durable notes presence (Issue #624): counts only, never content.
  const notesFlag =
    s.noteCount > 0 ? `  (${s.noteCount} note${s.noteCount === 1 ? "" : "s"})` : "";
  // Advisory lock state (Issue #793): marks a session another process holds,
  // distinguishing a live holder from a stale lock (the next open self-heals).
  const lockedFlag = s.locked
    ? s.lockStale
      ? `  (locked by pid ${s.lockPid} — stale)`
      : `  (locked by pid ${s.lockPid})`
    : "";
  // The user-owned name (#249) renders next to the id (Issue #530), redacted
  // exactly like the picker renders it — so the discovery surface and the
  // resume surfaces agree.
  const namePart = s.name ? `  "${redact(s.name)}"` : "";
  const head = `  ${symbol} ${s.id}${namePart}${flag}${archivedFlag}${pinnedFlag}${notesFlag}${lockedFlag}`;
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
