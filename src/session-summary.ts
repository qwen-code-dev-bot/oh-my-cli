// Resumable-session listing with a redacted usage summary.
//
// Before restoring a session a user needs to recognise it: which model and
// repository it belongs to, how long ago it was last active, and roughly how
// much context will be reloaded. This module enumerates the session store
// read-only, derives that summary per session, and renders a redacted list.
// A missing or corrupt session is reported without disturbing it or any other
// checkpoint.

import fs from "node:fs";
import { redactSecrets } from "./permission-impact.js";
import type { SessionStore } from "./session.js";

export interface SessionSummary {
  id: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  totalChars: number;
  /** Rough context-size estimate (chars / 4); labelled as an estimate. */
  approxTokens: number;
  model?: string;
  workspace?: string;
  createdAt: number | null;
  lastModified: number;
  ageMs: number;
  corrupt: boolean;
}

export interface SessionSummaryOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const CHARS_PER_TOKEN = 4;

export function collectSessionSummaries(
  store: SessionStore,
  opts: SessionSummaryOptions = {},
): SessionSummary[] {
  const now = (opts.now ?? (() => Date.now()))();
  const summaries: SessionSummary[] = [];
  for (const id of store.listIds()) {
    summaries.push(summarize(store, id, now));
  }
  // Most recently active first, so the session worth resuming is on top.
  summaries.sort((a, b) => b.lastModified - a.lastModified);
  return summaries;
}

function summarize(store: SessionStore, id: string, now: number): SessionSummary {
  const diag = store.loadWithDiagnostics(id);

  let lastModified = now;
  try {
    lastModified = fs.statSync(store.filePath(id)).mtimeMs;
  } catch {
    /* fall back to now if the file vanished between listing and stat */
  }

  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let totalChars = 0;
  for (const m of diag.messages) {
    if (m.role === "user") userTurns++;
    else if (m.role === "assistant") assistantTurns++;
    if (Array.isArray(m.tool_calls)) toolCalls += m.tool_calls.length;
    if (typeof m.content === "string") totalChars += m.content.length;
  }

  return {
    id,
    messageCount: diag.messages.length,
    userTurns,
    assistantTurns,
    toolCalls,
    totalChars,
    approxTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    model: diag.meta?.model,
    workspace: diag.meta?.workspace,
    createdAt: diag.meta?.createdAt ?? null,
    lastModified,
    ageMs: Math.max(0, now - lastModified),
    corrupt: diag.corrupt,
  };
}

export function formatSessionList(summaries: SessionSummary[]): string {
  const lines: string[] = [];
  lines.push("Sessions");
  lines.push("─".repeat(40));

  if (summaries.length === 0) {
    lines.push("");
    lines.push("No resumable sessions found.");
    return lines.join("\n");
  }

  lines.push("");
  for (const s of summaries) lines.push(...formatSessionLines(s));

  const corrupt = summaries.filter((s) => s.corrupt).length;
  lines.push("");
  lines.push(
    `Summary: ${summaries.length - corrupt} resumable, ${corrupt} corrupt ` +
      `(${summaries.length} total)`,
  );
  lines.push("");
  lines.push(`Resume one with: oh-my-cli --resume <session-id> -p "<prompt>"`);

  return lines.join("\n");
}

function formatSessionLines(s: SessionSummary): string[] {
  const symbol = s.corrupt ? "✗" : "✓";
  const flag = s.corrupt ? "  (corrupt — partial recovery)" : "";
  const head = `  ${symbol} ${s.id}${flag}`;
  const provenance = `model ${redact(s.model)}  ·  repo ${redactPath(s.workspace)}`;
  const usage =
    `${s.messageCount} msgs, ${s.userTurns + s.assistantTurns} turns, ` +
    `${s.toolCalls} tool calls, ~${s.approxTokens} tokens (est.)`;
  const age = `last active ${formatSessionAge(s.ageMs)}`;
  return [head, `      ${provenance}`, `      ${usage}  ·  ${age}`];
}

function redact(value: string | undefined): string {
  if (!value) return "unknown";
  return redactSecrets(value).text;
}

function redactPath(p: string | undefined): string {
  if (!p) return "unknown";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  let out = p;
  if (home && out.startsWith(home)) out = "~" + out.slice(home.length);
  return redactSecrets(out).text;
}

// Human-friendly "last active" bucket. Exported so the interactive session
// picker (session-picker.ts) renders the same age labels as the static list.
export function formatSessionAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
