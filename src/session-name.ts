// User-owned session names (#249).
//
// Generated session IDs and mutable goal text are poor durable identifiers as
// session history grows. This module defines the small, documented contract for
// a user-owned name: how an arbitrary input is normalized (trimmed; empty clears
// the override; control characters, terminal escapes, secret-like content, and
// overlong values are rejected), and how a session's display title is chosen
// (explicit name first, then goal title, then a neutral ID label). Storage lives
// in the SessionStore name sidecar; names are local metadata, never inferred
// from transcript content, and exact session IDs remain the authority (a name is
// never a unique selector and never causes fuzzy resume fallback).

import { redactSecrets } from "./permission-impact.js";

// Bound a user-owned name so it cannot flood the rows it appears in (list,
// browser, resume confirmation, export header).
export const MAX_SESSION_NAME_LENGTH = 80;

export type SessionNameNormalization =
  | { ok: true; name: string | null } // null ⇒ clear the override
  | { ok: false; reason: string };

// Normalize a user-supplied session name per the documented contract:
//   - empty / whitespace-only ⇒ clear the override (name = null);
//   - control characters or terminal escapes ⇒ rejected (cannot spoof the TTY);
//   - secret-like content ⇒ rejected (a name is displayed/exported verbatim);
//   - longer than MAX_SESSION_NAME_LENGTH ⇒ rejected.
// Otherwise the trimmed name is returned. Never throws.
export function normalizeSessionName(input: string): SessionNameNormalization {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, name: null };
  // C0 control characters (incl. ESC \u001b) and DEL — no terminal spoofing.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "session names cannot contain control characters or terminal escapes" };
  }
  if (redactSecrets(trimmed).text !== trimmed) {
    return { ok: false, reason: "session names cannot contain secret-like content" };
  }
  if (Array.from(trimmed).length > MAX_SESSION_NAME_LENGTH) {
    return { ok: false, reason: `session name exceeds ${MAX_SESSION_NAME_LENGTH} characters` };
  }
  return { ok: true, name: trimmed };
}

// Display-title precedence for a session: the explicit user-owned name wins, then
// the (redacted) goal title, then a neutral "Session <shortId>" label. Inputs are
// expected to be already redacted by their producers; the result is a single line.
export function sessionDisplayTitle(opts: {
  name?: string | null;
  goalTitle?: string | null;
  shortId: string;
}): string {
  if (opts.name && opts.name.trim()) return opts.name;
  if (opts.goalTitle && opts.goalTitle.trim()) return opts.goalTitle;
  return `Session ${opts.shortId}`;
}
