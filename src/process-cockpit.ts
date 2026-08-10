// Read-only process cockpit: inspects real background commands owned by the
// active session with bounded output and ownership attribution.
//
// Each entry exposes a stable process identity, lifecycle state, elapsed
// time, resolved working directory, a redacted command summary, attributable
// ports when known, bounded recent output, and a durable final receipt after
// exit. Inspection cannot cancel, restart, signal, or acquire mutation
// authority. The model is surface-independent: the same entries drive the
// TUI view and a future Desktop panel.

import { safeCutEnd } from "./text-cut.js";

export const PROCESS_COCKPIT_SCHEMA = "oh-my-cli.process-cockpit";
export const PROCESS_COCKPIT_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const MAX_OUTPUT_LINES = 50;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_COMMAND_LEN = 200;

// --- process state ----------------------------------------------------------

export type ProcessStatus = "running" | "exited" | "failed" | "cancelled";

export interface ExitReceipt {
  exitCode: number;
  signal?: string;
  /** Epoch ms of exit. */
  exitedAt: number;
  /** Total elapsed ms from start to exit. */
  elapsedMs: number;
}

export interface ProcessEntry {
  /** Stable, unique identifier within the session. */
  id: string;
  /** OS process ID (when known). */
  pid?: number;
  /** Redacted command summary. */
  command: string;
  status: ProcessStatus;
  /** Resolved working directory. */
  cwd: string;
  /** Session that owns this process. */
  sessionId: string;
  /** Epoch ms of process start. */
  startedAt: number;
  /** Elapsed ms (computed at snapshot time for running, fixed for exited). */
  elapsedMs: number;
  /** Attributable ports (when known). */
  ports: number[];
  /** Bounded recent output lines. */
  outputLines: string[];
  /** Total output lines seen (may exceed outputLines.length). */
  totalOutputLines: number;
  /** Whether output was truncated. */
  outputTruncated: boolean;
  /** Durable final receipt (present only after exit). */
  receipt?: ExitReceipt;
}

// --- command redaction ------------------------------------------------------

// Redact secrets from a command string. Preserves the command structure but
// replaces secret-bearing values.
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /(--?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth)[=\s]+)\S+/gi, replacement: "$1[REDACTED]" },
  { re: /(\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)=\S+/g, replacement: "$1=[REDACTED]" },
  { re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED]" },
];

export function redactCommand(command: string): string {
  let redacted = command;
  for (const { re, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(re, replacement);
  }
  if (redacted.length > MAX_COMMAND_LEN) {
    redacted = redacted.slice(0, safeCutEnd(redacted, MAX_COMMAND_LEN - 1)) + "…";
  }
  return redacted;
}

// --- output bounding --------------------------------------------------------

// Bound output to the configured limits. Returns the bounded lines, total
// count, and whether truncation occurred.
export function boundOutput(lines: string[]): {
  bounded: string[];
  total: number;
  truncated: boolean;
} {
  const total = lines.length;
  const truncated = total > MAX_OUTPUT_LINES;
  const bounded = lines.slice(-MAX_OUTPUT_LINES).map((line) => {
    if (line.length > MAX_OUTPUT_CHARS) {
      return line.slice(0, safeCutEnd(line, MAX_OUTPUT_CHARS - 1)) + "…";
    }
    return line;
  });
  return { bounded, total, truncated };
}

// --- cockpit ----------------------------------------------------------------

export interface ProcessSnapshot {
  schema: typeof PROCESS_COCKPIT_SCHEMA;
  v: typeof PROCESS_COCKPIT_VERSION;
  sessionId: string;
  entries: ProcessEntry[];
  /** Running process count. */
  runningCount: number;
  /** Exited/failed/cancelled count. */
  finishedCount: number;
  snapshotAt: number;
}

// The process cockpit tracks background processes for a session. It is a
// read-only view model: it records state transitions reported by the process
// runtime but never sends signals, kills, restarts, or mutates processes.
export class ProcessCockpit {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Register a new background process. */
  register(opts: {
    id: string;
    pid?: number;
    command: string;
    cwd: string;
    startedAt: number;
    ports?: number[];
  }): ProcessEntry {
    const entry: ProcessEntry = {
      id: opts.id,
      pid: opts.pid,
      command: redactCommand(opts.command),
      status: "running",
      cwd: opts.cwd,
      sessionId: this.sessionId,
      startedAt: opts.startedAt,
      elapsedMs: 0,
      ports: opts.ports ?? [],
      outputLines: [],
      totalOutputLines: 0,
      outputTruncated: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Append output lines (bounded). */
  appendOutput(id: string, lines: string[]): void {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "running") return;

    const allLines = [...entry.outputLines, ...lines];
    const { bounded, total, truncated } = boundOutput(allLines);
    entry.outputLines = bounded;
    entry.totalOutputLines = entry.totalOutputLines + lines.length;
    entry.outputTruncated = truncated || entry.totalOutputLines > bounded.length;
  }

  /** Record process exit with a durable receipt. */
  recordExit(id: string, exitCode: number, signal?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const now = Date.now();
    entry.status = exitCode === 0 ? "exited" : "failed";
    entry.elapsedMs = now - entry.startedAt;
    entry.receipt = {
      exitCode,
      signal,
      exitedAt: now,
      elapsedMs: entry.elapsedMs,
    };
  }

  /** Record process cancellation. */
  recordCancellation(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const now = Date.now();
    entry.status = "cancelled";
    entry.elapsedMs = now - entry.startedAt;
    entry.receipt = {
      exitCode: -1,
      signal: "SIGTERM",
      exitedAt: now,
      elapsedMs: entry.elapsedMs,
    };
  }

  get(id: string): ProcessEntry | undefined {
    return this.entries.get(id);
  }

  /** Take a read-only snapshot of all processes. */
  snapshot(now: number = Date.now()): ProcessSnapshot {
    const entries: ProcessEntry[] = [];
    let runningCount = 0;
    let finishedCount = 0;

    for (const entry of this.entries.values()) {
      // Update elapsed time for running processes.
      const elapsedMs = entry.status === "running"
        ? now - entry.startedAt
        : entry.elapsedMs;

      entries.push({ ...entry, elapsedMs });

      if (entry.status === "running") runningCount++;
      else finishedCount++;
    }

    // Sort: running first, then by start time.
    entries.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return a.startedAt - b.startedAt;
    });

    return {
      schema: PROCESS_COCKPIT_SCHEMA,
      v: PROCESS_COCKPIT_VERSION,
      sessionId: this.sessionId,
      entries,
      runningCount,
      finishedCount,
      snapshotAt: now,
    };
  }

  get size(): number {
    return this.entries.size;
  }
}

// --- formatting -------------------------------------------------------------

// Format elapsed milliseconds as a human-readable duration.
export function formatElapsed(ms: number): string {
  // Issue #810: clamp negative elapsed ms (clock skew) to 0, matching activity-render.
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h${remainMinutes}m`;
}

// Format a process cockpit snapshot as a compact TUI view.
export function formatCockpit(snap: ProcessSnapshot): string {
  const lines: string[] = [];
  lines.push("Process Cockpit");
  lines.push("═".repeat(50));
  lines.push(`Session:  ${snap.sessionId}`);
  lines.push(`Running:  ${snap.runningCount}  Finished: ${snap.finishedCount}`);

  for (const entry of snap.entries) {
    lines.push("");
    const icon = statusIcon(entry.status);
    const pid = entry.pid ? ` pid:${entry.pid}` : "";
    const ports = entry.ports.length > 0 ? ` ports:[${entry.ports.join(",")}]` : "";
    lines.push(`${icon} ${entry.id} [${entry.status}]${pid} ${formatElapsed(entry.elapsedMs)}${ports}`);
    lines.push(`  cmd: ${entry.command}`);
    lines.push(`  cwd: ${entry.cwd}`);

    if (entry.outputLines.length > 0) {
      const showLines = entry.outputLines.slice(-3);
      for (const line of showLines) {
        lines.push(`  │ ${line}`);
      }
      if (entry.outputTruncated) {
        lines.push(`  │ … (${entry.totalOutputLines} total lines, truncated)`);
      }
    }

    if (entry.receipt) {
      lines.push(`  exit: ${entry.receipt.exitCode}${entry.receipt.signal ? ` (${entry.receipt.signal})` : ""} after ${formatElapsed(entry.receipt.elapsedMs)}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no signals sent, no processes mutated.");

  return lines.join("\n");
}

function statusIcon(status: ProcessStatus): string {
  switch (status) {
    case "running": return "▶";
    case "exited": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
  }
}
