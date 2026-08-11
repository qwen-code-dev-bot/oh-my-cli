// Headless read-only session transcript search (Issue #594). Session
// discovery was metadata-only: `--list-sessions --filter` (#548) and the
// interactive picker match id/name/model/workspace, never transcript
// content. This surface scans every loadable session's persisted messages
// for a case-insensitive substring and reports where it appears — session,
// message index, role, and a bounded redacted snippet — so automation can
// locate context without resuming each candidate.
//
// Strictly read-only: it reads through the existing diagnostics path and
// writes nothing. Corrupt checkpoints are skipped and counted, never fatal,
// never mutated (partial checkpoints — a torn trailing line — are scanned
// like resume does). Matches are bounded per session and in total with
// truthful elision counts so a pathological store cannot flood the output.
// Content is re-redacted at render time (defense in depth against
// hand-edited transcripts); the search text itself is never echoed
// unredacted.

import type { SessionStore, SessionMessage } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";
import { workspaceTrustKey } from "./folder-trust.js";

export const SESSION_SEARCH_SCHEMA = "oh-my-cli.session-search" as const;
export const SESSION_SEARCH_VERSION = 1 as const;

/** Bound on matches kept per session before elision. */
export const SEARCH_MAX_MATCHES_PER_SESSION = 5;
/** Bound on matches kept across the whole scan before elision. */
export const SEARCH_MAX_MATCHES_TOTAL = 100;
/** Bound on a rendered snippet (after redaction). */
const SNIPPET_MAX_CHARS = 120;
/** Context kept on each side of the match inside the raw haystack. */
const SNIPPET_CONTEXT_BEFORE = 40;
const SNIPPET_CONTEXT_AFTER = 80;

export interface SessionSearchMatch {
  sessionId: string;
  /** User-owned session name (redacted); omitted when unset. */
  sessionName?: string;
  /** 0-based index into the session's loaded transcript messages. */
  messageIndex: number;
  role: SessionMessage["role"];
  /** Redacted, bounded snippet containing the match. */
  snippet: string;
}

export interface SessionSearchRecord {
  schema: typeof SESSION_SEARCH_SCHEMA;
  v: typeof SESSION_SEARCH_VERSION;
  /** The search text, redacted. */
  query: string;
  /** Sessions whose transcript was scanned (ok + partial integrity). */
  sessionsScanned: number;
  /** Sessions skipped because their checkpoint is corrupt. */
  sessionsSkippedCorrupt: number;
  matches: SessionSearchMatch[];
  /** Matches dropped by the per-session bound. */
  elidedPerSession: number;
  /** Matches dropped by the total bound. */
  elidedTotal: number;
  // Workspace scoping (Issue #596): present only when a scope was active.
  // Names the redacted scope target and counts the sessions excluded because
  // their workspace could not be verified.
  scopedWorkspace?: string;
  excludedUnverifiable?: number;
}

// An active workspace scope for the scan (Issue #596): `workspaceKey` is the
// canonical identity sessions must match; `workspacePath` is the declared
// target (redacted at render time). `keyOf` is injectable for deterministic
// tests; it defaults to the folder-trust workspace key.
export interface SessionSearchScope {
  workspaceKey: string;
  workspacePath: string;
  keyOf?: (workspacePath: string) => string;
}

function snippetAround(haystack: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(haystack.length, index + needleLength + SNIPPET_CONTEXT_AFTER);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  const window = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(window).text;
  return redacted.length <= SNIPPET_MAX_CHARS
    ? `${prefix}${redacted}${suffix}`
    : `${prefix}${redacted.slice(0, safeCutEnd(redacted, SNIPPET_MAX_CHARS - 1))}…`;
}

// Collect every match of `needle` inside one message's searchable text:
// the message content and the non-secret attachment names (image bytes are
// never persisted, so they are never searched).
function messageMatches(
  message: SessionMessage,
  needle: string,
): Array<{ haystack: string; index: number; label: string | null }> {
  const found: Array<{ haystack: string; index: number; label: string | null }> = [];
  const content = typeof message.content === "string" ? message.content : "";
  if (content !== "") {
    const lower = content.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(needle, from);
    while (idx !== -1) {
      found.push({ haystack: content, index: idx, label: null });
      from = idx + Math.max(1, needle.length);
      idx = lower.indexOf(needle, from);
    }
  }
  for (const image of message.images ?? []) {
    if (image.name.toLowerCase().includes(needle)) {
      found.push({ haystack: image.name, index: image.name.toLowerCase().indexOf(needle), label: image.name });
    }
  }
  return found;
}

// Scan the store for a case-insensitive substring across every loadable
// session transcript. Deterministic order: sessions by id, messages by
// transcript order. Read-only — the store is never mutated. With a scope
// (Issue #596), only sessions whose declared workspace collapses to the
// scope's canonical identity are considered; sessions whose workspace cannot
// be verified are excluded and counted, and scoped corrupt sessions still
// count as skipped.
export function searchSessions(
  store: SessionStore,
  query: string,
  scope?: SessionSearchScope,
): SessionSearchRecord {
  const needle = query.trim().toLowerCase();
  const matches: SessionSearchMatch[] = [];
  let sessionsScanned = 0;
  let sessionsSkippedCorrupt = 0;
  let elidedPerSession = 0;
  let elidedTotal = 0;
  let excludedUnverifiable = 0;
  const keyOf = scope?.keyOf ?? workspaceTrustKey;

  if (needle !== "") {
    for (const id of [...store.listIds()].sort()) {
      // Archived sessions are retired from discovery (Issue #598): the scan
      // never surfaces them, though they remain resumable by exact id/name.
      if (store.readArchived(id) !== null) continue;
      const diag = store.loadWithDiagnostics(id);
      // Workspace scoping runs before integrity accounting: an unverifiable
      // workspace is excluded whether or not the checkpoint is healthy.
      if (scope !== undefined) {
        const declared = diag.meta?.workspace;
        if (declared === undefined || declared === "") {
          excludedUnverifiable++;
          continue;
        }
        let key: string;
        try {
          key = keyOf(declared);
        } catch {
          excludedUnverifiable++;
          continue;
        }
        if (key !== scope.workspaceKey) continue;
      }
      const status = store.integrity(id).status;
      if (status === "corrupt" || status === "missing") {
        if (status === "corrupt") sessionsSkippedCorrupt++;
        continue;
      }
      sessionsScanned++;
      const name = store.readName(id);
      let keptThisSession = 0;
      for (let i = 0; i < diag.messages.length; i++) {
        for (const hit of messageMatches(diag.messages[i], needle)) {
          if (matches.length >= SEARCH_MAX_MATCHES_TOTAL) {
            elidedTotal++;
            continue;
          }
          if (keptThisSession >= SEARCH_MAX_MATCHES_PER_SESSION) {
            elidedPerSession++;
            continue;
          }
          keptThisSession++;
          matches.push({
            sessionId: id,
            ...(name !== null ? { sessionName: redactSecrets(name).text } : {}),
            messageIndex: i,
            role: diag.messages[i].role,
            snippet:
              hit.label === null
                ? snippetAround(hit.haystack, hit.index, needle.length)
                : `attachment "${redactSecrets(hit.label).text}"`,
          });
        }
      }
    }
  }

  return {
    schema: SESSION_SEARCH_SCHEMA,
    v: SESSION_SEARCH_VERSION,
    query: redactSecrets(query.trim()).text,
    sessionsScanned,
    sessionsSkippedCorrupt,
    matches,
    elidedPerSession,
    elidedTotal,
    ...(scope !== undefined
      ? {
          scopedWorkspace: redactWorkspacePath(scope.workspacePath),
          excludedUnverifiable,
        }
      : {}),
  };
}

// Collapse the home prefix for display, matching the sibling list surface.
function redactWorkspacePath(p: string): string {
  return redactSecrets(redactHomePath(p)).text;
}

export function formatSessionSearch(record: SessionSearchRecord): string {
  const lines: string[] = [];
  lines.push(`Session search — "${record.query}"`);
  if (record.scopedWorkspace !== undefined) {
    lines.push(`Scoped to workspace: ${record.scopedWorkspace}`);
  }
  lines.push("─".repeat(40));
  lines.push("");
  const excluded =
    record.excludedUnverifiable !== undefined && record.excludedUnverifiable > 0
      ? `, excluded ${record.excludedUnverifiable} (workspace unverifiable)`
      : "";
  lines.push(
    `Scanned ${record.sessionsScanned} session(s)` +
      (record.sessionsSkippedCorrupt > 0
        ? `, skipped ${record.sessionsSkippedCorrupt} corrupt`
        : "") +
      excluded +
      ".",
  );
  lines.push("");
  if (record.matches.length === 0) {
    lines.push("No matches found.");
    return lines.join("\n");
  }
  for (const m of record.matches) {
    const name = m.sessionName !== undefined ? ` (${m.sessionName})` : "";
    lines.push(
      `${shortSessionId(m.sessionId)}${name} message #${m.messageIndex} (${m.role}): ${m.snippet}`,
    );
  }
  let tail = `${record.matches.length} match(es).`;
  if (record.elidedPerSession > 0 || record.elidedTotal > 0) {
    const parts: string[] = [];
    if (record.elidedPerSession > 0) parts.push(`+${record.elidedPerSession} elided per-session`);
    if (record.elidedTotal > 0) parts.push(`+${record.elidedTotal} elided overall`);
    tail += ` (${parts.join(", ")})`;
  }
  lines.push("");
  lines.push(tail);
  return lines.join("\n");
}
