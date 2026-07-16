import type { AgentSink } from "./agent.js";
import type { ToolResult } from "./tools.js";
import type { RunSummary } from "./run-summary.js";
import { redactSecrets } from "./permission-impact.js";

// A stable, versioned newline-delimited JSON protocol for core run lifecycle
// events. It is opt-in (see `--output json`) and never affects the default
// interactive output. Every record is a self-describing JSON object on its own
// line so a consumer can parse each line independently and rely on the terminal
// `complete` record for success/failure exit semantics.
export const HEADLESS_PROTOCOL = "oh-my-cli.headless";
export const HEADLESS_VERSION = 1;

// Bounds that keep the stream free of large or untrusted payloads. Assistant
// text and tool output are redacted for secrets and capped; oversized values
// are truncated and flagged so a consumer can tell content was elided.
const MAX_TEXT = 32_768;
const MAX_TOOL_CONTENT = 8_192;
const MAX_NAME = 256;

export type HeadlessEvent =
  | { type: "start"; sessionId: string; model: string; prompt: string }
  | { type: "assistant"; round: number; final: boolean; text: string; truncated: boolean }
  | { type: "tool_start"; round: number; id: string; name: string }
  | {
      type: "tool_result";
      round: number;
      id: string;
      name: string;
      ok: boolean;
      truncated: boolean;
      bytes: number;
      content: string;
      // Wall-clock execution time in milliseconds when the tool reports it
      // (e.g. shell); null for tools that do not measure elapsed time.
      elapsedMs: number | null;
    }
  | { type: "error"; stage: "provider" | "internal"; message: string }
  // Cumulative token usage and estimated cost, emitted once per round. The cost
  // is an estimate (never authoritative billing); `costKnown` reports whether the
  // model price was in the bundled table. `budgetReached` is true once the
  // running estimate has met or exceeded `budgetUsd` (null when no budget).
  | {
      type: "usage";
      round: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      costKnown: boolean;
      budgetUsd: number | null;
      budgetReached: boolean;
    }
  // Opt-in (`--summary`) privacy-safe run summary, emitted just before the
  // terminal `complete`. Carries only metadata, never prompt/tool/file content.
  | { type: "summary"; summary: RunSummary }
  | { type: "complete"; ok: boolean; exitCode: number; rounds: number; reason: string };

export type HeadlessRecord = HeadlessEvent & {
  protocol: typeof HEADLESS_PROTOCOL;
  v: typeof HEADLESS_VERSION;
  seq: number;
  ts: string;
};

export interface HeadlessOutput {
  write(chunk: string): void;
}

interface Redacted {
  text: string;
  truncated: boolean;
  bytes: number;
}

function safeText(input: string, max: number): Redacted {
  const redacted = redactSecrets(input ?? "").text;
  const bytes = Buffer.byteLength(redacted, "utf-8");
  if (redacted.length <= max) return { text: redacted, truncated: false, bytes };
  return { text: redacted.slice(0, max), truncated: true, bytes };
}

function safeName(name: string): string {
  return redactSecrets(name ?? "").text.slice(0, MAX_NAME);
}

// Build the opening record with user-controlled fields redacted and bounded.
export function startEvent(info: { sessionId: string; model: string; prompt: string }): HeadlessEvent {
  return {
    type: "start",
    sessionId: info.sessionId,
    model: safeName(info.model),
    prompt: safeText(info.prompt, MAX_TEXT).text,
  };
}

// Serializes events as NDJSON, stamping each with a monotonic sequence number
// and an ISO timestamp. A single writer instance is shared across the run so
// sequence numbers are globally ordered from `start` to `complete`.
export class HeadlessWriter {
  private seq = 0;
  private readonly out: HeadlessOutput;
  private readonly now: () => number;

  constructor(out: HeadlessOutput, now: () => number = Date.now) {
    this.out = out;
    this.now = now;
  }

  emit(event: HeadlessEvent): HeadlessRecord {
    const record = {
      protocol: HEADLESS_PROTOCOL,
      v: HEADLESS_VERSION,
      seq: this.seq++,
      ts: new Date(this.now()).toISOString(),
      ...event,
    } as HeadlessRecord;
    this.out.write(JSON.stringify(record) + "\n");
    return record;
  }
}

// Renders the agent loop's lifecycle as headless records. Assistant text is
// aggregated per turn (one record per turn) rather than emitted per token, which
// keeps the stream compact and schema-stable for CI consumers.
export function createHeadlessSink(writer: HeadlessWriter): AgentSink {
  return {
    assistantDelta: () => {
      /* aggregated and emitted once per turn via assistantTurn */
    },
    assistantTurn: (text, round, opts) => {
      if (!text) return;
      const s = safeText(text, MAX_TEXT);
      writer.emit({ type: "assistant", round, final: opts.final, text: s.text, truncated: s.truncated });
    },
    toolStart: ({ id, name, round }) => {
      writer.emit({ type: "tool_start", round, id, name: safeName(name) });
    },
    toolResult: ({ id, name, result, round }) => {
      const s = safeText(result.content ?? "", MAX_TOOL_CONTENT);
      writer.emit({
        type: "tool_result",
        round,
        id,
        name: safeName(name),
        ok: !result.isError,
        truncated: s.truncated,
        bytes: s.bytes,
        content: s.text,
        elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : null,
      });
    },
    providerError: (message) => {
      writer.emit({ type: "error", stage: "provider", message: redactSecrets(message ?? "").text });
    },
    usage: (info) => {
      writer.emit({
        type: "usage",
        round: info.round,
        promptTokens: info.tokens.prompt,
        completionTokens: info.tokens.completion,
        totalTokens: info.tokens.total,
        estimatedCostUsd: info.estimatedCostUsd,
        costKnown: info.costKnown,
        budgetUsd: info.budgetUsd,
        budgetReached: info.budgetReached,
      });
    },
  };
}

// A strict line parser used by tests and the dogfood harness: every line must
// parse independently and carry the expected protocol envelope.
export function parseHeadlessLine(line: string): HeadlessRecord {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("empty record");
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    throw new Error("record is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null) throw new Error("record is not an object");
  const r = obj as Record<string, unknown>;
  if (r.protocol !== HEADLESS_PROTOCOL) throw new Error(`unknown protocol: ${String(r.protocol)}`);
  if (r.v !== HEADLESS_VERSION) throw new Error(`unsupported version: ${String(r.v)}`);
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) {
    throw new Error("seq must be a non-negative integer");
  }
  if (typeof r.ts !== "string") throw new Error("ts must be a string");
  if (typeof r.type !== "string") throw new Error("type must be a string");
  return r as unknown as HeadlessRecord;
}

export function parseHeadlessStream(text: string): HeadlessRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(parseHeadlessLine);
}

export function terminalRecord(
  records: HeadlessRecord[],
): Extract<HeadlessRecord, { type: "complete" }> | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "complete") {
      return records[i] as Extract<HeadlessRecord, { type: "complete" }>;
    }
  }
  return null;
}
