// Terminal bell on turn completion (Issue #783). An opt-in attention
// signal: exactly one BEL byte when a turn completes normally and control
// returns to the user, so a user who switched away during a long turn can
// hear/see that the response is ready. The terminal maps BEL to sound or a
// visual highlight per its own configuration; the CLI only emits the byte,
// never configures the bell. Behavior-level precedent: trusted coding CLIs
// treat "the response is ready" as a ring-the-bell moment (aider ships
// --notifications for exactly this). Pure decisions here; each surface owns
// the actual write on its own output stream.

// The single control byte every terminal maps to its configured bell.
export const TURN_BELL_BYTE = "\x07";

// Ring only when the user opted in (--bell) AND the turn completed
// normally. Cancelled, interrupted, and failed turns stay silent — the
// signal means "your response is ready", never "something happened".
export function shouldRingTurnBell(
  bellFlag: boolean | undefined,
  turnOk: boolean,
): boolean {
  return bellFlag === true && turnOk;
}

// Write exactly one BEL through the caller-provided write function.
export function ringTurnBell(write: (chunk: string) => void): void {
  write(TURN_BELL_BYTE);
}
