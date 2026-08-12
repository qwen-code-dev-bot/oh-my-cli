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
import { atomicWriteFile } from "./atomic-write.js";

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
  // Issue #865: atomic writes (temp + rename) so an interrupted restore never
  // leaves a torn session; each file appears fully or not at all.
  atomicWriteFile(store.filePath(sessionId), transcript);
  const { name, goal, notes, pinned, archived, turn } = bundle.sidecars;
  if (name !== undefined) atomicWriteFile(store.namePath(sessionId), name);
  if (goal !== undefined) atomicWriteFile(store.goalPath(sessionId), goal);
  if (notes !== undefined) atomicWriteFile(notesPath(store, sessionId), notes);
  if (pinned !== undefined) atomicWriteFile(store.pinnedPath(sessionId), pinned);
  if (archived !== undefined) atomicWriteFile(store.archivedPath(sessionId), archived);
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
    atomicWriteFile(sessionTurnLogPath(store, sessionId), rewritten);
  }
  return { sessionId };
}

export const STORE_BUNDLE_SCHEMA = "oh-my-cli.store-bundle" as const;
export const STORE_BUNDLE_VERSION = 1 as const;

export interface StoreBundle {
  schema: typeof STORE_BUNDLE_SCHEMA;
  v: typeof STORE_BUNDLE_VERSION;
  bundledAt: number;
  sessionCount: number;
  /** Session bundles ordered by ascending source session id. */
  sessions: SessionBundle[];
}

/**
 * Build a lossless whole-store bundle (Issue #706): every session in the
 * store, each exactly the #704 session bundle, in deterministic
 * session-id order. Strictly read-only.
 */
export function bundleStore(store: SessionStore, bundledAt: number): StoreBundle {
  const ids = [...store.listIds()].sort((a, b) => a.localeCompare(b));
  const sessions = ids.map((id) => bundleSession(store, id, bundledAt));
  return {
    schema: STORE_BUNDLE_SCHEMA,
    v: STORE_BUNDLE_VERSION,
    bundledAt,
    sessionCount: sessions.length,
    sessions,
  };
}

/**
 * Validate an unknown value as a store bundle (Issue #706). Fail-closed:
 * the schema, version, session count, and every contained session entry
 * must all check out.
 */
export function isStoreBundle(value: unknown): value is StoreBundle {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== STORE_BUNDLE_SCHEMA) return false;
  if (candidate.v !== STORE_BUNDLE_VERSION) return false;
  if (!Array.isArray(candidate.sessions)) return false;
  if (candidate.sessionCount !== candidate.sessions.length) return false;
  return candidate.sessions.every(isSessionBundle);
}

/**
 * Restore a validated store bundle (Issue #706): every contained session
 * is materialized as a NEW id via restoreSessionBundle — existing sessions
 * are never touched. Callers must validate with isStoreBundle first.
 */
export function restoreStoreBundle(
  store: SessionStore,
  bundle: StoreBundle,
): { sessionIds: string[] } {
  const sessionIds: string[] = [];
  for (const session of bundle.sessions) {
    sessionIds.push(restoreSessionBundle(store, session).sessionId);
  }
  return { sessionIds };
}

export const BUNDLE_VERIFY_SCHEMA = "oh-my-cli.bundle-verify" as const;
export const BUNDLE_VERIFY_VERSION = 1 as const;

/** Integrity findings for one session bundle (Issue #708). */
export interface SessionBundleVerify {
  sourceSessionId: string;
  transcriptLines: number;
  tornTranscriptLines: number;
  /** Sidecars carried as raw text — torn at bundle time — by name. */
  tornSidecars: string[];
  healthy: boolean;
}

/**
 * Verify one session bundle (Issue #708). Strictly pure and read-only:
 * every transcript line must parse as JSON (torn lines are counted), and
 * every sidecar's carried content must parse as JSON. Sidecars ride as
 * raw stored text by construction (byte-fidelity, #704), so the check
 * parses that text and reports by name only what fails to parse.
 * Structural validation is the caller's job (isSessionBundle); this
 * assumes a validated bundle and inspects its content.
 */
export function verifySessionBundle(bundle: SessionBundle): SessionBundleVerify {
  let tornTranscriptLines = 0;
  for (const line of bundle.transcriptLines) {
    try {
      JSON.parse(line);
    } catch {
      tornTranscriptLines += 1;
    }
  }
  const tornSidecars: string[] = [];
  for (const [name, value] of Object.entries(bundle.sidecars)) {
    if (typeof value !== "string") continue; // carried as a parsed value: sound
    try {
      JSON.parse(value);
    } catch {
      tornSidecars.push(name);
    }
  }
  return {
    sourceSessionId: bundle.sourceSessionId,
    transcriptLines: bundle.transcriptLines.length,
    tornTranscriptLines,
    tornSidecars,
    healthy: tornTranscriptLines === 0 && tornSidecars.length === 0,
  };
}

export interface StoreBundleVerify {
  sessions: SessionBundleVerify[];
  healthy: boolean;
}

/**
 * Verify a store bundle (Issue #708): every contained session bundle is
 * checked with the session semantics; the store is healthy only when all
 * of them are.
 */
export function verifyStoreBundle(bundle: StoreBundle): StoreBundleVerify {
  const sessions = bundle.sessions.map(verifySessionBundle);
  return { sessions, healthy: sessions.every((s) => s.healthy) };
}

/**
 * Render bundle-verify findings as lines (Issue #708).
 */
export function formatBundleVerify(record: {
  kind: "session" | "store";
  sessions: SessionBundleVerify[];
  healthy: boolean;
}): string[] {
  const lines: string[] = [];
  lines.push("Bundle verify");
  lines.push("─".repeat(40));
  lines.push("");
  lines.push(`Bundle kind: ${record.kind}; ${record.sessions.length} session(s) checked.`);
  for (const session of record.sessions) {
    if (session.healthy) continue;
    const problems: string[] = [];
    if (session.tornTranscriptLines > 0) {
      problems.push(`${session.tornTranscriptLines} torn transcript line(s)`);
    }
    if (session.tornSidecars.length > 0) {
      problems.push(`torn sidecars: ${session.tornSidecars.join(", ")}`);
    }
    lines.push(`  ${shortIdOf(session.sourceSessionId)} — damaged (${problems.join("; ")})`);
  }
  lines.push("");
  lines.push(`Verdict: ${record.healthy ? "healthy" : "damaged"}.`);
  return lines;
}

function shortIdOf(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}
