// The interactive /compact command (Issue #719): exposes the headless
// compaction mechanics (#88) inside the shell for the CURRENT session. The
// mechanics are reused exactly — deterministic compactMessages, atomic
// sidecar write, digest-validated application by loadSessionMessages — so a
// sidecar written interactively is indistinguishable from one written by
// --compact. The on-disk transcript is never touched. Store access is
// injected so the report/decision contract is unit-testable without a
// session store on disk.

import { compactMessages, formatCompaction } from "./compaction.js";
import type { CompactionSummary } from "./compaction.js";
import type { SessionMessage } from "./session.js";

// The interactive command targets the current session only; other sessions
// stay the job of the headless flag.
export const COMPACT_ARGS_REJECTION =
  "/compact takes no arguments — it compacts the current session. " +
  "Use headless --compact <id-or-name> to target another session.";

// Reject arguments honestly before anything touches the store. Returns the
// rejection notice, or null when the command may run.
export function rejectCompactArgs(args: string): string | null {
  return args.trim() === "" ? null : COMPACT_ARGS_REJECTION;
}

// When the summary takes effect: from the next turn's context of this
// session (loadSessionMessages applies the validated sidecar per load) and
// from the next --resume. The notice never claims the transcript changed.
export const COMPACT_APPLIES_LINE =
  "Transcript untouched; the summary applies from the next turn and the next --resume.";

export interface CompactCommandIO {
  load(sessionId: string): SessionMessage[];
  save(sessionId: string, summary: CompactionSummary): void;
}

export function compactCurrentSession(sessionId: string, io: CompactCommandIO): string {
  try {
    const full = io.load(sessionId);
    if (full.length === 0) {
      return "Nothing to compact: the current session has no messages yet.";
    }
    const { summary } = compactMessages(full);
    io.save(sessionId, summary);
    return `${formatCompaction(summary)}\n${COMPACT_APPLIES_LINE}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // The sidecar write is atomic (temp + rename): a failure leaves any
    // previous sidecar intact and the transcript untouched.
    return `Compaction failed: ${msg}. The transcript and any previous sidecar are unchanged.`;
  }
}
