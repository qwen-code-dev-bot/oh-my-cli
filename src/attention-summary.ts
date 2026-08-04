// Return-to-work attention summary (Issue #558): one bounded, redacted,
// workspace-scoped view of what needs action after time away. Assembled
// read-only from durable state — session integrity (#454/#546 lineage), the
// resumable-partial classification, and the most recent turn outcome per
// session (#550 cancelled placeholders, #243 interrupted turns) — scoped by
// the same canonical workspace identity as --continue and the #554 resume
// guard. Pure read: never heals, quarantines, seals, approves, retries, or
// mutates anything, and never treats a listed action as executed.

import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { workspaceTrustKey } from "./folder-trust.js";
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import { CANCELLED_TOOL_CONTENT } from "./agent.js";
import { shortSessionId } from "./session-picker.js";
import type { SessionMessage, SessionStore } from "./session.js";

export const ATTENTION_SCHEMA = "oh-my-cli.attention";
export const ATTENTION_VERSION = 1;

// Bound the view so a huge store cannot flood the output; overflow is counted,
// never silently dropped.
export const ATTENTION_MAX_ITEMS = 50;

export type AttentionItemType =
  | "corrupt-session"
  | "partial-session"
  | "turn-completed"
  | "turn-failed"
  | "turn-cancelled";

export interface AttentionItem {
  type: AttentionItemType;
  sessionId: string;
  /** Raw user-owned name when set; renderers redact before display. */
  name?: string;
  model?: string;
  workspace?: string;
  lastModified: number;
  ageMs: number;
  /** Human status line: what the durable state says right now. */
  status: string;
  /** Safe next-step hints (commands to run, never executed actions). */
  actions: string[];
}

// Deterministic ordering rank: lower is more urgent. Corrupt data needs
// salvage; a failed turn needs inspection; a partial checkpoint is a recovery
// opportunity; cancellations and completions are informational return-to-work
// context.
const SEVERITY: Record<AttentionItemType, number> = {
  "corrupt-session": 0,
  "turn-failed": 1,
  "partial-session": 2,
  "turn-cancelled": 3,
  "turn-completed": 4,
};

// Derive the most recent turn's outcome from a parsed transcript, or null
// when the session has no user turn to attribute one to. Conservative by
// design: a turn is "completed" only when it ends in a final assistant answer;
// a cancelled placeholder anywhere in the last turn marks it cancelled (#550);
// anything else that did not reach a final answer reads as failed (with the
// specific reason carried as detail).
export function deriveLastTurnOutcome(
  messages: readonly SessionMessage[],
): { outcome: "completed" | "failed" | "cancelled"; detail: string } | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return null;
  const tail = messages.slice(lastUser + 1);
  if (tail.length === 0) {
    return { outcome: "failed", detail: "no response was recorded for the last prompt" };
  }
  if (tail.some((m) => m.role === "tool" && m.content === CANCELLED_TOOL_CONTENT)) {
    return { outcome: "cancelled", detail: "cancelled at a safe boundary; the transcript is resume-valid" };
  }
  const last = tail[tail.length - 1];
  const lastAssistant = [...tail].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.interrupted === true) {
    return { outcome: "failed", detail: "interrupted mid-stream; the partial answer was preserved" };
  }
  if (last.role === "assistant" && typeof last.content === "string" && !Array.isArray(last.tool_calls)) {
    return { outcome: "completed", detail: "final answer delivered" };
  }
  return { outcome: "failed", detail: "the turn did not reach a final answer" };
}

export interface BuildAttentionOptions {
  store: SessionStore;
  workspacePath: string;
  /** Injectable canonical-key function for deterministic tests. */
  keyOf?: (workspacePath: string) => string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

// Collect the attention items for one workspace. Sessions whose workspace
// cannot be verified (missing metadata or un-canonicalizable identity) are
// excluded — a scoped view never surfaces a session it cannot attribute.
// Exactly one item per session: integrity classes (corrupt/partial) take
// precedence over the turn outcome they would otherwise report.
export function buildAttention(opts: BuildAttentionOptions): AttentionItem[] {
  const keyOf = opts.keyOf ?? workspaceTrustKey;
  const currentKey = keyOf(opts.workspacePath);
  const now = (opts.now ?? (() => Date.now()))();
  const items: AttentionItem[] = [];

  for (const s of collectSessionSummaries(opts.store, { now: () => now })) {
    if (!s.workspace) continue;
    let key: string;
    try {
      key = keyOf(s.workspace);
    } catch {
      continue;
    }
    if (key !== currentKey) continue;

    const base = {
      sessionId: s.id,
      ...(s.name ? { name: s.name } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.workspace ? { workspace: s.workspace } : {}),
      lastModified: s.lastModified,
      ageMs: s.ageMs,
    };
    const shortId = shortSessionId(s.id);

    if (s.corrupt) {
      items.push({
        ...base,
        type: "corrupt-session",
        status: "session is corrupt and cannot be resumed safely",
        actions: [`salvage recoverable turns with --salvage-session ${shortId}`, "list all sessions with --list-sessions"],
      });
      continue;
    }

    const integrity = opts.store.integrity(s.id).status;
    if (integrity === "partial") {
      items.push({
        ...base,
        type: "partial-session",
        status: "an interrupted write left a recoverable trailing partial line",
        actions: [`resume with --resume ${shortId}`, `inspect with --session-stats ${shortId}`],
      });
      continue;
    }

    const outcome = deriveLastTurnOutcome(opts.store.load(s.id));
    if (outcome === null) continue;
    const type: AttentionItemType =
      outcome.outcome === "completed"
        ? "turn-completed"
        : outcome.outcome === "cancelled"
          ? "turn-cancelled"
          : "turn-failed";
    items.push({
      ...base,
      type,
      status: outcome.detail,
      actions:
        outcome.outcome === "completed"
          ? [`continue with --resume ${shortId}`, `inspect with --session-stats ${shortId}`]
          : [`inspect with --session-stats ${shortId}`, `resume with --resume ${shortId}`],
    });
  }

  items.sort(
    (a, b) =>
      SEVERITY[a.type] - SEVERITY[b.type] ||
      b.lastModified - a.lastModified ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return items;
}

export interface AttentionRecord {
  schema: typeof ATTENTION_SCHEMA;
  v: typeof ATTENTION_VERSION;
  /** Redacted workspace path (home collapsed to ~). */
  workspace: string;
  total: number;
  shown: number;
  omitted: number;
  items: Array<{
    type: AttentionItemType;
    sessionId: string;
    name?: string;
    model: string;
    workspace: string;
    lastModified: number;
    ageMs: number;
    status: string;
    actions: string[];
  }>;
}

export function attentionRecord(items: AttentionItem[], workspacePath: string): AttentionRecord {
  const shown = items.slice(0, ATTENTION_MAX_ITEMS);
  return {
    schema: ATTENTION_SCHEMA,
    v: ATTENTION_VERSION,
    workspace: redactPath(workspacePath),
    total: items.length,
    shown: shown.length,
    omitted: items.length - shown.length,
    items: shown.map((it) => ({
      type: it.type,
      sessionId: it.sessionId,
      ...(it.name ? { name: redact(it.name) } : {}),
      model: redact(it.model),
      workspace: redactPath(it.workspace),
      lastModified: it.lastModified,
      ageMs: it.ageMs,
      status: it.status,
      actions: it.actions,
    })),
  };
}

export function formatAttention(items: AttentionItem[], workspacePath: string): string {
  const lines: string[] = [];
  lines.push(`Attention — workspace ${redactPath(workspacePath)}`);
  lines.push("─".repeat(40));
  lines.push("");

  if (items.length === 0) {
    lines.push("Nothing needs attention in this workspace.");
    return lines.join("\n");
  }

  const shown = items.slice(0, ATTENTION_MAX_ITEMS);
  for (const it of shown) {
    const symbol = it.type === "turn-completed" ? "✓" : it.type === "turn-cancelled" ? "⊘" : "!";
    const namePart = it.name ? `  "${redact(it.name)}"` : "";
    lines.push(`  ${symbol} ${it.type}  ${shortSessionId(it.sessionId)}${namePart}  ·  last active ${formatSessionAge(it.ageMs)}`);
    lines.push(`      ${it.status}`);
    for (const action of it.actions) lines.push(`      → ${action}`);
  }

  lines.push("");
  const overflow =
    items.length > ATTENTION_MAX_ITEMS
      ? `; ${items.length - ATTENTION_MAX_ITEMS} more not shown (see --list-sessions)`
      : "";
  lines.push(`${items.length} item(s)${overflow}. Read-only: nothing here executes or approves anything.`);
  return lines.join("\n");
}

function redact(value: string | undefined): string {
  if (!value) return "unknown";
  return redactSecrets(value).text;
}

function redactPath(p: string | undefined): string {
  if (!p) return "unknown";
  return redactSecrets(redactHomePath(p)).text;
}
