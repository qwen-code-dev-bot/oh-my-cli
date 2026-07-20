// Safely undo and redo one completed agent turn.
//
// An agent turn changes both the conversation (messages appended to the session)
// and the workspace (files written by its tools). A generic Git reset would
// destroy unrelated or pre-existing work, so this module captures an explicit,
// content-based checkpoint around a turn and reverses only the mutations
// attributable to it, while preserving user-owned and pre-existing changes.
//
// Design:
//   - Capture is content-based, not Git-history-based. A per-turn collector
//     records the pre-image (content or absence) of each file the turn's
//     mutating tools touch, the first time they touch it. The checkpoint pairs
//     that pre-image with the post-turn state. This works with or without Git
//     and never performs a force, hard reset, branch rewrite, or stash.
//   - Undo restores each turn-owned file to its pre-image and removes the turn's
//     conversation entry; redo re-applies the post-image and re-appends the
//     messages. Both are gated on a divergence check: a turn-owned file whose
//     current content no longer matches the checkpoint fails the whole operation
//     closed, leaving the workspace and transcript unchanged.
//   - Untracked-by-the-turn, conflicted, or externally modified paths fail
//     closed. The operation is idempotent (re-undoing an undone turn is a no-op)
//     and leaves a durable receipt tied to the exact session and checkpoint.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import type { SessionStore, SessionMessage } from "./session.js";

export const TURN_CHECKPOINT_SCHEMA = "oh-my-cli.turn-checkpoint" as const;
export const TURN_CHECKPOINT_VERSION = 1 as const;

// Git conflict markers at the start of a line. A conflicted file is never a safe
// undo target, so its presence fails the operation closed.
const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7})/m;

export interface FileImage {
  exists: boolean;
  /** sha256 of the UTF-8 content, or null when the file is absent. */
  sha256: string | null;
  /** The UTF-8 content, or null when the file is absent. */
  content: string | null;
}

export interface TurnFile {
  /** Workspace-relative path (the only kind a mutating tool may target). */
  path: string;
  before: FileImage;
  after: FileImage;
}

export interface TurnCheckpoint {
  schema: typeof TURN_CHECKPOINT_SCHEMA;
  v: typeof TURN_CHECKPOINT_VERSION;
  sessionId: string;
  turnIndex: number;
  /** Git HEAD at capture, or null when the workspace is not a Git repository. */
  head: string | null;
  messageCountBefore: number;
  messageCountAfter: number;
  /** The turn's messages, retained so redo can restore the conversation entry. */
  messages: SessionMessage[];
  files: TurnFile[];
  /** sha256 over the canonical checkpoint (excluding this field) — the receipt. */
  digest: string;
}

export interface TurnLog {
  schema: typeof TURN_CHECKPOINT_SCHEMA;
  v: typeof TURN_CHECKPOINT_VERSION;
  sessionId: string;
  checkpoints: TurnCheckpoint[];
  /** turnIndex currently in the undone state (its pre-image is on disk), or null. */
  undoneTurnIndex: number | null;
  /** Durable receipts for applied undo/redo operations. */
  receipts: TurnReceipt[];
}

export interface TurnReceipt {
  turnIndex: number;
  op: "undo" | "redo";
  digest: string;
  at: string;
}

/** Thrown when an undo/redo cannot be planned or applied safely. */
export class TurnCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnCheckpointError";
  }
}

// --- primitives --------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function readImage(absPath: string): FileImage {
  try {
    const content = fs.readFileSync(absPath, "utf8");
    return { exists: true, sha256: sha256(content), content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, sha256: null, content: null };
    }
    // Unreadable for another reason (permissions, etc.): fail closed by
    // surfacing the error rather than guessing the file is absent.
    throw new TurnCheckpointError(
      `cannot read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sameImage(a: FileImage, b: FileImage): boolean {
  return a.exists === b.exists && a.sha256 === b.sha256;
}

function conflicted(image: FileImage): boolean {
  return image.exists && image.content !== null && CONFLICT_MARKER_RE.test(image.content);
}

function relPath(workspace: Workspace, absPath: string): string {
  return path.relative(workspace.root, absPath);
}

function absPath(workspace: Workspace, rel: string): string {
  return path.resolve(workspace.root, rel);
}

// --- capture -----------------------------------------------------------------

// Accumulates the pre-image of each file a turn mutates, captured the first time
// the turn touches it (so the recorded state is the one that existed before the
// turn). One collector per turn; threaded through the agent loop and fed right
// before each mutating-file tool executes.
export class TurnImageCollector {
  private images = new Map<string, FileImage>();

  capture(absPath: string): void {
    if (this.images.has(absPath)) return;
    this.images.set(absPath, readImage(absPath));
  }

  entries(): Array<{ absPath: string; before: FileImage }> {
    return [...this.images.entries()].map(([absPath, before]) => ({ absPath, before }));
  }

  get size(): number {
    return this.images.size;
  }
}

/**
 * Build a checkpoint from a turn's captured pre-images and its messages. Only
 * files whose state actually changed during the turn are recorded. Returns null
 * when the turn changed nothing (no files, no messages) so an empty turn leaves
 * no checkpoint behind.
 */
export function buildTurnCheckpoint(
  collector: TurnImageCollector,
  opts: {
    workspace: Workspace;
    sessionId: string;
    turnIndex: number;
    messageCountBefore: number;
    messages: SessionMessage[];
    head: string | null;
  },
): TurnCheckpoint | null {
  const files: TurnFile[] = [];
  for (const { absPath: abs, before } of collector.entries()) {
    const after = readImage(abs);
    if (sameImage(before, after)) continue;
    files.push({ path: relPath(opts.workspace, abs), before, after });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0 && opts.messages.length === 0) return null;

  const checkpoint: TurnCheckpoint = {
    schema: TURN_CHECKPOINT_SCHEMA,
    v: TURN_CHECKPOINT_VERSION,
    sessionId: opts.sessionId,
    turnIndex: opts.turnIndex,
    head: opts.head,
    messageCountBefore: opts.messageCountBefore,
    messageCountAfter: opts.messageCountBefore + opts.messages.length,
    messages: opts.messages,
    files,
    digest: "",
  };
  checkpoint.digest = checkpointDigest(checkpoint);
  return checkpoint;
}

function checkpointDigest(checkpoint: TurnCheckpoint): string {
  const manifest = {
    schema: checkpoint.schema,
    v: checkpoint.v,
    sessionId: checkpoint.sessionId,
    turnIndex: checkpoint.turnIndex,
    head: checkpoint.head,
    messageCountBefore: checkpoint.messageCountBefore,
    messageCountAfter: checkpoint.messageCountAfter,
    messagesSha: sha256(canonicalize(checkpoint.messages)),
    files: checkpoint.files.map((f) => ({
      path: f.path,
      before: { exists: f.before.exists, sha256: f.before.sha256 },
      after: { exists: f.after.exists, sha256: f.after.sha256 },
    })),
  };
  return sha256(canonicalize(manifest));
}

// --- persistence -------------------------------------------------------------

function turnLogPath(store: SessionStore, id: string): string {
  const fp = store.filePath(id);
  return fp.endsWith(".jsonl") ? fp.slice(0, -".jsonl".length) + ".turn.json" : fp + ".turn.json";
}

export function loadTurnLog(store: SessionStore, id: string): TurnLog {
  const empty: TurnLog = {
    schema: TURN_CHECKPOINT_SCHEMA,
    v: TURN_CHECKPOINT_VERSION,
    sessionId: id,
    checkpoints: [],
    undoneTurnIndex: null,
    receipts: [],
  };
  let raw: string;
  try {
    raw = fs.readFileSync(turnLogPath(store, id), "utf8");
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TurnLog>;
    if (!Array.isArray(parsed.checkpoints)) return empty;
    return {
      schema: TURN_CHECKPOINT_SCHEMA,
      v: TURN_CHECKPOINT_VERSION,
      sessionId: id,
      checkpoints: parsed.checkpoints,
      undoneTurnIndex: typeof parsed.undoneTurnIndex === "number" ? parsed.undoneTurnIndex : null,
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    };
  } catch {
    return empty;
  }
}

function saveTurnLog(store: SessionStore, id: string, log: TurnLog): void {
  const target = turnLogPath(store, id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, canonicalize(log) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

/** Append a turn's checkpoint. A new turn supersedes any pending undone state. */
export function appendCheckpoint(store: SessionStore, id: string, checkpoint: TurnCheckpoint): void {
  const log = loadTurnLog(store, id);
  log.checkpoints.push(checkpoint);
  log.undoneTurnIndex = null;
  saveTurnLog(store, id, log);
}

/** The most recent checkpoint, or null when the session has none. */
export function latestCheckpoint(log: TurnLog): TurnCheckpoint | null {
  return log.checkpoints.length > 0 ? log.checkpoints[log.checkpoints.length - 1] : null;
}

// --- plan --------------------------------------------------------------------

export interface FileOp {
  path: string;
  absPath: string;
  action: "restore" | "delete";
  /** The content to write for a restore; null for a delete. */
  content: string | null;
}

export interface TurnPlan {
  ok: boolean;
  op: "undo" | "redo";
  reason?: string;
  fileOps: FileOp[];
  /** Messages removed (undo) or restored (redo). */
  messageDelta: number;
  checkpoint: TurnCheckpoint | null;
}

function failClosed(op: "undo" | "redo", reason: string, checkpoint: TurnCheckpoint | null): TurnPlan {
  return { ok: false, op, reason, fileOps: [], messageDelta: 0, checkpoint };
}

/**
 * Plan an undo of the session's most recent turn. Fails closed (without touching
 * anything) when there is no turn to undo, it is already undone, a turn-owned
 * file has diverged since the checkpoint, or a turn-owned file is conflicted.
 */
export function planUndo(log: TurnLog, store: SessionStore, workspace: Workspace): TurnPlan {
  const cp = latestCheckpoint(log);
  if (!cp) return failClosed("undo", "no turn to undo", null);
  if (log.undoneTurnIndex === cp.turnIndex) {
    return failClosed("undo", "the latest turn is already undone", cp);
  }
  const fileOps: FileOp[] = [];
  for (const f of cp.files) {
    const abs = absPath(workspace, f.path);
    const current = readImage(abs);
    if (!sameImage(current, f.after)) {
      return failClosed("undo", `workspace diverged: ${f.path} changed since the turn`, cp);
    }
    if (conflicted(current)) {
      return failClosed("undo", `${f.path} is in a conflicted state`, cp);
    }
    fileOps.push(
      f.before.exists
        ? { path: f.path, absPath: abs, action: "restore", content: f.before.content }
        : { path: f.path, absPath: abs, action: "delete", content: null },
    );
  }
  return {
    ok: true,
    op: "undo",
    fileOps,
    messageDelta: cp.messageCountAfter - cp.messageCountBefore,
    checkpoint: cp,
  };
}

/**
 * Plan a redo of the most recent turn. Only valid when that turn is currently
 * undone and each turn-owned file still matches its pre-image (no divergence).
 */
export function planRedo(log: TurnLog, store: SessionStore, workspace: Workspace): TurnPlan {
  const cp = latestCheckpoint(log);
  if (!cp) return failClosed("redo", "no turn to redo", null);
  if (log.undoneTurnIndex !== cp.turnIndex) {
    return failClosed("redo", "the latest turn is not undone", cp);
  }
  const fileOps: FileOp[] = [];
  for (const f of cp.files) {
    const abs = absPath(workspace, f.path);
    const current = readImage(abs);
    if (!sameImage(current, f.before)) {
      return failClosed("redo", `workspace diverged: ${f.path} changed since the undo`, cp);
    }
    if (conflicted(current)) {
      return failClosed("redo", `${f.path} is in a conflicted state`, cp);
    }
    fileOps.push(
      f.after.exists
        ? { path: f.path, absPath: abs, action: "restore", content: f.after.content }
        : { path: f.path, absPath: abs, action: "delete", content: null },
    );
  }
  return {
    ok: true,
    op: "redo",
    fileOps,
    messageDelta: cp.messageCountAfter - cp.messageCountBefore,
    checkpoint: cp,
  };
}

// --- apply -------------------------------------------------------------------

export interface ApplyResult {
  ok: boolean;
  op: "undo" | "redo";
  reason?: string;
  receipt?: TurnReceipt;
  plan?: TurnPlan;
}

function atomicWrite(absTarget: string, content: string): void {
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  const tmp = `${absTarget}.turn.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, absTarget);
}

function applyFileOps(fileOps: FileOp[]): void {
  // Restore via temp+rename so a partial write never leaves a half-written file;
  // deletes happen after all restores succeed.
  for (const op of fileOps) {
    if (op.action === "restore") atomicWrite(op.absPath, op.content ?? "");
  }
  for (const op of fileOps) {
    if (op.action === "delete") fs.rmSync(op.absPath, { force: true });
  }
}

/**
 * Apply an undo: restore turn-owned files to their pre-image, remove the turn's
 * messages, and record a receipt. Validation runs first (planUndo), so a
 * diverged/conflicted/already-undone turn fails closed with nothing changed.
 */
export function applyUndo(log: TurnLog, store: SessionStore, workspace: Workspace, id: string): ApplyResult {
  const plan = planUndo(log, store, workspace);
  if (!plan.ok || !plan.checkpoint) return { ok: false, op: "undo", reason: plan.reason, plan };
  const cp = plan.checkpoint;
  applyFileOps(plan.fileOps);
  const meta = store.readMeta(id);
  const all = store.load(id);
  store.checkpoint(id, all.slice(0, cp.messageCountBefore), meta);
  log.undoneTurnIndex = cp.turnIndex;
  const receipt: TurnReceipt = {
    turnIndex: cp.turnIndex,
    op: "undo",
    digest: cp.digest,
    at: new Date().toISOString(),
  };
  log.receipts.push(receipt);
  saveTurnLog(store, id, log);
  return { ok: true, op: "undo", receipt, plan };
}

/**
 * Apply a redo: restore turn-owned files to their post-image, re-append the
 * turn's messages, and clear the undone state. Valid only when the turn is
 * currently undone and undiverged (planRedo); otherwise fails closed.
 */
export function applyRedo(log: TurnLog, store: SessionStore, workspace: Workspace, id: string): ApplyResult {
  const plan = planRedo(log, store, workspace);
  if (!plan.ok || !plan.checkpoint) return { ok: false, op: "redo", reason: plan.reason, plan };
  const cp = plan.checkpoint;
  applyFileOps(plan.fileOps);
  const meta = store.readMeta(id);
  const all = store.load(id);
  store.checkpoint(id, [...all, ...cp.messages], meta);
  log.undoneTurnIndex = null;
  const receipt: TurnReceipt = {
    turnIndex: cp.turnIndex,
    op: "redo",
    digest: cp.digest,
    at: new Date().toISOString(),
  };
  log.receipts.push(receipt);
  saveTurnLog(store, id, log);
  return { ok: true, op: "redo", receipt, plan };
}

// --- formatting --------------------------------------------------------------

/** Human-readable preview of an undo/redo plan (or the reason it failed closed). */
export function formatTurnPlan(plan: TurnPlan): string {
  const lines: string[] = [];
  if (!plan.ok || !plan.checkpoint) {
    lines.push(`Cannot ${plan.op}: ${plan.reason ?? "unknown reason"}`);
    return lines.join("\n");
  }
  const cp = plan.checkpoint;
  lines.push(`${plan.op === "undo" ? "Undo" : "Redo"} turn #${cp.turnIndex} (${cp.digest.slice(0, 12)}…)`);
  if (plan.fileOps.length === 0) {
    lines.push("  Files: (none)");
  } else {
    lines.push("  Files:");
    for (const op of plan.fileOps) {
      lines.push(`    - ${op.action === "delete" ? "delete" : "restore"}  ${op.path}`);
    }
  }
  if (plan.op === "undo") {
    lines.push(`  Conversation: remove ${plan.messageDelta} message(s)`);
  } else {
    lines.push(`  Conversation: restore ${plan.messageDelta} message(s)`);
  }
  return lines.join("\n");
}
