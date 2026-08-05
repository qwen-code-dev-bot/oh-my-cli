// Per-session on-disk storage footprint report (Issue #664).
//
// Session stores grow without bound: every session accumulates a transcript
// plus sidecars (name, goal, notes, pinned, archived), and nothing answers
// "which sessions eat the most disk?" The stale-sessions report (#626)
// advises on age and artifact-retention covers artifacts, but per-session
// storage footprint had no surface.
//
// This module is strictly read-only: it stats the store's files, ranks
// sessions largest-first (ties broken by full session id ascending), and
// reports totals. Missing files contribute 0 bytes honestly (a vanished
// transcript reports 0 rather than failing); archived sessions are included
// — they still occupy disk — and marked. Nothing is created, healed, or
// mutated. With `--strict --budget` (Issue #692) the exit code gates the
// total footprint against a declared byte budget so retention automation
// can enforce size limits without parsing prose.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { notesPath } from "./session-notes.js";
import { shortSessionId } from "./session-picker.js";
import { formatBytes } from "./artifact-retention.js";

export const SESSION_STORAGE_SCHEMA = "oh-my-cli.session-storage" as const;
export const SESSION_STORAGE_VERSION = 1 as const;

export interface SessionStorageEntry {
  sessionId: string;
  shortId: string;
  /** Transcript bytes; 0 when the transcript file is missing. */
  transcriptBytes: number;
  /** Total bytes of the present sidecar files (name/goal/notes/pinned/archived). */
  sidecarBytes: number;
  /** transcriptBytes + sidecarBytes. */
  bytes: number;
  /** True when the session carries an archived marker. */
  archived: boolean;
}

export interface SessionStorageRecord {
  schema: typeof SESSION_STORAGE_SCHEMA;
  v: typeof SESSION_STORAGE_VERSION;
  sessionCount: number;
  totalBytes: number;
  /** The largest session's id, or null for an empty store. */
  largestSessionId: string | null;
  /** Ranked largest first; ties break by full sessionId ascending. */
  sessions: SessionStorageEntry[];
}

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Build the storage footprint report for every session in the store
 * (Issue #664). Read-only: stats files, never touches them. Sessions rank
 * largest first with the full session id as a deterministic tie-break.
 */
export function buildSessionStorageReport(store: SessionStore): SessionStorageRecord {
  const sessions: SessionStorageEntry[] = [];
  for (const id of store.listIds()) {
    const transcriptBytes = fileSize(store.filePath(id));
    let sidecarBytes = 0;
    for (const p of [
      store.namePath(id),
      store.goalPath(id),
      notesPath(store, id),
      store.pinnedPath(id),
      store.archivedPath(id),
    ]) {
      sidecarBytes += fileSize(p);
    }
    sessions.push({
      sessionId: id,
      shortId: shortSessionId(id),
      transcriptBytes,
      sidecarBytes,
      bytes: transcriptBytes + sidecarBytes,
      archived: store.readArchived(id) !== null,
    });
  }
  sessions.sort((a, b) => b.bytes - a.bytes || a.sessionId.localeCompare(b.sessionId));
  const totalBytes = sessions.reduce((sum, s) => sum + s.bytes, 0);
  return {
    schema: SESSION_STORAGE_SCHEMA,
    v: SESSION_STORAGE_VERSION,
    sessionCount: sessions.length,
    totalBytes,
    largestSessionId: sessions.length > 0 ? sessions[0].sessionId : null,
    sessions,
  };
}

/**
 * Map a storage report to the `--strict --budget` exit code (Issue #692):
 * 1 when the total footprint exceeds the budget, 0 when at or under — an
 * empty store is 0 bytes and never fails a non-negative budget. Pure; the
 * report output is unaffected — the exit code is the machine-readable
 * signal.
 */
export function storageBudgetStrictExit(totalBytes: number, budgetBytes: number): number {
  return totalBytes > budgetBytes ? 1 : 0;
}

/**
 * Parse the --budget value (Issue #692): a non-negative integer byte
 * count. Throws with a caller-ready message on anything else so the CLI
 * can fail closed before any output.
 */
export function parseStorageBudget(raw: string): number {
  const text = raw.trim();
  const fail = (): never => {
    throw new Error(
      `Error: invalid --storage-budget value: "${raw}" (expected a non-negative integer byte count)`,
    );
  };
  if (!/^\d+$/.test(text)) fail();
  const value = Number(text);
  if (!Number.isSafeInteger(value)) fail();
  return value;
}

export function formatSessionStorageReport(record: SessionStorageRecord): string[] {
  const lines: string[] = [];
  lines.push("Session storage report");
  lines.push("─".repeat(40));
  lines.push("");
  if (record.sessionCount === 0) {
    lines.push("0 session(s), 0B total.");
    return lines;
  }
  lines.push(`${record.sessionCount} session(s), ${formatBytes(record.totalBytes)} total.`);
  const largest = record.sessions[0];
  lines.push(`Largest: ${largest.shortId} (${formatBytes(largest.bytes)})`);
  lines.push("");
  for (const s of record.sessions) {
    const archivedNote = s.archived ? " (archived)" : "";
    lines.push(
      `  ${s.shortId}${archivedNote} — ${formatBytes(s.bytes)}` +
        ` (transcript ${formatBytes(s.transcriptBytes)}, sidecars ${formatBytes(s.sidecarBytes)})`,
    );
  }
  return lines;
}
