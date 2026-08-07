// Control-keystroke handling for the readline surface (Issues #745, #747,
// #749, #753, #755). Node's readline implements none of Ctrl+L (clear and
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
// instead of corrupting the prompt (Issue #753, rescoping note). The same
// repair-only treatment is swept across every remaining unhandled control
// byte, so no control keystroke can corrupt a prompt or submission (Issue
// #755).

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

// The control bytes the readline surface does NOT sweep (Issue #755): the
// six effect bytes owned by #745-#753, plus the bytes other machinery owns
// outright — readline's interface SIGINT (0x03, #743 cooperative cancel),
// submission (0x0a/0x0d), the command palette's raw tap (0x0b, #717), and
// escape-sequence prefixes (0x1b). Tab (0x09) IS swept: this surface wires
// no completer, so dumb-mode readline just inserts a literal tab and
// pollutes submissions like any other unhandled byte (verified by probe).
// Every swept byte has no effect beyond pollution, so the tap repairs its
// insertion and nothing else.
export function isSweptControlByte(byte: number): boolean {
  if (byte >= 0x20) return false;
  switch (byte) {
    case 0x01: // Ctrl+A — ignored cleanly (#753)
    case 0x03: // Ctrl+C — readline emits the interface SIGINT (#743)
    case 0x05: // Ctrl+E — ignored cleanly (#753)
    case 0x0a: // Enter — submission
    case 0x0b: // Ctrl+K — command palette's raw tap (#717)
    case 0x0c: // Ctrl+L — screen clear (#745)
    case 0x0d: // Enter — submission
    case 0x15: // Ctrl+U — line kill (#749)
    case 0x17: // Ctrl+W — word kill (#747)
    case 0x1a: // Ctrl+Z — suspend (#751)
    case 0x1b: // escape-sequence prefix
      return false;
  }
  return true;
}

// Ctrl+K is owned by the palette's raw tap (#717), so the sweep leaves the
// byte alone — but dumb-mode readline still appends a raw 0x0b to the
// pending question's buffer when the key arrives, and that pollution breaks
// every palette answer typed from a non-empty line (Issue #757). Remove one
// trailing palette byte — the exact shape readline appends — and nothing
// else; a 0x0b anywhere else in the line is the user's own content.
export function stripInsertedPaletteByte(line: string): string {
  return line.endsWith("\u000b") ? line.slice(0, -1) : line;
}
