// Background-task lifecycle with durable receipts, exposed as a deterministic,
// inspectable runtime view (Issue #203).
//
// Long-running tools, delegated work, and verification jobs need to continue
// without freezing the conversation, but invisible background execution makes
// progress, ownership, cancellation, and recovery hard to trust. This module
// models the lifecycle of runtime-owned background tasks through a small,
// explicit state machine and attaches a durable, content-free receipt to every
// terminal outcome.
//
// Nothing here performs I/O and the state machine is pure: the same inputs
// always yield the same outputs, and every mutation takes an explicit clock so
// tests are deterministic. The safety invariants are the point:
//   - completion is never fabricated — a terminal "succeeded"/"recovered" outcome
//     requires a durable receipt, and restart reconciliation that finds a dead
//     process with no receipt yields "orphaned" (interrupted, NOT complete),
//     never a silent success;
//   - cancellation is idempotent and scoped to one selected task, leaving a
//     receipt, and a late outcome from a cancelled task is dropped;
//   - retry creates a new explicit task rather than rewriting a finished one's
//     history;
//   - concurrency is authoritative (a queued task only starts when a slot is
//     free), and history is bounded so a churn of short-lived tasks cannot grow
//     the view without limit;
//   - every task-supplied string is secret-safe, length-bounded, and has host
//     paths redacted before it can reach a terminal, a headless dump, or a test
//     receipt.
//
// The same engine backs the interactive `/tasks` overlay and the headless
// `--tasks` form, so a session's background-task state reads identically in both.

import { createHash } from "node:crypto";
import { redactSecrets, redactHomePath } from "./permission-impact.js";

export const TASK_RUNTIME_SCHEMA = "oh-my-cli.tasks";
export const TASK_RUNTIME_VERSION = 1;

// Default cap on concurrently running tasks. Bounded; the caller may override.
export const DEFAULT_MAX_CONCURRENT = 4;

// Bounds so a pathological or hostile task cannot inflate the view.
const MAX_TASKS = 64; // retained tasks (bounded history)
const MAX_EVENTS_PER_TASK = 16; // retained per-task transitions
const MAX_LABEL_CHARS = 160;
const MAX_TYPE_CHARS = 40;
const MAX_OWNER_CHARS = 80;
const MAX_DETAIL_CHARS = 200;
const MAX_PROGRESS_CHARS = 80;
const MAX_EVIDENCE_CHARS = 320;
const MAX_NOTE_CHARS = 160;

// Lifecycle state of one runtime-owned background task. Terminal states carry a
// durable receipt; "orphaned" is explicitly NON-terminal (interrupted, outcome
// unknown) and must never be presented as complete.
export type TaskState =
  | "queued" // registered, awaiting a concurrency slot
  | "running" // executing under an owning process
  | "waiting" // paused on an approval or external signal
  | "succeeded" // terminal: completed, receipt attached
  | "failed" // terminal: errored, receipt attached
  | "cancelled" // terminal: cancelled, receipt attached
  | "orphaned" // owning process gone, no durable receipt (NOT complete)
  | "recovered"; // terminal: reconciled to a durable outcome after a restart

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "recovered",
];

// The only legal state transitions. Anything not listed here is refused, so an
// out-of-order or replayed event can never move a task backward or skip a
// required intermediate state.
export const TASK_STATE_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "waiting", "cancelled"],
  waiting: ["running", "cancelled", "orphaned", "recovered"],
  running: ["succeeded", "failed", "cancelled", "waiting", "orphaned", "recovered"],
  orphaned: ["recovered", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovered: [],
};

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[from].includes(to);
}

// The durable outcome a terminal task leaves behind. The digest is an opaque
// sha256 of the task's real evidence (never the content); the link and note are
// redacted and bounded. A "succeeded" or "recovered" outcome is only ever set
// alongside one of these.
export interface TaskReceipt {
  outcome: "succeeded" | "failed" | "cancelled" | "recovered";
  /** sha256 hex of the task's durable evidence — opaque, carries no content. */
  digest: string;
  /** Redacted, bounded pointer to the evidence (a path or URL). */
  evidenceLink?: string;
  /** Redacted, bounded human note. */
  note?: string;
  at: number;
}

// One recorded state change, kept (bounded) for the inspectable detail view.
export interface TaskEvent {
  from: TaskState;
  to: TaskState;
  at: number;
  reason?: string;
}

// Bounded progress hint for display (e.g. "3/7 steps"); never authoritative for
// completion — only a receipt proves a terminal outcome.
export interface TaskProgress {
  text: string;
}

// The runtime state of one background task, owned by one session and bound to
// one workspace.
export interface BackgroundTask {
  id: string;
  owner: string; // session/owner identity (redacted for output)
  type: string; // task kind, e.g. "shell" | "verify" | "subagent"
  label: string;
  state: TaskState;
  /** Owning process id while active; used by restart reconciliation. */
  pid?: number;
  workspaceKey: string; // redacted for output
  startedAt: number | null;
  updatedAt: number;
  progress?: TaskProgress;
  receipt?: TaskReceipt;
  detail?: string;
  events: TaskEvent[]; // bounded, insertion order
}

// A session's bounded set of background tasks. Pure operations return a new
// snapshot; nothing mutates in place.
export interface TaskSnapshot {
  schema: typeof TASK_RUNTIME_SCHEMA;
  v: typeof TASK_RUNTIME_VERSION;
  sessionId: string;
  workspaceKey: string;
  maxConcurrent: number;
  tasks: BackgroundTask[]; // insertion order
  seq: number; // monotonic id source
  evicted: number; // tasks dropped by bounded history
}

export interface TaskSnapshotOptions {
  sessionId: string;
  workspaceKey: string;
  maxConcurrent?: number;
}

export interface RegisterTaskInput {
  type: string;
  label: string;
  owner?: string;
  pid?: number;
  detail?: string;
}

// Result of a mutation, carrying enough to render without re-reading state.
export interface TaskMutation {
  snapshot: TaskSnapshot;
  ok: boolean;
  reason?: string;
  task?: BackgroundTask;
}

export function createTaskSnapshot(opts: TaskSnapshotOptions): TaskSnapshot {
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }
  return {
    schema: TASK_RUNTIME_SCHEMA,
    v: TASK_RUNTIME_VERSION,
    sessionId: safeText(opts.sessionId, MAX_OWNER_CHARS) || "session",
    workspaceKey: opts.workspaceKey,
    maxConcurrent: max,
    tasks: [],
    seq: 0,
    evicted: 0,
  };
}

// --- mutations (pure) -------------------------------------------------------

/**
 * Register a new task in the queued state. Bounded history: when the retained
 * set is full, the OLDEST terminal task is evicted (a non-terminal task is
 * never evicted). Returns the new task and its stable id.
 */
export function registerTask(
  snapshot: TaskSnapshot,
  input: RegisterTaskInput,
  now: number,
): TaskMutation {
  const seq = snapshot.seq + 1;
  const id = `task-${String(seq).padStart(3, "0")}`;
  const task: BackgroundTask = {
    id,
    owner: safeText(input.owner, MAX_OWNER_CHARS) || snapshot.sessionId,
    type: safeText(input.type, MAX_TYPE_CHARS) || "task",
    label: safeText(input.label, MAX_LABEL_CHARS) || id,
    state: "queued",
    workspaceKey: snapshot.workspaceKey,
    startedAt: null,
    updatedAt: now,
    detail: safeDetail(input.detail) ?? undefined,
    events: [],
  };
  const tasks = evictIfNeeded([...snapshot.tasks, task]);
  const evicted = tasks.length < snapshot.tasks.length + 1 ? snapshot.evicted + 1 : snapshot.evicted;
  return {
    snapshot: { ...snapshot, tasks, seq, evicted },
    ok: true,
    task,
  };
}

/**
 * Promote a queued task to running, but only when a concurrency slot is free —
 * concurrency is authoritative here, not advisory. A no-op (with reason) when
 * the task is unknown, not queued, or no slot is available.
 */
export function startTask(
  snapshot: TaskSnapshot,
  id: string,
  pid: number | undefined,
  now: number,
): TaskMutation {
  const task = findTask(snapshot, id);
  if (!task) return { snapshot, ok: false, reason: "unknown-task" };
  if (task.state !== "queued") return { snapshot, ok: false, reason: "not-queued" };
  if (runningCount(snapshot) >= snapshot.maxConcurrent) {
    return { snapshot, ok: false, reason: "no-slot" };
  }
  return applyTransition(snapshot, id, "running", { pid, startedAt: now }, now);
}

/**
 * Move a task to "waiting" (an approval or external signal). Allowed from
 * queued or running; the task keeps its slot accounting as non-running.
 */
export function waitTask(
  snapshot: TaskSnapshot,
  id: string,
  reason: string | undefined,
  now: number,
): TaskMutation {
  return applyTransition(snapshot, id, "waiting", { reason }, now);
}

/** Mark a running/waiting task succeeded. Requires a durable receipt. */
export function succeedTask(
  snapshot: TaskSnapshot,
  id: string,
  receipt: Omit<TaskReceipt, "outcome" | "at">,
  now: number,
): TaskMutation {
  return applyTransition(
    snapshot,
    id,
    "succeeded",
    { receipt: buildReceipt("succeeded", receipt, now) },
    now,
  );
}

/** Mark a running/orphaned task failed. Carries a durable receipt. */
export function failTask(
  snapshot: TaskSnapshot,
  id: string,
  receipt: Omit<TaskReceipt, "outcome" | "at">,
  now: number,
): TaskMutation {
  return applyTransition(
    snapshot,
    id,
    "failed",
    { receipt: buildReceipt("failed", receipt, now) },
    now,
  );
}

/**
 * Cancel one selected task. Idempotent and scoped: cancelling an unknown task
 * is a no-op (ok:false), cancelling an already-terminal task is a no-op that
 * reports alreadyTerminal (ok:true) without disturbing its receipt, and
 * cancelling a queued/running/waiting task moves it to "cancelled" with a
 * durable receipt. Siblings are unaffected.
 */
export function cancelTask(
  snapshot: TaskSnapshot,
  id: string,
  now: number,
): TaskMutation & { alreadyTerminal?: boolean } {
  const task = findTask(snapshot, id);
  if (!task) return { snapshot, ok: false, reason: "unknown-task" };
  if (isTerminalState(task.state)) {
    return { snapshot, ok: true, alreadyTerminal: true, task };
  }
  const mutation = applyTransition(
    snapshot,
    id,
    "cancelled",
    { receipt: buildReceipt("cancelled", { digest: emptyDigest(), note: "cancelled by request" }, now) },
    now,
  );
  return { ...mutation, alreadyTerminal: false };
}

/**
 * Retry a finished task by creating a NEW explicit task that copies its type and
 * label. The original's history is never rewritten: a terminal task is left
 * exactly as it finished. Returns the new task (and its id) or a no-op when the
 * source is unknown or not terminal.
 */
export function retryTask(
  snapshot: TaskSnapshot,
  id: string,
  now: number,
): TaskMutation {
  const source = findTask(snapshot, id);
  if (!source) return { snapshot, ok: false, reason: "unknown-task" };
  if (!isTerminalState(source.state)) return { snapshot, ok: false, reason: "not-terminal" };
  return registerTask(
    snapshot,
    { type: source.type, label: `${source.label} (retry)`, owner: source.owner, detail: source.detail },
    now,
  );
}

/**
 * Restart reconciliation. For every active task (running or waiting) that owns a
 * pid, ask the injected probe whether that process is still alive:
 *   - alive  → left running/waiting (still being watched);
 *   - dead + a durable receipt is supplied for it → "recovered" (the real
 *     outcome is re-attached from durable evidence);
 *   - dead + no receipt → "orphaned" (interrupted, outcome unknown — NEVER
 *     marked complete).
 * Tasks without a pid (queued) are left untouched: they never owned a process
 * and are re-registered by the caller. Completion is never inferred from UI
 * state alone.
 */
export function reconcileTasks(
  snapshot: TaskSnapshot,
  probe: { isAlive: (pid: number) => boolean; receipts?: Record<string, Omit<TaskReceipt, "outcome" | "at">> },
  now: number,
): TaskMutation {
  let next = snapshot;
  for (const task of snapshot.tasks) {
    if (task.state !== "running" && task.state !== "waiting") continue;
    if (task.pid === undefined || probe.isAlive(task.pid)) continue;
    const supplied = probe.receipts?.[task.id];
    if (supplied) {
      next = applyTransition(next, task.id, "recovered", {
        receipt: buildReceipt("recovered", supplied, now),
      }, now).snapshot;
    } else {
      next = applyTransition(next, task.id, "orphaned", {
        reason: "owning process exited with no durable receipt",
      }, now).snapshot;
    }
  }
  return { snapshot: next, ok: true };
}

/**
 * Re-attach a durable receipt to an orphaned task, recovering it. This is the
 * second half of restart recovery: a task orphaned because no receipt was found
 * at reconcile time can later be recovered once durable evidence surfaces.
 * Refuses unless the task is currently orphaned.
 */
export function recoverTask(
  snapshot: TaskSnapshot,
  id: string,
  receipt: Omit<TaskReceipt, "outcome" | "at">,
  now: number,
): TaskMutation {
  const task = findTask(snapshot, id);
  if (!task) return { snapshot, ok: false, reason: "unknown-task" };
  if (task.state !== "orphaned") return { snapshot, ok: false, reason: "not-orphaned" };
  return applyTransition(
    snapshot,
    id,
    "recovered",
    { receipt: buildReceipt("recovered", receipt, now) },
    now,
  );
}

// --- summary + formatting ---------------------------------------------------

export interface TaskSummary {
  schema: typeof TASK_RUNTIME_SCHEMA;
  v: typeof TASK_RUNTIME_VERSION;
  sessionId: string;
  workspaceKey: string;
  total: number;
  evicted: number;
  counts: Record<TaskState, number>;
  active: BackgroundTask[]; // non-terminal, most recent first
  recent: BackgroundTask[]; // terminal, most recent first (bounded)
}

const MAX_RECENT_IN_SUMMARY = 8;

export function summarizeTasks(snapshot: TaskSnapshot): TaskSummary {
  const counts = emptyCounts();
  for (const task of snapshot.tasks) counts[task.state]++;
  const active = snapshot.tasks.filter((t) => !isTerminalState(t.state)).reverse();
  const recent = snapshot.tasks
    .filter((t) => isTerminalState(t.state))
    .reverse()
    .slice(0, MAX_RECENT_IN_SUMMARY);
  return {
    schema: TASK_RUNTIME_SCHEMA,
    v: TASK_RUNTIME_VERSION,
    sessionId: snapshot.sessionId,
    workspaceKey: snapshot.workspaceKey,
    total: snapshot.tasks.length,
    evicted: snapshot.evicted,
    counts,
    active,
    recent,
  };
}

const STATE_SYMBOL: Record<TaskState, string> = {
  queued: "…",
  running: "⟳",
  waiting: "⏸",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
  orphaned: "⚠",
  recovered: "↻",
};

export function formatTaskSummary(summary: TaskSummary, opts?: { workspaceRoot?: string }): string[] {
  const lines: string[] = [];
  const workspace = opts?.workspaceRoot ? redactHomePath(opts.workspaceRoot) : redactHomePath(summary.workspaceKey);
  lines.push(`Tasks (${summary.schema} v${summary.v})`);
  lines.push(`workspace: ${workspace}`);
  lines.push(
    `summary: ${summary.counts.running} running, ${summary.counts.waiting} waiting, ` +
      `${summary.counts.queued} queued, ${summary.counts.orphaned} orphaned, ` +
      `${summary.counts.succeeded + summary.counts.recovered} done ` +
      `(${summary.total} retained, ${summary.evicted} evicted)`,
  );
  if (summary.active.length > 0) {
    lines.push("");
    lines.push("active:");
    for (const task of summary.active) lines.push("  " + formatTaskLine(task));
  }
  if (summary.recent.length > 0) {
    lines.push("");
    lines.push("recent:");
    for (const task of summary.recent) lines.push("  " + formatTaskLine(task));
  }
  if (summary.active.length === 0 && summary.recent.length === 0) {
    lines.push("");
    lines.push("no background tasks.");
  }
  return lines;
}

export function formatTaskDetail(task: BackgroundTask): string[] {
  const lines: string[] = [];
  lines.push(`${STATE_SYMBOL[task.state]} ${task.id} ${task.state}`);
  lines.push(`type:      ${task.type}`);
  lines.push(`label:     ${task.label}`);
  lines.push(`owner:     ${task.owner}`);
  lines.push(`workspace: ${redactHomePath(task.workspaceKey)}`);
  if (task.pid !== undefined) lines.push(`pid:       ${task.pid}`);
  if (task.progress) lines.push(`progress:  ${safeText(task.progress.text, MAX_PROGRESS_CHARS)}`);
  if (task.detail) lines.push(`detail:    ${task.detail}`);
  if (task.receipt) {
    lines.push(`receipt:   ${task.receipt.outcome} ${task.receipt.digest.slice(0, 12)}`);
    if (task.receipt.evidenceLink) lines.push(`evidence:  ${task.receipt.evidenceLink}`);
    if (task.receipt.note) lines.push(`note:      ${task.receipt.note}`);
  }
  if (task.events.length > 0) {
    lines.push("history:");
    for (const event of task.events) {
      const reason = event.reason ? ` (${event.reason})` : "";
      lines.push(`  ${event.from} → ${event.to}${reason}`);
    }
  }
  return lines;
}

function formatTaskLine(task: BackgroundTask): string {
  const symbol = STATE_SYMBOL[task.state];
  const progress = task.progress ? ` [${safeText(task.progress.text, MAX_PROGRESS_CHARS)}]` : "";
  const detail = task.detail ? ` — ${task.detail}` : "";
  return `${symbol} ${task.id} ${task.state} ${task.type} ${task.label}${progress}${detail}`;
}

// --- combined view + durable persistence ------------------------------------

// A combined view: a session's task summary plus its workspace root, rendered
// together. Backs both the interactive `/tasks` overlay and the headless
// `--tasks` form (parity), exactly like the language-server view.
export interface TaskView {
  summary: TaskSummary;
  workspaceRoot?: string;
}

// An honest, quiet empty view for a session with no recorded background tasks.
export function emptyTaskView(workspaceRoot?: string): TaskView {
  return {
    summary: summarizeTasks(
      createTaskSnapshot({ sessionId: "session", workspaceKey: workspaceRoot ?? "" }),
    ),
    workspaceRoot,
  };
}

const MAX_DETAIL_TASKS = 6;

// The full inspectable view: a compact summary followed by per-task detail of
// the active and most-recent terminal tasks. Bounded so a churn of tasks cannot
// inflate it.
export function formatTaskView(view: TaskView): string[] {
  const lines = formatTaskSummary(view.summary, { workspaceRoot: view.workspaceRoot });
  const detailed = [...view.summary.active, ...view.summary.recent].slice(0, MAX_DETAIL_TASKS);
  if (detailed.length > 0) {
    lines.push("");
    lines.push("detail");
    for (const task of detailed) {
      lines.push("");
      lines.push(...formatTaskDetail(task));
    }
  }
  return lines;
}

/**
 * Serialize a snapshot to a durable, redacted JSON string for the session
 * sidecar. Free-form fields are already redacted at construction; this only
 * shapes the JSON. The digest carried by receipts is an opaque hash, so the
 * persisted form carries no task content or secrets.
 */
export function serializeTaskSnapshot(snapshot: TaskSnapshot): string {
  return JSON.stringify(
    {
      schema: TASK_RUNTIME_SCHEMA,
      v: TASK_RUNTIME_VERSION,
      sessionId: snapshot.sessionId,
      workspaceKey: snapshot.workspaceKey,
      maxConcurrent: snapshot.maxConcurrent,
      seq: snapshot.seq,
      evicted: snapshot.evicted,
      tasks: snapshot.tasks,
    },
    null,
    2,
  );
}

/**
 * Structurally validate an unknown value as a snapshot. Throws TaskSnapshotError
 * on anything malformed or version-incompatible so a stale or tampered sidecar
 * is rejected before it is presented as current (fail closed).
 */
export function parseTaskSnapshot(value: unknown): TaskSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new TaskSnapshotError("task snapshot is not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.schema !== TASK_RUNTIME_SCHEMA) {
    throw new TaskSnapshotError(`unexpected task schema ${JSON.stringify(v.schema ?? null)}`);
  }
  if (v.v !== TASK_RUNTIME_VERSION) {
    throw new TaskSnapshotError(`incompatible task snapshot version ${JSON.stringify(v.v ?? null)}`);
  }
  if (typeof v.sessionId !== "string") throw new TaskSnapshotError("task snapshot missing sessionId");
  if (typeof v.workspaceKey !== "string") throw new TaskSnapshotError("task snapshot missing workspaceKey");
  if (!Array.isArray(v.tasks)) throw new TaskSnapshotError("task snapshot missing tasks array");
  const tasks: BackgroundTask[] = [];
  for (const raw of v.tasks) {
    tasks.push(parseTask(raw));
  }
  const maxConcurrent =
    typeof v.maxConcurrent === "number" && v.maxConcurrent >= 1
      ? Math.floor(v.maxConcurrent)
      : DEFAULT_MAX_CONCURRENT;
  return {
    schema: TASK_RUNTIME_SCHEMA,
    v: TASK_RUNTIME_VERSION,
    sessionId: v.sessionId,
    workspaceKey: v.workspaceKey,
    maxConcurrent,
    seq: typeof v.seq === "number" ? v.seq : tasks.length,
    evicted: typeof v.evicted === "number" ? v.evicted : 0,
    tasks,
  };
}

/** Thrown when a durable task snapshot cannot be read, parsed, or validated. */
export class TaskSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSnapshotError";
  }
}

function parseTask(value: unknown): BackgroundTask {
  if (typeof value !== "object" || value === null) {
    throw new TaskSnapshotError("task entry is not an object");
  }
  const v = value as Record<string, unknown>;
  const state = v.state;
  if (!isTaskState(state)) throw new TaskSnapshotError(`task has an unknown state ${JSON.stringify(state)}`);
  if (typeof v.id !== "string") throw new TaskSnapshotError("task missing id");
  const task: BackgroundTask = {
    id: v.id,
    owner: typeof v.owner === "string" ? v.owner : "session",
    type: typeof v.type === "string" ? v.type : "task",
    label: typeof v.label === "string" ? v.label : v.id,
    state,
    workspaceKey: typeof v.workspaceKey === "string" ? v.workspaceKey : "",
    startedAt: typeof v.startedAt === "number" ? v.startedAt : null,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    events: Array.isArray(v.events) ? v.events.filter(isTaskEvent) : [],
  };
  if (typeof v.pid === "number") task.pid = v.pid;
  if (typeof v.detail === "string") task.detail = v.detail;
  if (isTaskReceipt(v.receipt)) task.receipt = v.receipt;
  if (
    typeof v.progress === "object" &&
    v.progress !== null &&
    typeof (v.progress as { text?: unknown }).text === "string"
  ) {
    task.progress = { text: (v.progress as { text: string }).text };
  }
  return task;
}

function isTaskState(value: unknown): value is TaskState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "orphaned" ||
    value === "recovered"
  );
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return isTaskState(e.from) && isTaskState(e.to) && typeof e.at === "number";
}

function isTaskReceipt(value: unknown): value is TaskReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    (r.outcome === "succeeded" || r.outcome === "failed" || r.outcome === "cancelled" || r.outcome === "recovered") &&
    typeof r.digest === "string" &&
    typeof r.at === "number"
  );
}

// --- internal helpers -------------------------------------------------------

interface TransitionPatch {
  pid?: number;
  reason?: string;
  receipt?: TaskReceipt;
  startedAt?: number;
}

function applyTransition(
  snapshot: TaskSnapshot,
  id: string,
  to: TaskState,
  patch: TransitionPatch,
  now: number,
): TaskMutation {
  const task = findTask(snapshot, id);
  if (!task) return { snapshot, ok: false, reason: "unknown-task" };
  if (!canTransition(task.state, to)) {
    return { snapshot, ok: false, reason: `illegal-transition:${task.state}->${to}`, task };
  }
  const event: TaskEvent = { from: task.state, to, at: now };
  if (patch.reason) event.reason = safeText(patch.reason, MAX_NOTE_CHARS);
  const events = [...task.events, event].slice(-MAX_EVENTS_PER_TASK);
  const updated: BackgroundTask = {
    ...task,
    state: to,
    updatedAt: now,
    events,
    startedAt: patch.startedAt ?? task.startedAt ?? (to === "running" ? now : null),
  };
  if (patch.pid !== undefined) updated.pid = patch.pid;
  if (patch.receipt) updated.receipt = patch.receipt;
  // A terminal task no longer owns a live process.
  if (isTerminalState(to)) updated.pid = undefined;
  const tasks = snapshot.tasks.map((t) => (t.id === id ? updated : t));
  return { snapshot: { ...snapshot, tasks }, ok: true, task: updated };
}

function buildReceipt(
  outcome: TaskReceipt["outcome"],
  input: Omit<TaskReceipt, "outcome" | "at">,
  now: number,
): TaskReceipt {
  const receipt: TaskReceipt = {
    outcome,
    digest: input.digest && input.digest.length > 0 ? input.digest : emptyDigest(),
    at: now,
  };
  if (input.evidenceLink !== undefined) {
    receipt.evidenceLink = safeEvidence(input.evidenceLink);
  }
  if (input.note !== undefined) {
    receipt.note = safeText(input.note, MAX_NOTE_CHARS) || undefined;
  }
  return receipt;
}

function evictIfNeeded(tasks: BackgroundTask[]): BackgroundTask[] {
  if (tasks.length <= MAX_TASKS) return tasks;
  // Drop the oldest terminal task; never evict a non-terminal one.
  const idx = tasks.findIndex((t) => isTerminalState(t.state));
  if (idx === -1) return tasks.slice(tasks.length - MAX_TASKS);
  return [...tasks.slice(0, idx), ...tasks.slice(idx + 1)];
}

function findTask(snapshot: TaskSnapshot, id: string): BackgroundTask | undefined {
  return snapshot.tasks.find((t) => t.id === id);
}

function runningCount(snapshot: TaskSnapshot): number {
  let n = 0;
  for (const task of snapshot.tasks) if (task.state === "running") n++;
  return n;
}

function emptyCounts(): Record<TaskState, number> {
  return {
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    orphaned: 0,
    recovered: 0,
  };
}

function emptyDigest(): string {
  return createHash("sha256").update("task:no-evidence").digest("hex");
}

function safeText(input: string | undefined, max: number): string {
  if (!input) return "";
  const { text } = redactSecrets(input);
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)) + "…";
}

function safeDetail(input: string | undefined): string | null {
  const text = safeText(input, MAX_DETAIL_CHARS);
  return text ? text : null;
}

function safeEvidence(input: string): string {
  let display = input;
  if (display.startsWith("file://")) {
    display = "file://" + redactHomePath(display.slice("file://".length));
  } else {
    display = redactHomePath(display);
  }
  return safeText(display, MAX_EVIDENCE_CHARS);
}
