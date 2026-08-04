// Session fork (Issue #592).
//
// Branch a healthy session into a fresh, independently resumable session:
// the source transcript is copied verbatim, meta inherits the source's
// model/profile/workspace with `forkedFrom` provenance and a fresh createdAt,
// and the source's durable Goal checkpoint (when present) is copied
// byte-for-byte so the fork continues the mission. The source is read-only
// throughout — never mutated, never deleted. Workspace-mutation provenance
// (turn checkpoints, shell-failure receipts, compaction sidecars) stays with
// the source: those ledgers describe what the source's history did to the
// workspace, and the fork starts with its own clean ledger. Corrupt or
// missing sources are refused fail-closed before any write, so a failed fork
// never leaves a partial new session.

import fs from "node:fs";
import type { SessionStore, SessionMeta } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";

export const SESSION_FORK_SCHEMA = "oh-my-cli.session-fork" as const;
export const SESSION_FORK_VERSION = 1 as const;

export interface ForkResult {
  ok: boolean;
  newSessionId?: string;
  forkedMessages?: number;
  // True when the source carried a durable Goal sidecar and it was copied.
  forkedGoal?: boolean;
  reason?: string;
}

// Versioned record for `--fork-session --output json`. Metadata only: session
// ids, counts, and provenance — never transcript content.
export interface SessionForkRecord {
  schema: typeof SESSION_FORK_SCHEMA;
  v: typeof SESSION_FORK_VERSION;
  sourceSessionId: string;
  newSessionId: string;
  forkedMessages: number;
  forkedGoal: boolean;
  // The user-owned name given to the fork, or null when unnamed.
  name: string | null;
}

// Resolve a `--fork-session` target by exact id or user-owned name WITHOUT
// the heal step resume resolution performs: healing quarantines a corrupt
// checkpoint aside, and a fork refusal must leave the source exactly as it
// was. Corrupt sources resolve here so forkSession can refuse them with an
// actionable reason; ambiguous name matches fail closed.
export function resolveForkTarget(
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
      reason: `${matches.length} sessions are named "${display}"; fork by exact session id (${shorts})`,
    };
  }
  return { ok: false, reason: `no session named "${display}" was found` };
}

export function forkSession(store: SessionStore, id: string): ForkResult {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  if (integrity.status !== "ok") {
    const detail =
      integrity.status === "corrupt"
        ? "is corrupt and cannot be forked safely (see --salvage-session for the recoverable prefix)"
        : `is ${integrity.status} and cannot be forked cleanly; resume it first to heal it`;
    return { ok: false, reason: `session ${shortSessionId(id)} ${detail}` };
  }
  const diag = store.loadWithDiagnostics(id);
  if (diag.badLines > 0) {
    // Defensive: integrity already judged the checkpoint healthy, so any bad
    // line here would be an invariant violation — fail closed rather than
    // fork a transcript we cannot fully account for.
    return {
      ok: false,
      reason: `session ${shortSessionId(id)} could not be read cleanly; refusing to fork`,
    };
  }
  const newId = store.newId();
  const source = store.readMeta(id);
  const meta: Omit<SessionMeta, "meta"> = {
    ...(source
      ? {
          ...(source.model !== undefined ? { model: source.model } : {}),
          ...(source.profile !== undefined ? { profile: source.profile } : {}),
          ...(source.workspace !== undefined ? { workspace: source.workspace } : {}),
        }
      : {}),
    // A fork declares its own timeline: fresh createdAt, provenance recorded.
    createdAt: Date.now(),
    forkedFrom: id,
  };
  // Atomic single-write checkpoint: meta + transcript, verbatim messages.
  store.checkpoint(newId, diag.messages, meta);
  // Continue the mission: copy the source's durable Goal sidecar byte-for-byte
  // when present (an absent sidecar means no goal; bytes are preserved exactly
  // as the source holds them, so the fork reads goals exactly as the source
  // does).
  let forkedGoal = false;
  const goalSource = store.goalPath(id);
  if (fs.existsSync(goalSource)) {
    const raw = fs.readFileSync(goalSource, "utf-8");
    const target = store.goalPath(newId);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, raw, "utf-8");
    fs.renameSync(temp, target);
    forkedGoal = true;
  }
  return {
    ok: true,
    newSessionId: newId,
    forkedMessages: diag.messages.length,
    forkedGoal,
  };
}
