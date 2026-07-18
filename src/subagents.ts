// Bounded subagent lifecycle.
//
// Tracks delegated child work through stable states (queued, running,
// completed, failed, cancelled) so a parent can show what is in flight and
// cancel one selected child without disturbing itself or its siblings.
// Concurrency is bounded (never unlimited): children beyond the limit wait
// in the queued state until a slot frees. Cancellation is final — output a
// child produces after it is cancelled is dropped, so a late result can never
// overwrite or masquerade as a successful (or failed) outcome.

import { redactSecrets } from "./permission-impact.js";
import {
  evaluateWorkspaceGuard,
  SharedWorkspaceLaunchError,
  workspaceIdentity,
} from "./workspace-guard.js";
import type { WorkspaceIdentity, WorkspaceMode } from "./workspace-guard.js";

export { SharedWorkspaceLaunchError };
export type { WorkspaceMode };

export type SubagentState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_SUBAGENT_STATES: readonly SubagentState[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface SubagentRecord {
  id: string;
  label: string;
  state: SubagentState;
  startedAt: number | null;
  finishedAt: number | null;
  /** The child's declared workspace mode, when one was provided at launch. */
  mode?: WorkspaceMode;
  /** Present only when state is "completed". */
  result?: string;
  /** Present only when state is "failed". */
  error?: string;
}

// A worker performs the child's bounded work and resolves with a short result
// string. It receives an AbortSignal that is fired when the child is cancelled
// so a cooperative worker can stop early.
export type SubagentWorker = (signal: AbortSignal) => Promise<string>;

export interface SubagentManagerOptions {
  /** Maximum number of children running at once. Bounded; defaults to 4. */
  maxConcurrent?: number;
  /**
   * Maximum number of children a single manager may spawn over its whole
   * lifetime. Bounded; defaults to 200. Terminal children still count toward
   * this ceiling, so a churn of short-lived children cannot evade it.
   */
  maxTotalSpawns?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  clock?: () => number;
  /**
   * The parent's workspace root. When set, a mutating child that would share
   * this workspace (same directory, symlink alias, or linked git worktree) is
   * refused at launch; read-only children may still run in parallel.
   */
  parentWorkspace?: string;
}

export interface SubagentLaunchOptions {
  /** Optional human-readable label; falls back to the stable id. */
  label?: string;
  /**
   * The child's intended workspace path. Defaults to the parent workspace when
   * the manager was configured with one.
   */
  workspace?: string;
  /**
   * Whether the child may mutate its workspace. Defaults to "mutating" — the
   * conservative default the shared-workspace guard applies to. Declare
   * "read-only" for parallel investigation that never writes.
   */
  mode?: WorkspaceMode;
}

const DEFAULT_MAX_CONCURRENT = 4;
// Default ceiling on cumulative subagent spawns over a manager's lifetime. A
// sane bound for unattended use, overridable via maxTotalSpawns.
const DEFAULT_MAX_TOTAL_SPAWNS = 200;
const MAX_RESULT = 4096;

interface Entry {
  id: string;
  label: string;
  state: SubagentState;
  startedAt: number | null;
  finishedAt: number | null;
  mode?: WorkspaceMode;
  result?: string;
  error?: string;
  worker: SubagentWorker;
  controller: AbortController;
  // Bumped on cancellation so an in-flight settle can be recognised as stale.
  generation: number;
  settled: boolean;
}

function isTerminal(state: SubagentState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function clamp(text: string): string {
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "…[truncated]" : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function toRecord(entry: Entry): SubagentRecord {
  const record: SubagentRecord = {
    id: entry.id,
    label: entry.label,
    state: entry.state,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
  if (entry.mode !== undefined) record.mode = entry.mode;
  if (entry.state === "completed" && entry.result !== undefined) record.result = entry.result;
  if (entry.state === "failed" && entry.error !== undefined) record.error = entry.error;
  return record;
}

/**
 * Thrown by the subagent launcher once a session has spawned its lifetime
 * maximum of children. The message is a static, deterministic bound notice —
 * it never carries secrets, host paths, or untrusted content.
 */
export class SubagentSpawnCapError extends Error {
  readonly reason = "spawn_cap" as const;

  constructor(message: string) {
    super(message);
    this.name = "SubagentSpawnCapError";
  }
}

export class SubagentManager {
  private readonly entries = new Map<string, Entry>();
  private readonly maxConcurrent: number;
  private readonly maxTotalSpawns: number;
  private readonly clock: () => number;
  private readonly parentWorkspace?: string;
  private readonly parentIdentity?: WorkspaceIdentity;
  private seq = 0;

  constructor(opts: SubagentManagerOptions = {}) {
    const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    this.maxConcurrent = max;
    const total = opts.maxTotalSpawns ?? DEFAULT_MAX_TOTAL_SPAWNS;
    if (!Number.isInteger(total) || total < 1) {
      throw new Error("maxTotalSpawns must be a positive integer");
    }
    this.maxTotalSpawns = total;
    this.clock = opts.clock ?? (() => Date.now());
    if (opts.parentWorkspace !== undefined) {
      this.parentWorkspace = opts.parentWorkspace;
      this.parentIdentity = workspaceIdentity(opts.parentWorkspace);
    }
  }

  /**
   * Register a child. It enters the queued state and is promoted to running as
   * soon as a concurrency slot is free. Returns the child's stable id.
   *
   * Once the manager has spawned its lifetime maximum (maxTotalSpawns) of
   * children, further spawns are refused here — before any id is assigned — by
   * throwing {@link SubagentSpawnCapError} with a deterministic, content-free
   * message. Terminal children still count, so short-lived churn cannot evade it.
   *
   * When the manager was configured with a parent workspace, a mutating child
   * that would share that workspace is refused here — before any id is assigned
   * or the worker runs — by throwing {@link SharedWorkspaceLaunchError}. This is
   * the safety boundary that keeps two writers out of one workspace.
   */
  spawn(worker: SubagentWorker, opts: SubagentLaunchOptions = {}): string {
    if (typeof worker !== "function") {
      throw new Error("worker must be a function");
    }
    if (this.seq >= this.maxTotalSpawns) {
      throw new SubagentSpawnCapError(
        `Refusing to spawn a delegated agent: session subagent cap of ${this.maxTotalSpawns} reached`,
      );
    }
    const mode: WorkspaceMode = opts.mode ?? "mutating";
    if (this.parentIdentity) {
      const decision = evaluateWorkspaceGuard({
        parentIdentity: this.parentIdentity,
        childWorkspace: opts.workspace ?? this.parentWorkspace!,
        mode,
      });
      if (!decision.allowed) {
        throw new SharedWorkspaceLaunchError(decision.message);
      }
    }
    const id = `sub-${String(++this.seq).padStart(3, "0")}`;
    const label = opts.label && opts.label.trim() ? opts.label.trim() : id;
    const entry: Entry = {
      id,
      label,
      state: "queued",
      startedAt: null,
      finishedAt: null,
      mode: opts.mode,
      worker,
      controller: new AbortController(),
      generation: 0,
      settled: false,
    };
    this.entries.set(id, entry);
    this.pump();
    return id;
  }

  /**
   * Cancel one queued or running child. Fires the child's abort signal and
   * marks it cancelled. Returns false if the id is unknown or already terminal.
   * The parent and sibling children are unaffected.
   */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || isTerminal(entry.state)) return false;
    entry.generation += 1; // invalidate any in-flight settle
    entry.settled = true; // no late settle may apply
    entry.state = "cancelled";
    entry.finishedAt = this.clock();
    try {
      entry.controller.abort();
    } catch {
      /* abort never throws in practice; stay defensive */
    }
    this.pump(); // a freed running slot may promote the next queued child
    return true;
  }

  get(id: string): SubagentRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? toRecord(entry) : undefined;
  }

  list(): SubagentRecord[] {
    return [...this.entries.values()].map(toRecord);
  }

  counts(): Record<SubagentState, number> {
    return countByState(this.list());
  }

  private runningCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "running") n++;
    }
    return n;
  }

  // Promote queued children to running while a slot is free. Iteration order is
  // insertion order, so promotion is deterministic.
  private pump(): void {
    for (const entry of this.entries.values()) {
      if (this.runningCount() >= this.maxConcurrent) break;
      if (entry.state === "queued") this.start(entry);
    }
  }

  private start(entry: Entry): void {
    entry.state = "running";
    entry.startedAt = this.clock();
    const generation = entry.generation;
    entry.worker(entry.controller.signal).then(
      (result) => this.settle(entry, generation, "completed", result),
      (err) => this.settle(entry, generation, "failed", err),
    );
  }

  // Apply a worker's outcome only if the attempt is still live. A child that was
  // cancelled (or otherwise superseded) while in flight has its late output
  // dropped here, so it can never masquerade as a successful or failed result.
  private settle(
    entry: Entry,
    generation: number,
    terminal: "completed" | "failed",
    value: unknown,
  ): void {
    if (entry.settled || entry.state !== "running" || generation !== entry.generation) {
      return;
    }
    entry.settled = true;
    entry.state = terminal;
    entry.finishedAt = this.clock();
    if (terminal === "completed") {
      entry.result = clamp(String(value ?? ""));
    } else {
      entry.error = clamp(errorMessage(value));
    }
    this.pump();
  }
}

export function countByState(records: SubagentRecord[]): Record<SubagentState, number> {
  const counts: Record<SubagentState, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const record of records) counts[record.state]++;
  return counts;
}

const STATE_SYMBOL: Record<SubagentState, string> = {
  queued: "…",
  running: "⟳",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
};

// A redacted, human-readable lifecycle view. Stable ids and states are always
// shown; result/error text and labels are secret-redacted before display.
export function formatSubagentView(records: SubagentRecord[]): string {
  const lines: string[] = [];
  lines.push("Subagents");
  lines.push("─".repeat(40));

  if (records.length === 0) {
    lines.push("");
    lines.push("No active or recent subagents.");
    return lines.join("\n");
  }

  lines.push("");
  for (const record of records) lines.push("  " + formatSubagentLine(record));

  const counts = countByState(records);
  lines.push("");
  lines.push(
    `Summary: ${counts.running} running, ${counts.queued} queued, ` +
      `${counts.completed} completed, ${counts.failed} failed, ` +
      `${counts.cancelled} cancelled (${records.length} total)`,
  );

  return lines.join("\n");
}

function formatSubagentLine(record: SubagentRecord): string {
  const symbol = STATE_SYMBOL[record.state];
  const label = redactSecrets(record.label).text;
  let detail = "";
  if (record.state === "completed" && record.result) {
    detail = ` — ${redactSecrets(firstLine(record.result)).text}`;
  } else if (record.state === "failed" && record.error) {
    detail = ` — ${redactSecrets(firstLine(record.error)).text}`;
  }
  const duration = durationText(record);
  const modeTag = record.mode ? `[${record.mode}] ` : "";
  return `${symbol} ${record.id} ${record.state} ${modeTag}${label}${detail}${duration}`;
}

function durationText(record: SubagentRecord): string {
  if (record.startedAt === null || record.finishedAt === null) return "";
  const ms = Math.max(0, record.finishedAt - record.startedAt);
  return ` (${(ms / 1000).toFixed(1)}s)`;
}
