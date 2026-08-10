// Resume orientation for the readline surface (Issue #737). The full-screen
// shell seeds a visible transcript summary on resume; the line-oriented
// fallback showed only the session id, leaving the user no idea where they
// left off. One bounded, read-only line built from the already-loaded
// session messages: message count plus a single-line excerpt of the last
// user prompt. No storage, no provider calls, no transcript mutation.

import { safeCutEnd } from "./text-cut.js";

export const ORIENTATION_EXCERPT_CHARS = 80;

export interface OrientationMessage {
  role: string;
  content?: string | null;
}

// Flatten whitespace (multi-line prompts become one line) and bound the
// excerpt; overlong excerpts end in a single ellipsis with no trailing
// whitespace before it.
export function excerptOneLine(text: string, maxChars: number = ORIENTATION_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, safeCutEnd(flat, maxChars - 1)).replace(/\s+$/, "")}…`;
}

// Returns the orientation line for a resumed session. Always a string: an
// empty session says so honestly, a session without user prompts says that.
// The caller decides WHEN to print it (only on resume paths — fresh sessions
// print nothing).
export function readlineOrientationLine(messages: ReadonlyArray<OrientationMessage>): string {
  if (messages.length === 0) {
    return "Resumed session: no messages yet";
  }
  let lastUserPrompt: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.trim() !== "") {
      lastUserPrompt = m.content;
      break;
    }
  }
  const noun = messages.length === 1 ? "message" : "messages";
  if (lastUserPrompt === null) {
    return `Resumed session: ${messages.length} ${noun} · no user prompts yet`;
  }
  return `Resumed session: ${messages.length} ${noun} · last: "${excerptOneLine(lastUserPrompt)}"`;
}
