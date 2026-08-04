// Per-session health inspection (Issue #600).
//
// The per-session views each cover one facet — activity stats, turn
// provenance, goal checkpoint, transcript export — but none answers "is this
// one session healthy, what durable state rides with it, and what should I
// do next?" in a single read. This module renders exactly that card: the
// integrity verdict, a presence/count inventory of the whole sidecar family
// (never content dumps), the redacted meta provenance, and bounded
// verdict-only next-step hints.
//
// Strictly read-only: it reads through the existing diagnostics/sidecar
// readers and writes nothing, so a corrupt session can be inspected without
// quarantining it (the heal-free resolver is used at the call site). Every
// rendered value goes through the established redaction/home-collapse
// pipelines; absent sidecars are honestly absent, never fabricated.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { loadCompaction } from "./compaction.js";
import { turnLogExists, loadTurnLog } from "./turn-checkpoint.js";
import { failureLogPath, loadFailureLog } from "./failure-receipts.js";
import { notesPath, readSessionNotes } from "./session-notes.js";

export const SESSION_INSPECT_SCHEMA = "oh-my-cli.session-inspect" as const;
export const SESSION_INSPECT_VERSION = 1 as const;

export interface SessionInspectIntegrity {
  status: "ok" | "partial" | "corrupt" | "missing";
  messageCount: number;
  badLines: number;
}

export interface SessionInspectMeta {
  model: string | null;
  profile: string | null;
  workspace: string | null;
  createdAt: number | null;
}

// Presence/count inventory of the sidecar family. Detail fields accompany a
// present sidecar only; absent sidecars leave them undefined.
export interface SessionInspectSidecars {
  name: boolean;
  goal: boolean;
  /** Goal status when a goal is set; a cleared-goal checkpoint has none. */
  goalStatus?: "active" | "paused" | "achieved";
  goalRevision?: number;
  goalHistory?: number;
  archived: boolean;
  archivedAt?: number;
  compact: boolean;
  tasks: boolean;
  turnLog: boolean;
  turnCheckpoints?: number;
  undoneTurn?: boolean;
  undoReceipts?: number;
  failures: boolean;
  failureReceipts?: number;
  failuresDropped?: number;
  /** True when the failures sidecar exists but cannot be parsed. */
  failuresCorrupt?: boolean;
  // Notes ledger (Issue #602), completing the family inventory (Issue #608).
  notes: boolean;
  noteCount?: number;
  /** True when the notes sidecar exists but cannot be parsed. */
  notesCorrupt?: boolean;
}

export interface SessionInspectRecord {
  schema: typeof SESSION_INSPECT_SCHEMA;
  v: typeof SESSION_INSPECT_VERSION;
  sessionId: string;
  /** User-owned name (redacted); omitted when unset. */
  name?: string;
  integrity: SessionInspectIntegrity;
  meta: SessionInspectMeta;
  sidecars: SessionInspectSidecars;
  /** Bounded, verdict-derived next-step hints. Never executed. */
  hints: string[];
}

export function buildSessionInspectRecord(
  store: SessionStore,
  id: string,
): SessionInspectRecord {
  const integrity = store.integrity(id);
  const diag = store.loadWithDiagnostics(id);
  const meta = diag.meta;

  const name = store.readName(id);
  const goalCheckpoint = store.readGoal(id);
  const archived = store.readArchived(id);
  const compact = loadCompaction(store.compactPath(id)) !== null;
  const tasks = store.readTasks(id) !== null;
  const turnLogPresent = turnLogExists(store, id);
  const turnLog = turnLogPresent ? loadTurnLog(store, id) : null;
  const failuresPresent = fs.existsSync(failureLogPath(store, id));
  const failures = failuresPresent ? loadFailureLog(store, id) : null;
  const notesPresent = fs.existsSync(notesPath(store, id));
  const notes = notesPresent ? readSessionNotes(store, id) : null;

  const sidecars: SessionInspectSidecars = {
    name: name !== null,
    goal: goalCheckpoint.goal !== null,
    ...(goalCheckpoint.goal !== null
      ? {
          goalStatus: goalCheckpoint.goal.status,
          goalRevision: goalCheckpoint.revision,
          goalHistory: goalCheckpoint.history?.length,
        }
      : {}),
    archived: archived !== null,
    ...(archived !== null ? { archivedAt: archived.at } : {}),
    compact,
    tasks,
    turnLog: turnLogPresent,
    ...(turnLog !== null
      ? {
          turnCheckpoints: turnLog.checkpoints.length,
          undoneTurn: turnLog.undoneTurnIndex !== null,
          undoReceipts: turnLog.receipts.length,
        }
      : {}),
    failures: failuresPresent,
    ...(failures !== null
      ? {
          failureReceipts: failures.receipts.length,
          failuresDropped: failures.dropped,
          failuresCorrupt: failures.corrupt,
        }
      : {}),
    notes: notesPresent,
    ...(notes !== null
      ? { noteCount: notes.notes.length, notesCorrupt: notes.corrupt }
      : {}),
  };

  const hints: string[] = [];
  switch (integrity.status) {
    case "ok":
      hints.push(`resume: oh-my-cli --resume ${id} -p "<prompt>"`);
      break;
    case "partial":
      hints.push(
        `resume: the trailing torn line is tolerated; healing happens on the next write`,
      );
      break;
    case "corrupt":
      hints.push(`salvage the recoverable prefix: oh-my-cli --salvage-session ${id}`);
      break;
    case "missing":
      hints.push("no checkpoint found for this session id");
      break;
  }
  if (archived !== null && integrity.status !== "missing") {
    hints.push(
      `archived — hidden from discovery; restore with: oh-my-cli --unarchive-session ${id}`,
    );
  }

  return {
    schema: SESSION_INSPECT_SCHEMA,
    v: SESSION_INSPECT_VERSION,
    sessionId: id,
    ...(name !== null ? { name: redactSecrets(name).text } : {}),
    integrity: {
      status: integrity.status,
      messageCount: integrity.messageCount,
      badLines: integrity.badLines,
    },
    meta: {
      model: meta?.model !== undefined ? redactSecrets(meta.model).text : null,
      profile: meta?.profile !== undefined ? redactSecrets(meta.profile).text : null,
      workspace:
        meta?.workspace !== undefined ? redactSecrets(redactHomePath(meta.workspace)).text : null,
      createdAt: meta?.createdAt ?? null,
    },
    sidecars,
    hints,
  };
}

export function formatSessionInspect(record: SessionInspectRecord): string[] {
  const lines: string[] = [];
  lines.push(`Session inspect — ${shortSessionId(record.sessionId)}`);
  lines.push("─".repeat(40));
  lines.push("");
  const i = record.integrity;
  lines.push(
    `integrity:  ${i.status} · ${i.messageCount} message(s) · ${i.badLines} bad line(s)`,
  );
  if (record.name !== undefined) {
    lines.push(`name:       "${record.name}"`);
  }
  const m = record.meta;
  lines.push(
    `meta:       model ${m.model ?? "unknown"} · profile ${m.profile ?? "—"} · ` +
      `repo ${m.workspace ?? "unknown"} · created ${m.createdAt !== null ? new Date(m.createdAt).toISOString() : "unknown"}`,
  );
  const s = record.sidecars;
  if (s.goal) {
    lines.push(
      `goal:       ${s.goalStatus} · revision ${s.goalRevision} · ` +
        `history ${s.goalHistory ?? 0} entr${(s.goalHistory ?? 0) === 1 ? "y" : "ies"}`,
    );
  }
  if (s.archived) {
    lines.push(`archived:   since ${new Date(s.archivedAt ?? 0).toISOString()}`);
  }
  const parts: string[] = [
    `name ${s.name ? "✓" : "✗"}`,
    `goal ${s.goal ? "✓" : "✗"}`,
    `archived ${s.archived ? "✓" : "✗"}`,
    `compact ${s.compact ? "✓" : "✗"}`,
    `tasks ${s.tasks ? "✓" : "✗"}`,
    s.turnLog ? `turn-log ✓ (${s.turnCheckpoints} checkpoint(s)${s.undoneTurn ? ", undone" : ""})` : "turn-log ✗",
    s.failures
      ? s.failuresCorrupt
        ? "failures ✓ (unreadable sidecar)"
        : `failures ✓ (${s.failureReceipts} receipt(s)${(s.failuresDropped ?? 0) > 0 ? `, +${s.failuresDropped} dropped` : ""})`
      : "failures ✗",
    s.notes
      ? s.notesCorrupt
        ? "notes ✓ (unreadable sidecar)"
        : `notes ✓ (${s.noteCount ?? 0} entr${(s.noteCount ?? 0) === 1 ? "y" : "ies"})`
      : "notes ✗",
  ];
  lines.push(`sidecars:   ${parts.join(" · ")}`);
  lines.push("");
  if (record.hints.length === 0) {
    lines.push("No next steps.");
  } else {
    for (const hint of record.hints) lines.push(`next:       ${hint}`);
  }
  return lines;
}
