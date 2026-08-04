// Salvage of corrupt sessions (Issue #546).
//
// A checkpoint damaged by a bad line loses nothing that still parses:
// loadWithDiagnostics returns every parseable message (before and after the
// damage) with the bad lines counted. Salvage copies those messages verbatim
// into a fresh session (recorded provenance) so the work stays resumable.
// The source session is read-only throughout — never mutated, never deleted —
// and the existing quarantine behavior of recover() is untouched. Messages
// are copied verbatim: no fabrication, no mutation of content. A trailing
// torn line is "partial" (already resumable via --resume), not corrupt, and
// refuses salvage.

import type { SessionStore, SessionMeta } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";

export interface SalvageResult {
  ok: boolean;
  newSessionId?: string;
  salvagedMessages?: number;
  skippedLines?: number;
  reason?: string;
}

// Resolve a `--salvage-session` target by exact id or user-owned name WITHOUT
// the heal step resume resolution performs: healing quarantines a corrupt
// checkpoint aside, which is exactly the file salvage must read. Corrupt
// matches are the targets here, so name resolution prefers them; ambiguous
// corrupt matches fail closed, and names matching only healthy sessions are
// refused with an actionable reason (salvageSession applies the same refusals
// for id targets).
export function resolveSalvageTarget(
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
  const corruptMatches: string[] = [];
  const healthyMatches: string[] = [];
  for (const id of store.listIds()) {
    const stored = store.readName(id);
    if (stored === null || stored.trim() !== raw) continue;
    if (store.integrity(id).status === "corrupt") corruptMatches.push(id);
    else healthyMatches.push(id);
  }
  if (corruptMatches.length === 1) {
    return { ok: true, sessionId: corruptMatches[0] };
  }
  if (corruptMatches.length > 1) {
    const shorts = corruptMatches.map((id) => shortSessionId(id)).join(", ");
    return {
      ok: false,
      reason: `${corruptMatches.length} corrupt sessions are named "${display}"; salvage by exact session id (${shorts})`,
    };
  }
  if (healthyMatches.length > 0) {
    return {
      ok: false,
      reason: `session ${shortSessionId(healthyMatches[0])} is not corrupt; nothing to salvage (use --resume)`,
    };
  }
  return { ok: false, reason: `no session named "${display}" was found` };
}

export function salvageSession(store: SessionStore, id: string): SalvageResult {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  if (integrity.status !== "corrupt") {
    return {
      ok: false,
      reason: `session ${shortSessionId(id)} is ${integrity.status}; nothing to salvage (use --resume)`,
    };
  }
  const diag = store.loadWithDiagnostics(id);
  if (diag.messages.length === 0) {
    return {
      ok: false,
      reason: `session ${shortSessionId(id)} has no recoverable content`,
    };
  }
  const newId = store.newId();
  const source = diag.meta;
  const meta: Omit<SessionMeta, "meta"> = {
    ...(source
      ? {
          ...(source.model !== undefined ? { model: source.model } : {}),
          ...(source.profile !== undefined ? { profile: source.profile } : {}),
          ...(source.workspace !== undefined ? { workspace: source.workspace } : {}),
          createdAt: source.createdAt,
        }
      : { createdAt: Date.now() }),
    salvagedFrom: id,
  };
  store.checkpoint(newId, diag.messages, meta);
  return {
    ok: true,
    newSessionId: newId,
    salvagedMessages: diag.messages.length,
    skippedLines: diag.badLines,
  };
}
