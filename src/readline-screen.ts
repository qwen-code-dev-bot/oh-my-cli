// Control-keystroke handling for the readline surface (Issues #745, #747,
// #749, #753). Node's readline implements none of Ctrl+L (clear and
// redraw), Ctrl+W (kill the previous word), Ctrl+U (kill the line before
// the cursor), or Ctrl+A/Ctrl+E: for each it inserts the raw control byte
// (\f, 0x17, 0x15, 0x01, 0x05) into the line buffer at the cursor and
// never touches the screen — so on the TERM=dumb surface these universal
// keystrokes silently pollute the user's prompt. (Ctrl+Z suspend lives in
// the tap itself — Issue #751.) The readline tap snapshots the line before
// readline consumes the byte; after readline processes it, the insertion is
// repaired (verified shape only), and at the idle prompt the keystroke's
// real effect is applied and the line redrawn — matching bash/zsh/the node
// REPL. Exception: under TERM=dumb Node 24's readline is append-only (no
// cursor addressing at all — even Backspace is a no-op), so for Ctrl+A and
// Ctrl+E the repair itself is the whole fix: the bytes are ignored cleanly
// instead of corrupting the prompt (Issue #753, rescoping note).

// Same sequence the /clear command and the full-screen shell use: clear the
// visible screen and home the cursor. The scrollback is preserved, like
// bash's Ctrl+L.
export const CLEAR_SCREEN_SEQUENCE = "\x1b[2J\x1b[H";

export interface ReadlineLineState {
  line: string;
  cursor: number;
}

// readline consumed a lone control byte and did what it always does:
// inserted that exact character at the tap-time cursor and advanced the
// cursor over it. Verify that shape and return the repaired (pre-keypress)
// state; when reality diverges return null so the caller fails closed and
// never touches an unknown buffer. The byte having never reached the buffer
// (e.g. a future Node handling the keystroke natively) is reported as-is —
// nothing to repair.
export function repairControlCharInsertion(
  snapshot: ReadlineLineState,
  actual: ReadlineLineState,
  ch: string,
): ReadlineLineState | null {
  if (actual.line === snapshot.line && actual.cursor === snapshot.cursor) {
    return { line: actual.line, cursor: actual.cursor };
  }
  const expectedLine =
    snapshot.line.slice(0, snapshot.cursor) + ch + snapshot.line.slice(snapshot.cursor);
  if (actual.line === expectedLine && actual.cursor === snapshot.cursor + 1) {
    return { line: snapshot.line, cursor: snapshot.cursor };
  }
  return null;
}

// bash's default word-kill (unix-word-rubout): kill the text behind the
// cursor back to the previous whitespace boundary, skipping any whitespace
// run immediately before the cursor first. So "hello world|" -> "hello "
// and "hello   |" -> "" — one press removes the whitespace run plus the
// word it trails. No boundary means kill to line start; at line start the
// state is unchanged. Whitespace after the cursor is never touched.
export function wordKillBefore(state: ReadlineLineState): ReadlineLineState {
  const { line, cursor } = state;
  let start = cursor;
  while (start > 0 && /^\s$/.test(line[start - 1])) start--;
  while (start > 0 && !/^\s$/.test(line[start - 1])) start--;
  return { line: line.slice(0, start) + line.slice(cursor), cursor: start };
}

// bash's default line-kill (unix-line-discard): kill everything between the
// start of the line and the cursor; the text from the cursor onward survives
// verbatim and the cursor lands at column 0. So "abc def|" -> "", and with
// the cursor after "abc" the tail " def" is preserved. At line start the
// state is unchanged.
export function lineKillBefore(state: ReadlineLineState): ReadlineLineState {
  const { line, cursor } = state;
  return { line: line.slice(cursor), cursor: 0 };
}
