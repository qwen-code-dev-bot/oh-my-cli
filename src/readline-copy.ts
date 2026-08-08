// Readline-surface clipboard copy (Issue #787). The full-screen shell can
// copy via OSC 52 (the `y` key on a selected block, #200/#562); the readline
// surface — the fallback for exactly the environments where terminal-side
// selection is weakest or absent (dumb terminals, serial consoles, restricted
// SSH) — had no clipboard path at all. `/copy` closes that parity gap: it
// writes the last assistant response to the terminal clipboard via the same
// OSC 52 escape contract the TUI already trusts. Pure decision here: which
// text is the copy payload for a loaded session.

import type { SessionMessage } from "./session.js";

// The copy payload is the last assistant response with actual content,
// verbatim. A session stores a turn's streamed text as one assistant message
// whose content is the concatenated text, so copying that message copies the
// full response in order. Scans from the end so only the latest response is
// offered; an interrupted turn's preserved partial content is copyable too —
// it is text the user can already see on screen. Returns null when no
// assistant response exists yet, so the surface prints an honest message and
// writes zero escape bytes.
export function copyPayloadForMessages(
  messages: readonly SessionMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.length > 0) {
      return message.content;
    }
  }
  return null;
}
