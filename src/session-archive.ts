// Session retirement (Issue #598): archive a session out of discovery
// without destroying it.
//
// The archive state is a durable, integrity-agnostic sidecar marker — the
// same convention as the user-owned name sidecar (#249/#530): a distinct
// extension outside listIds(), so it works on corrupt sessions and never
// touches transcript, meta, goal, or name bytes. Archived sessions disappear
// from the discovery surfaces (listing, search, --continue selection, the
// interactive picker) but remain fully resumable by exact id or name —
// archiving never blocks --resume. Re-archiving is idempotent and preserves
// the original timestamp; unarchiving removes the marker and is a no-op on a
// session that is not archived.

import type { SessionStore } from "./session.js";
import { shortSessionId, sessionIdsWithPrefix } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";

export interface ArchiveOutcome {
  ok: boolean;
  sessionId?: string;
  // Epoch ms when the session was archived (the original timestamp on an
  // idempotent re-archive).
  archivedAt?: number;
  // True when the session was already archived (the marker was preserved).
  alreadyArchived?: boolean;
  // True when unarchiving a session that was not archived.
  alreadyUnarchived?: boolean;
  reason?: string;
}

export function archiveSession(
  store: SessionStore,
  id: string,
  now: number = Date.now(),
): ArchiveOutcome {
  if (store.integrity(id).status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  const existing = store.readArchived(id);
  if (existing !== null) {
    return { ok: true, sessionId: id, archivedAt: existing.at, alreadyArchived: true };
  }
  store.writeArchived(id, now);
  return { ok: true, sessionId: id, archivedAt: now, alreadyArchived: false };
}

export function unarchiveSession(store: SessionStore, id: string): ArchiveOutcome {
  if (store.integrity(id).status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  if (store.readArchived(id) === null) {
    return { ok: true, sessionId: id, alreadyUnarchived: true };
  }
  store.clearArchived(id);
  return { ok: true, sessionId: id, alreadyUnarchived: false };
}

// Resolve a `--archive-session` / `--unarchive-session` target by exact id or
// user-owned name WITHOUT the heal step resume resolution performs: healing
// quarantines a corrupt checkpoint aside, and archiving is metadata-only — it
// must never mutate its target. Corrupt sessions are valid archive targets,
// so they resolve here exactly like healthy ones; ambiguous name matches fail
// closed. The unambiguous id-prefix tier (Issue #771) matches the picker's
// contract — the archive flow itself prints the short id and tells users to
// restore with it — with the same corrupt-is-valid semantics.
export function resolveArchiveTarget(
  value: string,
  store: SessionStore,
): { ok: true; sessionId: string } | { ok: false; reason: string } {
  const raw = value.trim();
  const display = redactSecrets(raw).text;
  if (!raw) {
    return { ok: false, reason: `no session named "${display}" was found` };
  }
  // Exact id first — no heal side effects.
  if (store.integrity(raw).status !== "missing") {
    return { ok: true, sessionId: raw };
  }
  const matches: string[] = [];
  for (const id of store.listIds()) {
    const stored = store.readName(id);
    if (stored !== null && stored.trim() === raw) matches.push(id);
  }
  if (matches.length === 1) {
    return { ok: true, sessionId: matches[0] };
  }
  if (matches.length > 1) {
    const shorts = matches.map((id) => shortSessionId(id)).join(", ");
    return {
      ok: false,
      reason: `${matches.length} sessions are named "${display}"; resolve by exact session id (${shorts})`,
    };
  }
  // Id-prefix tier (Issue #771), mirroring the exact-id tier above: a
  // session whose transcript is missing cannot be targeted, while corrupt
  // transcripts remain archive-valid metadata targets.
  const prefixMatches = sessionIdsWithPrefix(raw, store).filter(
    (id) => store.integrity(id).status !== "missing",
  );
  if (prefixMatches.length === 1) {
    return { ok: true, sessionId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    const shorts = prefixMatches.map((id) => shortSessionId(id)).join(", ");
    return {
      ok: false,
      reason: `${prefixMatches.length} sessions match the id prefix "${display}"; resolve by exact session id (${shorts})`,
    };
  }
  return { ok: false, reason: `no session named "${display}" was found` };
}
