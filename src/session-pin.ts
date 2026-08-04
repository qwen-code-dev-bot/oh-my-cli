// Session pinning (Issue #610).
//
// Discovery is recency-ordered, which buries old-but-important sessions
// under yesterday's scratch work. Pinning separates "newest" from
// "important": a durable marker elevates a session to the top of the
// listing regardless of age.
//
// The marker follows the archive-marker conventions (#598): a distinct
// extension outside listIds(), integrity-agnostic metadata (corrupt
// sessions are pinnable), atomic temp+rename writes, heal-free resolution
// at the call site, and idempotent re-pinning that preserves the original
// timestamp. Pinning is metadata-only: transcript and every other sidecar
// are never touched. Archive visibility prevails over pinning — a pinned
// archived session stays hidden without --include-archived.

import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";

export interface PinOutcome {
  ok: boolean;
  reason?: string;
  /** Epoch ms of the pin (the original timestamp on an idempotent re-pin). */
  pinnedAt?: number;
  /** True when the session was already pinned (the marker was preserved). */
  alreadyPinned?: boolean;
  /** True when unpinning a session that was not pinned. */
  alreadyUnpinned?: boolean;
}

export function pinSession(
  store: SessionStore,
  id: string,
  now: number = Date.now(),
): PinOutcome {
  if (store.integrity(id).status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  const existing = store.readPinned(id);
  if (existing !== null) {
    return { ok: true, pinnedAt: existing.at, alreadyPinned: true };
  }
  store.writePinned(id, now);
  return { ok: true, pinnedAt: now, alreadyPinned: false };
}

export function unpinSession(store: SessionStore, id: string): PinOutcome {
  if (store.integrity(id).status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  if (store.readPinned(id) === null) {
    return { ok: true, alreadyUnpinned: true };
  }
  store.clearPinned(id);
  return { ok: true, alreadyUnpinned: false };
}
