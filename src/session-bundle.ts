// Lossless session bundles (Issue #704): the portable shape for moving a
// session between stores. The transcript is carried as raw stored lines
// (so corrupt/partial transcripts round-trip with their integrity intact),
// and every present sidecar is carried as its JSON value — a sidecar that
// does not parse is carried as its raw text and restored raw, so nothing
// is silently dropped. Restore always materializes a NEW session id and
// never overwrites or reuses an existing session; turn-log entries are
// rewritten to the new id.
//
// This is the moving shape, deliberately distinct from --export-session
// (the redacted Markdown + manifest sharing shape, which cannot
// round-trip): bundles are full-fidelity and unredacted, intended for
// backup and transfer between a user's own stores.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { notesPath } from "./session-notes.js";

export const SESSION_BUNDLE_SCHEMA = "oh-my-cli.session-bundle" as const;
export const SESSION_BUNDLE_VERSION = 1 as const;

export interface SessionBundleSidecars {
  /** Raw stored text of each present sidecar — restored byte-for-byte. */
  name?: string;
  goal?: string;
  notes?: string;
  pinned?: string;
  archived?: string;
  /** Raw turn log; parsed on restore to rewrite sessionId fields. */
  turn?: string;
}

export interface SessionBundle {
  schema: typeof SESSION_BUNDLE_SCHEMA;
  v: typeof SESSION_BUNDLE_VERSION;
  bundledAt: number;
  sourceSessionId: string;
  /** Raw transcript lines, stored byte order, no trailing empties. */
  transcriptLines: string[];
  sidecars: SessionBundleSidecars;
}

function sessionTurnLogPath(store: SessionStore, id: string): string {
  const fp = store.filePath(id);
  return fp.endsWith(".jsonl")
    ? fp.slice(0, -".jsonl".length) + ".turn.json"
    : fp + ".turn.json";
}

// Carry every sidecar as its raw stored text so restore is byte-identical
// for untouched sidecars (including trailing newlines); the turn log alone
// is parsed on restore, because its session ids must be rewritten.
function readSidecarRaw(p: string): string | undefined {
  if (!fs.existsSync(p)) return undefined;
  return fs.readFileSync(p, "utf-8");
}

/**
 * Build a lossless bundle of one session (Issue #704). Strictly
 * read-only: the store is never mutated.
 */
export function bundleSession(
  store: SessionStore,
  sessionId: string,
  bundledAt: number,
): SessionBundle {
  const transcriptPath = store.filePath(sessionId);
  const transcriptLines = fs.existsSync(transcriptPath)
    ? fs.readFileSync(transcriptPath, "utf-8").split("\n").filter((line) => line.length > 0)
    : [];
  const sidecars: SessionBundleSidecars = {};
  const name = readSidecarRaw(store.namePath(sessionId));
  if (name !== undefined) sidecars.name = name;
  const goal = readSidecarRaw(store.goalPath(sessionId));
  if (goal !== undefined) sidecars.goal = goal;
  const notes = readSidecarRaw(notesPath(store, sessionId));
  if (notes !== undefined) sidecars.notes = notes;
  const pinned = readSidecarRaw(store.pinnedPath(sessionId));
  if (pinned !== undefined) sidecars.pinned = pinned;
  const archived = readSidecarRaw(store.archivedPath(sessionId));
  if (archived !== undefined) sidecars.archived = archived;
  const turn = readSidecarRaw(sessionTurnLogPath(store, sessionId));
  if (turn !== undefined) sidecars.turn = turn;
  return {
    schema: SESSION_BUNDLE_SCHEMA,
    v: SESSION_BUNDLE_VERSION,
    bundledAt,
    sourceSessionId: sessionId,
    transcriptLines,
    sidecars,
  };
}

/**
 * Validate an unknown value as a session bundle (Issue #704). Fail-closed:
 * anything short of the full shape is rejected.
 */
export function isSessionBundle(value: unknown): value is SessionBundle {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === SESSION_BUNDLE_SCHEMA &&
    candidate.v === SESSION_BUNDLE_VERSION &&
    typeof candidate.sourceSessionId === "string" &&
    Array.isArray(candidate.transcriptLines) &&
    candidate.transcriptLines.every((line) => typeof line === "string") &&
    candidate.sidecars !== null &&
    typeof candidate.sidecars === "object"
  );
}

/**
 * Restore a validated bundle as a NEW session (Issue #704). Never
 * overwrites: the new id is freshly allocated; existing sessions are
 * untouched. Turn-log entries are rewritten to the new session id;
 * everything else lands as carried (store-canonical JSON for parsed
 * sidecars, raw bytes for sidecars carried raw).
 */
export function restoreSessionBundle(
  store: SessionStore,
  bundle: SessionBundle,
): { sessionId: string } {
  const sessionId = store.newId();
  const transcript =
    bundle.transcriptLines.length > 0 ? bundle.transcriptLines.join("\n") + "\n" : "";
  fs.writeFileSync(store.filePath(sessionId), transcript);
  const { name, goal, notes, pinned, archived, turn } = bundle.sidecars;
  if (name !== undefined) fs.writeFileSync(store.namePath(sessionId), name);
  if (goal !== undefined) fs.writeFileSync(store.goalPath(sessionId), goal);
  if (notes !== undefined) fs.writeFileSync(notesPath(store, sessionId), notes);
  if (pinned !== undefined) fs.writeFileSync(store.pinnedPath(sessionId), pinned);
  if (archived !== undefined) fs.writeFileSync(store.archivedPath(sessionId), archived);
  if (turn !== undefined) {
    // The turn log is the only sidecar that cannot ride along raw: its
    // entries carry the source session id, which must become the new id.
    // The stored shape is { checkpoints: [...] }.
    const rewriteEntries = (entries: unknown[]): unknown[] =>
      entries.map((entry) =>
        entry !== null && typeof entry === "object" && "sessionId" in entry
          ? { ...(entry as Record<string, unknown>), sessionId }
          : entry,
      );
    let rewritten = turn;
    try {
      const parsed = JSON.parse(turn);
      if (Array.isArray(parsed)) {
        rewritten = JSON.stringify(rewriteEntries(parsed));
      } else if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.checkpoints)) {
        rewritten = JSON.stringify({ ...parsed, checkpoints: rewriteEntries(parsed.checkpoints) });
      }
    } catch {
      // A torn turn log rides along raw rather than vanishing.
    }
    fs.writeFileSync(sessionTurnLogPath(store, sessionId), rewritten);
  }
  return { sessionId };
}
