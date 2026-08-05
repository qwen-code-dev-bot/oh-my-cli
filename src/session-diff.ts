// Cross-session transcript comparison (Issue #622).
//
// Forking (#592) lets a session branch into a new id with `forkedFrom`
// provenance, but nothing relates two sessions to each other. This module
// compares two sessions read-only: per-side facts (integrity, role counts,
// provenance), the shared leading prefix (messages compared by role +
// content), per-side counts beyond the divergence point, and redacted
// bounded snippets of each side's first diverging message.
//
// Guarantees follow the read-only family conventions: heal-free resolution
// at the call site (corrupt sessions compare via their recoverable messages,
// verdicts stated honestly), redaction on every free-form value, deterministic
// output, and zero mutation of the store.

import type { SessionStore, SessionMessage } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";

export const SESSION_DIFF_SCHEMA = "oh-my-cli.session-diff" as const;
export const SESSION_DIFF_VERSION = 1 as const;

/** Bound for first-divergence snippets (chars), applied after redaction. */
const SNIPPET_MAX_CHARS = 120;

export interface SessionDiffSide {
  sessionId: string;
  shortId: string;
  /** Redacted user-owned name, or null when unset. */
  name: string | null;
  integrity: "ok" | "partial" | "corrupt";
  messages: number;
  user: number;
  assistant: number;
  system: number;
  tool: number;
  /** The source session id when this side is a fork (#592). */
  forkedFrom: string | null;
}

export interface SessionDiffRecord {
  schema: typeof SESSION_DIFF_SCHEMA;
  v: typeof SESSION_DIFF_VERSION;
  a: SessionDiffSide;
  b: SessionDiffSide;
  /** How the two sessions are related by fork provenance, if at all. */
  forkRelationship: "b-forked-from-a" | "a-forked-from-b" | null;
  /** Count of identical leading messages (role + content). */
  sharedPrefix: number;
  /** Messages on A beyond the shared prefix. */
  aBeyond: number;
  /** Messages on B beyond the shared prefix. */
  bBeyond: number;
  /** Redacted, bounded snippet of the first diverging message, if any. */
  aFirstDivergence: string | null;
  bFirstDivergence: string | null;
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

function snippet(message: SessionMessage): string {
  const content = typeof message.content === "string" ? message.content : "(no text content)";
  const redacted = redact(content);
  return redacted.length <= SNIPPET_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

function sameMessage(x: SessionMessage, y: SessionMessage): boolean {
  const xc = typeof x.content === "string" ? x.content : null;
  const yc = typeof y.content === "string" ? y.content : null;
  return x.role === y.role && xc === yc;
}

function side(store: SessionStore, id: string): SessionDiffSide | null {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") return null;
  const diag = store.loadWithDiagnostics(id);
  let user = 0;
  let assistant = 0;
  let system = 0;
  let tool = 0;
  for (const m of diag.messages) {
    if (m.role === "user") user++;
    else if (m.role === "assistant") assistant++;
    else if (m.role === "system") system++;
    else if (m.role === "tool") tool++;
  }
  const name = store.readName(id);
  return {
    sessionId: id,
    shortId: shortSessionId(id),
    name: name !== null ? redact(name) : null,
    integrity: integrity.status as SessionDiffSide["integrity"],
    messages: diag.messages.length,
    user,
    assistant,
    system,
    tool,
    forkedFrom: typeof diag.meta?.forkedFrom === "string" ? diag.meta.forkedFrom : null,
  };
}

/**
 * Build the comparison of two sessions. Returns an error string (not
 * throwing) when either session is missing so the CLI can map it to a
 * meaningful exit status. Reading never mutates the store.
 */
export function buildSessionDiff(
  store: SessionStore,
  aId: string,
  bId: string,
): { diff: SessionDiffRecord } | { error: string } {
  const aSide = side(store, aId);
  if (aSide === null) return { error: `no such session "${aId}"` };
  const bSide = side(store, bId);
  if (bSide === null) return { error: `no such session "${bId}"` };

  const aMessages = store.loadWithDiagnostics(aId).messages;
  const bMessages = store.loadWithDiagnostics(bId).messages;
  const sharedMax = Math.min(aMessages.length, bMessages.length);
  let sharedPrefix = 0;
  while (sharedPrefix < sharedMax && sameMessage(aMessages[sharedPrefix], bMessages[sharedPrefix])) {
    sharedPrefix++;
  }

  const aBeyond = aMessages.length - sharedPrefix;
  const bBeyond = bMessages.length - sharedPrefix;
  const diverged = sharedPrefix < Math.max(aMessages.length, bMessages.length);

  return {
    diff: {
      schema: SESSION_DIFF_SCHEMA,
      v: SESSION_DIFF_VERSION,
      a: aSide,
      b: bSide,
      forkRelationship:
        bSide.forkedFrom === aId
          ? "b-forked-from-a"
          : aSide.forkedFrom === bId
            ? "a-forked-from-b"
            : null,
      sharedPrefix,
      aBeyond,
      bBeyond,
      aFirstDivergence: diverged && sharedPrefix < aMessages.length ? snippet(aMessages[sharedPrefix]) : null,
      bFirstDivergence: diverged && sharedPrefix < bMessages.length ? snippet(bMessages[sharedPrefix]) : null,
    },
  };
}

export function formatSessionDiff(record: SessionDiffRecord): string[] {
  const lines: string[] = [];
  lines.push(`Session diff — ${record.a.shortId} ↔ ${record.b.shortId}`);
  lines.push("─".repeat(40));
  lines.push("");
  for (const [label, s] of [["A", record.a], ["B", record.b]] as const) {
    const name = s.name !== null ? ` · "${s.name}"` : "";
    const fork = s.forkedFrom !== null ? ` · forked from ${shortSessionId(s.forkedFrom)}` : "";
    lines.push(
      `${label}: ${s.shortId} (${s.integrity}) · ${s.messages} msgs ` +
        `(user ${s.user}, assistant ${s.assistant}, system ${s.system}, tool ${s.tool})${name}${fork}`,
    );
  }
  if (record.forkRelationship !== null) {
    lines.push(
      record.forkRelationship === "b-forked-from-a"
        ? "provenance: B is a fork of A"
        : "provenance: A is a fork of B",
    );
  }
  lines.push("");
  lines.push(`shared:     ${record.sharedPrefix} leading message(s) identical`);
  if (record.aBeyond === 0 && record.bBeyond === 0) {
    lines.push("result:     sessions are identical across all messages");
    return lines;
  }
  lines.push(`divergence: A has ${record.aBeyond} message(s) beyond · B has ${record.bBeyond} message(s) beyond`);
  if (record.aFirstDivergence !== null) {
    lines.push(`first divergence A: ${record.aFirstDivergence}`);
  }
  if (record.bFirstDivergence !== null) {
    lines.push(`first divergence B: ${record.bFirstDivergence}`);
  }
  return lines;
}
