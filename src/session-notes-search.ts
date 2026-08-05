// Cross-session note search (Issue #606).
//
// The notes ledger (#602) is per-session; nothing searched across ledgers,
// so commentary left behind ("why this matters", "pick up here") was only
// findable by opening each session. This module scans every session's notes
// ledger for a case-insensitive substring and reports where it appears —
// session, note timestamp, and a redacted snippet.
//
// Conventions mirror transcript search (#594): bounded matches per session
// and overall with truthful elision counts, redacted rendering (notes are
// already redacted at persistence; re-redaction is defense in depth), a
// versioned record, and strictly read-only behavior. Two deliberate
// semantics: notes are integrity-agnostic, so corrupt sessions' notes ARE
// searchable (the ledger is independent of transcript health); archived
// sessions are SKIPPED, consistent with discovery semantics elsewhere.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { readSessionNotes, notesPath } from "./session-notes.js";
import { workspaceTrustKey } from "./folder-trust.js";

export const SESSION_NOTES_SEARCH_SCHEMA = "oh-my-cli.session-notes-search" as const;
export const SESSION_NOTES_SEARCH_VERSION = 1 as const;
/** Bound on matches kept per session before elision. */
export const NOTES_SEARCH_MAX_MATCHES_PER_SESSION = 5;
/** Bound on matches kept across the whole scan before elision. */
export const NOTES_SEARCH_MAX_MATCHES_TOTAL = 100;

export interface SessionNotesSearchMatch {
  sessionId: string;
  /** Redacted user-owned session name; omitted when unset. */
  sessionName?: string;
  /** ISO timestamp of the matching note. */
  at: string;
  /** Re-redacted note text snippet. */
  snippet: string;
}

export interface SessionNotesSearchRecord {
  schema: typeof SESSION_NOTES_SEARCH_SCHEMA;
  v: typeof SESSION_NOTES_SEARCH_VERSION;
  /** The search text, redacted. */
  query: string;
  /** Note ledgers read (sessions with a notes sidecar, archived excluded). */
  ledgersScanned: number;
  matches: SessionNotesSearchMatch[];
  /** Matches dropped by the per-session bound. */
  elidedPerSession: number;
  /** Matches dropped by the overall bound. */
  elidedTotal: number;
  /** Present only when a workspace scope was active (Issue #628); redacted. */
  scopedWorkspace?: string;
}

// An active workspace scope for the scan (Issue #628, mirroring transcript
// search's #596 scope shape): ledgers are scanned only for sessions whose
// declared workspace collapses to `workspaceKey`. `keyOf` is injectable for
// deterministic tests; it defaults to the folder-trust workspace key.
export interface SessionNotesSearchScope {
  workspaceKey: string;
  workspacePath: string;
  keyOf?: (workspacePath: string) => string;
}

function redactWorkspacePath(p: string): string {
  return redactSecrets(redactHomePath(p)).text;
}

// Scan the store for a case-insensitive substring across every session's
// notes ledger. Deterministic order: sessions by id, notes newest-first (the
// ledger's own order). Read-only — the store is never mutated. With a scope
// (Issue #628), only ledgers of sessions whose declared workspace collapses
// to the scoped canonical identity are scanned; sessions without workspace
// metadata (or an uncanonicalizable one) belong to no workspace and are
// skipped.
export function searchSessionNotes(
  store: SessionStore,
  query: string,
  scope?: SessionNotesSearchScope,
): SessionNotesSearchRecord {
  const needle = query.trim().toLowerCase();
  const keyOf = scope?.keyOf ?? workspaceTrustKey;
  const matches: SessionNotesSearchMatch[] = [];
  let ledgersScanned = 0;
  let elidedPerSession = 0;
  let elidedTotal = 0;

  if (needle !== "") {
    for (const id of [...store.listIds()].sort()) {
      // Archived sessions are retired from discovery (Issue #598); note
      // search stays consistent with that semantics in both modes.
      if (store.readArchived(id) !== null) continue;
      if (scope !== undefined) {
        const declared = store.readMeta(id)?.workspace;
        if (declared === undefined || declared === "") continue;
        let key: string;
        try {
          key = keyOf(declared);
        } catch {
          continue;
        }
        if (key !== scope.workspaceKey) continue;
      }
      if (!fs.existsSync(notesPath(store, id))) continue;
      ledgersScanned++;
      const name = store.readName(id);
      const load = readSessionNotes(store, id);
      let keptThisSession = 0;
      for (const note of load.notes) {
        if (!note.text.toLowerCase().includes(needle)) continue;
        if (matches.length >= NOTES_SEARCH_MAX_MATCHES_TOTAL) {
          elidedTotal++;
          continue;
        }
        if (keptThisSession >= NOTES_SEARCH_MAX_MATCHES_PER_SESSION) {
          elidedPerSession++;
          continue;
        }
        keptThisSession++;
        matches.push({
          sessionId: id,
          ...(name !== null ? { sessionName: redactSecrets(name).text } : {}),
          at: new Date(note.at).toISOString(),
          snippet: redactSecrets(note.text).text,
        });
      }
    }
  }

  return {
    schema: SESSION_NOTES_SEARCH_SCHEMA,
    v: SESSION_NOTES_SEARCH_VERSION,
    query: redactSecrets(query.trim()).text,
    ledgersScanned,
    matches,
    elidedPerSession,
    elidedTotal,
    ...(scope !== undefined ? { scopedWorkspace: redactWorkspacePath(scope.workspacePath) } : {}),
  };
}

export function formatSessionNotesSearch(record: SessionNotesSearchRecord): string[] {
  const lines: string[] = [];
  lines.push(`Session notes search — "${record.query}"`);
  if (record.scopedWorkspace !== undefined) {
    lines.push(`Scoped to workspace: ${record.scopedWorkspace}`);
  }
  lines.push("─".repeat(40));
  lines.push("");
  lines.push(`Scanned ${record.ledgersScanned} note ledger(s).`);
  lines.push("");
  if (record.matches.length === 0) {
    lines.push("No matching notes found.");
    return lines;
  }
  for (const m of record.matches) {
    const name = m.sessionName !== undefined ? ` (${m.sessionName})` : "";
    lines.push(`${shortSessionId(m.sessionId)}${name} ${m.at} · ${m.snippet}`);
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
  return lines;
}
