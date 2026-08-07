// Ctrl+L screen handling for the readline surface (Issue #745). Node's
// readline has no Ctrl+L support: it inserts a literal form feed (\f) into
// the line buffer at the cursor and never touches the screen — so on the
// TERM=dumb surface the universal "clear and redraw" keystroke silently
// pollutes the user's prompt. The readline tap snapshots the line before
// readline consumes the byte; after readline processes it, the insertion is
// repaired (verified shape only) and, at the idle prompt, the visible screen
// is cleared and the prompt line redrawn, matching bash/zsh/the node REPL.

// Same sequence the /clear command and the full-screen shell use: clear the
// visible screen and home the cursor. The scrollback is preserved, like
// bash's Ctrl+L.
export const CLEAR_SCREEN_SEQUENCE = "\x1b[2J\x1b[H";

export interface ReadlineLineState {
  line: string;
  cursor: number;
}

// readline consumed a lone Ctrl+L byte and did what it always does: inserted
// one \f at the tap-time cursor and advanced the cursor over it. Verify that
// exact shape and return the repaired (pre-keypress) state; when reality
// diverges return null so the caller fails closed and never touches an
// unknown buffer. The byte having never reached the buffer (e.g. a future
// Node handling Ctrl+L natively) is reported as-is — nothing to repair.
export function repairCtrlLInsertion(
  snapshot: ReadlineLineState,
  actual: ReadlineLineState,
): ReadlineLineState | null {
  if (actual.line === snapshot.line && actual.cursor === snapshot.cursor) {
    return { line: actual.line, cursor: actual.cursor };
  }
  const expectedLine =
    snapshot.line.slice(0, snapshot.cursor) +
    "\f" +
    snapshot.line.slice(snapshot.cursor);
  if (actual.line === expectedLine && actual.cursor === snapshot.cursor + 1) {
    return { line: snapshot.line, cursor: snapshot.cursor };
  }
  return null;
}
