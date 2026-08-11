// A bounded top-level fatal-failure boundary (#246): one safety net for uncaught
// exceptions and unhandled rejections during an active CLI run. Unexpected
// asynchronous failures otherwise let Node print a raw stack and terminate before
// the TUI restores the terminal or the headless stream emits its terminal record.
// This module normalizes and redacts the failure, lets the caller restore
// terminal state, emits exactly one headless terminal record when the protocol
// has started, and exits non-zero — without ever resuming, recursing, emitting a
// duplicate record, or leaking secrets, raw stacks, home paths, or
// terminal-control spoofing.

import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const FATAL_EXIT_CODE = 1;
// Stable runtime category for an unexpected process-level failure, carried in the
// headless terminal record so automation can attribute it without parsing prose.
export const FATAL_REASON = "internal_runtime_failure";

// Bound the user-visible detail so a huge thrown value cannot flood the output.
const MAX_FATAL_MESSAGE = 500;

// Show cursor + reset attributes + leave the alternate screen, restoring a usable
// terminal regardless of where a failure interrupted the TUI.
export const TERMINAL_RESTORE_SEQUENCE = "\x1b[?25h\x1b[0m\x1b[?1049l";

// Remove ANSI escape sequences (OSC, CSI, and other ESC Fe sequences) and stray
// C0 control characters so a thrown value cannot spoof terminal state (cursor
// moves, clears, alternate screen). Tab/newline/carriage-return are preserved for
// readability.
export function stripTerminalControl(s: string): string {
  return s
    .replace(/\x1b\][^\u0007\x1b]*(\u0007|\x1b\\)?/g, "") // OSC … (ST|BEL)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI … final
    .replace(/\x1b[@-Z\\-_]/g, "") // other two-byte ESC Fe
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); // C0 (keep \t \n \r)
}

// Normalize an arbitrary thrown value into one bounded, redacted, terminal-safe
// line. Never throws.
export function normalizeFatalError(value: unknown): string {
  let raw: string;
  if (value instanceof Error) {
    raw = value.message || value.name || "unknown error";
  } else if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const safe = redactHomePath(redactSecrets(stripTerminalControl(raw)).text).trim();
  const bounded =
    safe.length <= MAX_FATAL_MESSAGE
      ? safe
      // Issue #826: cut surrogate-safely so an emoji/astral char at the bound is
      // dropped whole rather than split into an unpaired surrogate.
      : `${safe.slice(0, safeCutEnd(safe, MAX_FATAL_MESSAGE))} …[+${safe.length - MAX_FATAL_MESSAGE} chars]`;
  return bounded || "unknown internal runtime failure";
}

export interface FatalBoundaryOptions {
  // Best-effort terminal/state restore run before termination (e.g. TUI cleanup).
  cleanup?: () => void;
  // Emits exactly one headless terminal failure record when the protocol started.
  emitTerminalRecord?: (message: string) => void;
  // Injectable exit so tests do not terminate the test process.
  exit?: (code: number) => void;
}

// Install the fatal boundary on the process. Returns an uninstall function that
// removes both handlers so repeated or embedded invocations never accumulate
// them. A reentrancy guard ensures a failure inside cleanup/emit cannot recurse
// or produce a second terminal record.
export function installFatalBoundary(opts: FatalBoundaryOptions = {}): () => void {
  let handling = false;
  const handle = (value: unknown): void => {
    if (handling) return;
    handling = true;
    const message = normalizeFatalError(value);
    try {
      opts.cleanup?.();
    } catch {
      /* cleanup failure must not recurse or mask the fatal exit */
    }
    try {
      process.stderr.write(`\nFatal runtime error: ${message}\n`);
    } catch {
      /* best-effort user-visible detail */
    }
    try {
      opts.emitTerminalRecord?.(message);
    } catch {
      /* a failed emit must not produce a duplicate record or recurse */
    }
    (opts.exit ?? process.exit)(FATAL_EXIT_CODE);
  };
  const onUncaught = (err: Error): void => handle(err);
  const onRejection = (reason: unknown): void => handle(reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onRejection);
  };
}
