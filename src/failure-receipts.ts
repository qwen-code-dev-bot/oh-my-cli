// Bounded, redacted failure receipts for shell tool executions (Issue #574,
// roadmap #283's evidence-capture step). When a shell command ends non-zero,
// is killed, or times out, a receipt is appended to the session's
// `<id>.failures.json` sidecar: redacted command summary, exit state, bounded
// redacted output tails, cwd, git head at failure, timestamp, and a
// per-session sequence number. Successful runs write nothing. Receipts are
// evidence for starting an investigation — they never change tool results,
// approval behavior, or turn outcomes, and recording is best-effort: a
// persistence failure never disturbs the run. The view (--failures) is
// strictly read-only.

import fs from "node:fs";
import path from "node:path";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { safeTailStart } from "./text-cut.js";
import type { SessionStore } from "./session.js";
import type { ShellFailureDetail } from "./tools.js";

export const FAILURE_RECEIPTS_SCHEMA = "oh-my-cli.failures" as const;
export const FAILURE_RECEIPTS_VERSION = 1 as const;
/** The sidecar keeps only the newest N receipts; overflow drops the oldest. */
export const FAILURE_RECEIPTS_MAX = 50;
/** Per-stream output tail bound (chars), applied before redaction. */
export const FAILURE_OUTPUT_TAIL_CHARS = 2_048;
/** Command summary bound (chars), applied before redaction. */
export const FAILURE_COMMAND_CHARS = 1_000;

export type FailureExitState = "nonzero" | "timeout" | "signal";

export interface FailureReceipt {
  seq: number;
  at: string;
  /** Redacted, bounded command summary. */
  command: string;
  /** Exit code, or null when the command was killed or timed out. */
  status: number | null;
  exitState: FailureExitState;
  /** Redacted bounded tails. */
  stdoutTail: string;
  stderrTail: string;
  /** Redacted (home-collapsed) working directory. */
  cwd: string;
  /** Git head at failure time, or null when not a repository. */
  head: string | null;
}

export interface FailureLog {
  schema: typeof FAILURE_RECEIPTS_SCHEMA;
  v: typeof FAILURE_RECEIPTS_VERSION;
  sessionId: string;
  receipts: FailureReceipt[];
  /** Count of receipts dropped by the bound (oldest first). */
  dropped: number;
}

export interface FailureLogLoad {
  receipts: FailureReceipt[];
  dropped: number;
  /** True when a sidecar exists but cannot be parsed; it is preserved. */
  corrupt: boolean;
  filePath: string;
}

export function failureLogPath(store: SessionStore, sessionId: string): string {
  const fp = store.filePath(sessionId);
  return fp.endsWith(".jsonl") ? fp.slice(0, -".jsonl".length) + ".failures.json" : fp + ".failures.json";
}

/** Read the sidecar; a corrupt file yields empty receipts + corrupt flag. */
export function loadFailureLog(store: SessionStore, sessionId: string): FailureLogLoad {
  const filePath = failureLogPath(store, sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { receipts: [], dropped: 0, corrupt: false, filePath };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FailureLog>;
    if (!Array.isArray(parsed.receipts)) return { receipts: [], dropped: 0, corrupt: true, filePath };
    const receipts = parsed.receipts.filter(
      (r): r is FailureReceipt =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as FailureReceipt).command === "string" &&
        typeof (r as FailureReceipt).seq === "number",
    );
    return {
      receipts,
      dropped: typeof parsed.dropped === "number" ? parsed.dropped : 0,
      corrupt: false,
      filePath,
    };
  } catch {
    return { receipts: [], dropped: 0, corrupt: true, filePath };
  }
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Issue #860: cut via safeTailStart so a surrogate pair straddling the tail
  // boundary is dropped whole instead of orphaning a low surrogate after the `…`.
  return `…${text.slice(safeTailStart(text, maxChars))}`;
}

function redactBounded(text: string, maxChars: number): string {
  return redactSecrets(tail(text, maxChars)).text;
}

export interface AppendFailureReceiptOptions {
  head?: string | null;
  now?: () => number;
}

/**
 * Append one receipt (best-effort): redaction and bounding happen BEFORE
 * persistence; the sidecar is capped at FAILURE_RECEIPTS_MAX newest receipts;
 * writes are atomic (temp+rename). Any error is swallowed — receipt recording
 * must never disturb the run it observes.
 */
export function appendFailureReceipt(
  store: SessionStore,
  sessionId: string,
  detail: ShellFailureDetail,
  opts: AppendFailureReceiptOptions = {},
): void {
  try {
    const filePath = failureLogPath(store, sessionId);
    const load = loadFailureLog(store, sessionId);
    if (load.corrupt) return; // never overwrite an unreadable sidecar
    const nextSeq = load.receipts.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    const exitState: FailureExitState = detail.timedOut
      ? "timeout"
      : detail.status === null
        ? "signal"
        : "nonzero";
    const receipt: FailureReceipt = {
      seq: nextSeq,
      at: new Date((opts.now ?? Date.now)()).toISOString(),
      command: redactBounded(detail.command, FAILURE_COMMAND_CHARS),
      status: detail.status,
      exitState,
      stdoutTail: redactBounded(detail.stdout, FAILURE_OUTPUT_TAIL_CHARS),
      stderrTail: redactBounded(detail.stderr, FAILURE_OUTPUT_TAIL_CHARS),
      cwd: redactSecrets(redactHomePath(detail.cwd)).text,
      head: opts.head ?? null,
    };
    let receipts = [...load.receipts, receipt];
    let dropped = load.dropped;
    if (receipts.length > FAILURE_RECEIPTS_MAX) {
      dropped += receipts.length - FAILURE_RECEIPTS_MAX;
      receipts = receipts.slice(receipts.length - FAILURE_RECEIPTS_MAX);
    }
    const log: FailureLog = {
      schema: FAILURE_RECEIPTS_SCHEMA,
      v: FAILURE_RECEIPTS_VERSION,
      sessionId,
      receipts,
      dropped,
    };
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    /* best-effort evidence capture; never disturbs the run */
  }
}

// --- rendering ----------------------------------------------------------------

export interface FailureRecord {
  schema: typeof FAILURE_RECEIPTS_SCHEMA;
  v: typeof FAILURE_RECEIPTS_VERSION;
  sessionId: string;
  corrupt: boolean;
  dropped: number;
  receipts: FailureReceipt[];
}

export function buildFailureRecord(store: SessionStore, sessionId: string): FailureRecord {
  const load = loadFailureLog(store, sessionId);
  return {
    schema: FAILURE_RECEIPTS_SCHEMA,
    v: FAILURE_RECEIPTS_VERSION,
    sessionId,
    corrupt: load.corrupt,
    dropped: load.dropped,
    // Newest first for investigation ergonomics.
    receipts: [...load.receipts].sort((a, b) => b.seq - a.seq),
  };
}

export function formatFailures(record: FailureRecord): string[] {
  const lines: string[] = [];
  lines.push(`Failure receipts — session ${record.sessionId.slice(0, 8)}`);
  lines.push("─".repeat(40));
  if (record.corrupt) {
    lines.push("");
    lines.push("Warning: the failure sidecar is unreadable; showing no receipts.");
    return lines;
  }
  if (record.receipts.length === 0) {
    lines.push("");
    lines.push("No recorded failures for this session.");
    return lines;
  }
  lines.push("");
  for (const receipt of record.receipts) {
    const exit =
      receipt.exitState === "timeout"
        ? "timed out"
        : receipt.exitState === "signal"
          ? "killed by signal"
          : `exit code ${receipt.status}`;
    lines.push(`#${receipt.seq}  ${receipt.at}  ·  ${exit}`);
    lines.push(`    command: ${redactSecrets(receipt.command).text}`);
    lines.push(`    cwd: ${receipt.cwd}  ·  head: ${receipt.head === null ? "no git head" : receipt.head.slice(0, 12)}`);
    if (receipt.stderrTail.trim() !== "") {
      lines.push(`    stderr: ${redactSecrets(receipt.stderrTail).text}`);
    }
    if (receipt.stdoutTail.trim() !== "") {
      lines.push(`    stdout: ${redactSecrets(receipt.stdoutTail).text}`);
    }
  }
  if (record.dropped > 0) {
    lines.push("");
    lines.push(`${record.dropped} older receipt(s) dropped by the ${FAILURE_RECEIPTS_MAX}-receipt bound.`);
  }
  return lines;
}
