// Session compaction: collapse a long transcript into a bounded, versioned,
// deterministic summary so a session can continue past a provider context limit
// without losing task or execution state.
//
// Design contract (Issue #88):
//   - The full transcript on disk is NEVER mutated or truncated. Compaction is a
//     sidecar artifact; resume re-derives the live context from the full
//     transcript plus a validated sidecar.
//   - The summary is deterministic (no LLM, no timestamps in content) so it can
//     be tested and inspected, and bounded so its size never grows with the
//     transcript.
//   - Completed mutations and approvals are represented as receipts/references
//     with an explicit "do not repeat" instruction, so removing detailed turns
//     never causes a completed action to be re-run.
//   - Loading fails closed: a missing, corrupt, schema-mismatched, or
//     digest-mismatched sidecar is ignored and the original full transcript is
//     used instead. The original session is always preserved.
//   - This module is the single consumption point for compacted state. Every
//     resume path (interactive, headless, TUI, and future subagent/Workflow)
//     routes through loadSessionMessages so they share one contract.

import fs from "node:fs";
import crypto from "node:crypto";
import type { SessionMessage, SessionStore } from "./session.js";
import { createTools } from "./tools.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";

export const COMPACTION_SCHEMA = "oh-my-cli.compaction";
export const COMPACTION_VERSION = 1;

// A completed tool action, reduced to a bounded reference. The detailed turn is
// gone but the fact that the action ran (and its outcome) survives, so a resume
// never repeats it.
export interface CompactionReceipt {
  toolCallId: string;
  tool: string;
  category: string;
  outcome: "ok" | "error";
  reference: string;
}

export interface CompactionSummary {
  schema: typeof COMPACTION_SCHEMA;
  version: typeof COMPACTION_VERSION;
  // sha256 over the first `messageCount` messages of the source transcript. On
  // resume this must match the head of the full transcript, or the sidecar is
  // rejected (fail closed). Pins the summary to the exact transcript it
  // summarized.
  sourceDigest: string;
  messageCount: number;
  // The overarching goal: the first user directive.
  activeTask: string;
  // Subsequent user directives: constraints, corrections, decisions.
  decisions: string[];
  // User directives that never received a final assistant answer: pending work.
  pendingSteps: string[];
  // Distinct files written or edited (redacted).
  fileChanges: string[];
  // Tool actions that appear to have failed (redacted, bounded).
  failures: string[];
  // All tool actions, in order, as bounded references.
  receipts: CompactionReceipt[];
}

// Bounds that keep the summary size independent of transcript length.
const MAX_FIELD = 500;
const MAX_REFERENCE = 160;
const MAX_DECISIONS = 50;
const MAX_PENDING = 50;
const MAX_FILE_CHANGES = 200;
const MAX_FAILURES = 50;
const MAX_RECEIPTS = 400;

// Tool name -> category, derived from the live tool registry so the receipt
// classification never drifts from the tools actually available.
function toolCategoryMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of createTools()) {
    map.set(tool.name, tool.category);
  }
  return map;
}

function clampText(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)} …[+${oneLine.length - max} chars]`;
}

function redactClamp(value: string, max: number): string {
  return clampText(redactSecrets(value).text, max);
}

// Deterministic content digest of a message prefix. Fixed-shape per-message
// JSON keeps the hash stable across runs and independent of incidental field
// ordering.
export function digestMessages(messages: SessionMessage[]): string {
  const normalized = messages.map((m) =>
    JSON.stringify({
      role: m.role,
      content: m.content ?? null,
      tool_calls: m.tool_calls ?? null,
      tool_call_id: m.tool_call_id ?? null,
    }),
  );
  return crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
}

function textOf(message: SessionMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function isFinalAssistant(message: SessionMessage): boolean {
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    (!message.tool_calls || message.tool_calls.length === 0)
  );
}

// Heuristic outcome classification: the persisted tool result carries only text,
// not the original isError flag, so an error is recognized by its conventional
// prefix.
function looksLikeError(content: string): boolean {
  return /^(Error:|Exit code|Tool denied|Tool execution denied|Tool error)/.test(content.trim());
}

// A bounded, redacted reference to what a tool call targeted. The target class
// (path or command shape) is preserved; secrets and home paths are redacted.
function referenceFor(
  tool: string,
  rawArgs: string,
): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return tool;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  switch (tool) {
    case "write":
    case "edit":
    case "read": {
      const p = str(parsed.path);
      return p ? `${tool} ${redactHomePath(p)}` : tool;
    }
    case "list": {
      const p = str(parsed.path);
      return p ? `list ${redactHomePath(p)}` : "list";
    }
    case "glob": {
      const pat = str(parsed.pattern);
      return pat ? `glob ${pat}` : "glob";
    }
    case "grep": {
      const pat = str(parsed.pattern);
      return pat ? `grep ${pat}` : "grep";
    }
    case "shell": {
      const cmd = str(parsed.command);
      return cmd ? `shell: ${redactClamp(cmd, MAX_REFERENCE - 7)}` : "shell";
    }
    default:
      return tool;
  }
}

export interface CompactionResult {
  summary: CompactionSummary;
}

// Deterministically summarize a transcript. Pure: identical input always yields
// an identical summary (no timestamps, no randomness), so it is testable and the
// digest is reproducible on resume.
export function compactMessages(messages: SessionMessage[]): CompactionResult {
  const categories = toolCategoryMap();

  const userMessages: string[] = [];
  const decisions: string[] = [];
  const fileChanges: string[] = [];
  const failures: string[] = [];
  const receipts: CompactionReceipt[] = [];

  // Index tool results by their originating call id so an assistant tool_call
  // can be paired with its outcome.
  const resultByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, textOf(m));
    }
  }

  for (const m of messages) {
    if (m.role === "user") {
      const text = redactClamp(textOf(m), MAX_FIELD);
      if (text) {
        if (userMessages.length === 0) {
          userMessages.push(text);
        } else {
          decisions.push(text);
        }
      }
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const category = categories.get(tc.function.name) ?? "unknown";
        const resultText = resultByCallId.get(tc.id) ?? "";
        const outcome: "ok" | "error" = looksLikeError(resultText) ? "error" : "ok";
        const reference = redactClamp(referenceFor(tc.function.name, tc.function.arguments), MAX_REFERENCE);
        if (receipts.length < MAX_RECEIPTS) {
          receipts.push({ toolCallId: tc.id, tool: tc.function.name, category, outcome, reference });
        }
        if ((category === "mutate-file") && (tc.function.name === "write" || tc.function.name === "edit")) {
          const fileRef = referenceFor(tc.function.name, tc.function.arguments);
          const path = fileRef.replace(/^(write|edit)\s+/, "");
          if (path && fileChanges.length < MAX_FILE_CHANGES && !fileChanges.includes(path)) {
            fileChanges.push(path);
          }
        }
        if (outcome === "error" && failures.length < MAX_FAILURES) {
          failures.push(redactClamp(`${tc.function.name}: ${resultText}`, MAX_FIELD));
        }
      }
    }
  }

  // Pending work: user directives that arrived after the last final assistant
  // answer (or all of them, if the agent never produced a final answer).
  let lastFinalIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isFinalAssistant(messages[i])) lastFinalIdx = i;
  }
  const pendingSteps: string[] = [];
  let seenUser = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      if (seenUser === 0) {
        seenUser++;
        continue; // the active task, not pending
      }
      seenUser++;
      if (i > lastFinalIdx && pendingSteps.length < MAX_PENDING) {
        const text = redactClamp(textOf(m), MAX_FIELD);
        if (text) pendingSteps.push(text);
      }
    }
  }

  const summary: CompactionSummary = {
    schema: COMPACTION_SCHEMA,
    version: COMPACTION_VERSION,
    sourceDigest: digestMessages(messages),
    messageCount: messages.length,
    activeTask: userMessages[0] ?? "",
    decisions: decisions.slice(0, MAX_DECISIONS),
    pendingSteps,
    fileChanges,
    failures,
    receipts,
  };

  return { summary };
}

// Render the summary as a system message that resumes the session. The
// "do NOT repeat" framing is what makes completed mutations sticky: the model is
// told explicitly that the listed actions already happened.
export function renderSummaryMessage(summary: CompactionSummary): SessionMessage {
  const lines: string[] = [];
  lines.push(`[${COMPACTION_SCHEMA} v${COMPACTION_VERSION}] This session was compacted to stay within the provider context limit. Below is a bounded summary of earlier work; the full transcript is preserved on disk and was not modified.`);
  lines.push("");
  if (summary.activeTask) {
    lines.push(`Active task: ${summary.activeTask}`);
  }
  if (summary.decisions.length > 0) {
    lines.push("Decisions & constraints:");
    for (const d of summary.decisions) lines.push(`  - ${d}`);
  }
  if (summary.receipts.length > 0) {
    lines.push("Already completed (do NOT repeat these actions):");
    for (const r of summary.receipts) {
      const mark = r.outcome === "error" ? " [error]" : "";
      lines.push(`  - ${r.reference}${mark}`);
    }
  }
  if (summary.fileChanges.length > 0) {
    lines.push(`Files changed: ${summary.fileChanges.join(", ")}`);
  }
  if (summary.failures.length > 0) {
    lines.push("Unresolved failures:");
    for (const f of summary.failures) lines.push(`  - ${f}`);
  }
  if (summary.pendingSteps.length > 0) {
    lines.push("Pending work:");
    for (const p of summary.pendingSteps) lines.push(`  - ${p}`);
  }
  lines.push("");
  lines.push("Continue from the current state. Do not re-run completed actions; resume pending work using the constraints above.");
  return { role: "system", content: lines.join("\n") };
}

// Build the live transcript used on resume: the original system message (if any)
// followed by the summary note. The detailed turns are dropped from the live
// context but remain on disk.
export function buildCompactedTranscript(
  full: SessionMessage[],
  summary: CompactionSummary,
): SessionMessage[] {
  const out: SessionMessage[] = [];
  const system = full[0];
  if (system && system.role === "system") {
    out.push(system);
  }
  out.push(renderSummaryMessage(summary));
  return out;
}

// Validate an untrusted parsed object as a CompactionSummary. Returns null on any
// shape mismatch so loading fails closed.
function asSummary(value: unknown): CompactionSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== COMPACTION_SCHEMA) return null;
  if (v.version !== COMPACTION_VERSION) return null;
  if (typeof v.sourceDigest !== "string") return null;
  if (typeof v.messageCount !== "number" || v.messageCount < 0) return null;
  if (typeof v.activeTask !== "string") return null;
  const strArray = (x: unknown): string[] | null =>
    Array.isArray(x) && x.every((e) => typeof e === "string") ? (x as string[]) : null;
  const decisions = strArray(v.decisions);
  const pendingSteps = strArray(v.pendingSteps);
  const fileChanges = strArray(v.fileChanges);
  const failures = strArray(v.failures);
  if (!decisions || !pendingSteps || !fileChanges || !failures) return null;
  if (!Array.isArray(v.receipts)) return null;
  const receipts: CompactionReceipt[] = [];
  for (const r of v.receipts) {
    if (typeof r !== "object" || r === null) return null;
    const rr = r as Record<string, unknown>;
    if (typeof rr.toolCallId !== "string") return null;
    if (typeof rr.tool !== "string") return null;
    if (typeof rr.category !== "string") return null;
    if (rr.outcome !== "ok" && rr.outcome !== "error") return null;
    if (typeof rr.reference !== "string") return null;
    receipts.push({
      toolCallId: rr.toolCallId,
      tool: rr.tool,
      category: rr.category,
      outcome: rr.outcome,
      reference: rr.reference,
    });
  }
  return {
    schema: COMPACTION_SCHEMA,
    version: COMPACTION_VERSION,
    sourceDigest: v.sourceDigest,
    messageCount: v.messageCount,
    activeTask: v.activeTask,
    decisions,
    pendingSteps,
    fileChanges,
    failures,
    receipts,
  };
}

// Persist a summary as a sidecar next to the session. Atomic temp+rename so a
// crash never leaves a half-written sidecar.
export function saveCompaction(sidecarPath: string, summary: CompactionSummary): void {
  const tmp = `${sidecarPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, sidecarPath);
}

// Load and validate a sidecar. Returns null on missing, unreadable, unparseable,
// or schema-mismatched content (fail closed).
export function loadCompaction(sidecarPath: string): CompactionSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return asSummary(parsed);
}

// Human-readable, redacted report of a summary for the `--compact` command, so
// the operator can inspect what will be retained before resuming.
export function formatCompaction(summary: CompactionSummary): string {
  const lines: string[] = [];
  lines.push(`Compaction summary (${summary.schema} v${summary.version})`);
  lines.push(`  Source messages summarized: ${summary.messageCount}`);
  lines.push(`  Source digest: ${summary.sourceDigest.slice(0, 16)}…`);
  lines.push(`  Active task: ${summary.activeTask || "(none)"}`);
  lines.push(`  Decisions/constraints: ${summary.decisions.length}`);
  lines.push(`  Completed receipts: ${summary.receipts.length}`);
  lines.push(`  Files changed: ${summary.fileChanges.length}`);
  lines.push(`  Failures: ${summary.failures.length}`);
  lines.push(`  Pending steps: ${summary.pendingSteps.length}`);
  return lines.join("\n");
}

// The single resume consumption point. Loads the full transcript and, only when
// a valid sidecar exists whose digest matches the head of that transcript,
// returns the compacted live context. Otherwise the full transcript is returned
// unchanged (fail closed). The on-disk transcript is never modified.
export function loadSessionMessages(store: SessionStore, id: string): SessionMessage[] {
  const full = store.load(id);
  if (full.length === 0) return full;

  const sidecarPath = store.compactPath(id);
  const summary = loadCompaction(sidecarPath);
  if (!summary) return full;
  if (full.length < summary.messageCount) return full;

  const head = full.slice(0, summary.messageCount);
  if (digestMessages(head) !== summary.sourceDigest) return full;

  return buildCompactedTranscript(full, summary);
}
