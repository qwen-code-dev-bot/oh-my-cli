// Bounded stdin reading for the argument+pipe combination (Issue #761).
// A prompt argument with piped stdin combines them — but an OPEN-BUT-SILENT
// stdin pipe (a spawner that neither writes nor closes, e.g. child_process
// defaults) must not hang the turn, so the reader waits for the first chunk
// or EOF only within a bounded window: real pipelines deliver promptly (the
// writer starts before the CLI boots), while silent pipes fall through to
// argument-only. The window is a documented behavior boundary, not a guess
// at intent: valueless `-p` (stdin IS the prompt) still drains without any
// timeout, per ordinary pipe semantics.
import type { Readable } from "node:stream";

export const STDIN_SILENCE_TIMEOUT_MS = 250;

// Resolves with the drained stdin text once the stream ends, or null when
// the stream stays silent for the whole window. Never rejects: a read error
// is treated as silence (the argument stands alone rather than the turn
// dying on a flaky pipe).
export function readStdinWithSilenceTimeout(
  stream: Readable,
  timeoutMs: number = STDIN_SILENCE_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      try {
        stream.pause();
      } catch {
        /* not pausable — nothing to leak */
      }
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (): void => {
      onEnd();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, timeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    try {
      stream.resume();
    } catch {
      /* not resumable — the timer still settles the promise */
    }
  });
}
