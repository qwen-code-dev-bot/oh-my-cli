// Ask a side question without disturbing the main task.
//
// While a longer task is in progress, a user often wants a quick clarification.
// Routing it through the main conversation would alter task state, context
// compaction, tool plans, or the active goal. A side question instead runs
// against a bounded, read-only snapshot of the active session, with tool
// execution and workspace mutation disabled, and returns its answer inline
// without appending to the main transcript, goal, workflow, or retry chain.
//
// Isolation is structural, not best-effort: the runner takes only a provider
// config, a context snapshot, and the question. It has no session store, goal,
// approval, or workspace handle, so it cannot mutate any of them. The provider
// call is issued with no tool schemas, and any tool_call event is ignored, so a
// side turn can never execute a tool or touch the workspace.

import type { Config } from "./config.js";
import type { SessionMessage } from "./session.js";
import { streamChat } from "./provider.js";

export const SIDE_QUESTION_SCHEMA = "oh-my-cli.side-question" as const;
export const SIDE_QUESTION_VERSION = 1 as const;

// Defaults bound the snapshot so a side question stays cheap and predictable.
export const DEFAULT_SIDE_MAX_MESSAGES = 12;
export const DEFAULT_SIDE_MAX_CHARS = 4_000;

export interface SideContextOptions {
  /** Maximum recent messages to include (besides the system seed). */
  maxMessages?: number;
  /** Per-message content clamp, in characters. */
  maxChars?: number;
}

// A bounded, inspectable snapshot of the active session, safe to hand to a
// provider as side-question context. It is a copy — building it never mutates
// the source transcript.
export interface SideContext {
  schema: typeof SIDE_QUESTION_SCHEMA;
  v: typeof SIDE_QUESTION_VERSION;
  /** The snapshot messages to send (system seed first, then recent messages). */
  messages: SessionMessage[];
  /** Total messages in the source session when the snapshot was taken. */
  sourceMessageCount: number;
  /** How many recent (non-system) messages were included. */
  included: number;
  /** True when older messages were dropped to satisfy the bound. */
  truncated: boolean;
  /** True when a system seed message was carried into the snapshot. */
  systemPresent: boolean;
}

function clampContent(content: string | null | undefined, maxChars: number): string | null {
  if (content == null) return null;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}…`;
}

/**
 * Build a bounded, read-only context snapshot from the active session. Keeps the
 * system seed (if any) plus the most recent messages, clamping each message's
 * content and dropping older messages to satisfy the bound. The source array is
 * never mutated.
 */
export function buildSideContext(
  messages: ReadonlyArray<SessionMessage>,
  opts: SideContextOptions = {},
): SideContext {
  const maxMessages = opts.maxMessages ?? DEFAULT_SIDE_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_SIDE_MAX_CHARS;

  const system = messages.length > 0 && messages[0].role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : [...messages];

  const truncated = rest.length > maxMessages;
  const recent = truncated ? rest.slice(rest.length - maxMessages) : rest;

  const snapshot: SessionMessage[] = [];
  if (system) {
    snapshot.push({ ...system, content: clampContent(system.content, maxChars) });
  }
  for (const m of recent) {
    // Carry only the conversational fields a provider needs; tool-call bookkeeping
    // from the main turn is dropped so a side turn cannot resume a tool plan.
    snapshot.push({ role: m.role, content: clampContent(m.content, maxChars) });
  }

  return {
    schema: SIDE_QUESTION_SCHEMA,
    v: SIDE_QUESTION_VERSION,
    messages: snapshot,
    sourceMessageCount: messages.length,
    included: recent.length,
    truncated,
    systemPresent: system !== null,
  };
}

// The boundary instruction prepended to a side turn. It makes the contract
// explicit to the model: answer directly, request no tools, and treat the main
// task as untouched.
export function sideBoundaryNote(): string {
  return (
    "This is a side question asked alongside an in-progress main task. Answer it " +
    "directly and concisely from the context given. Do not request or run any tool, " +
    "do not change files, and do not assume the main task's plan, goal, or state. " +
    "The main conversation is not affected by this exchange."
  );
}

/**
 * Compose the provider messages for a side turn: the bounded snapshot, the
 * boundary note, and the user's question. The snapshot is copied, never the
 * caller's transcript.
 */
export function buildSideMessages(context: SideContext, question: string): SessionMessage[] {
  return [
    ...context.messages.map((m) => ({ ...m })),
    { role: "system", content: sideBoundaryNote() },
    { role: "user", content: question },
  ];
}

// A human-readable summary of the context boundary, shown in the UI so the user
// can see exactly what the side turn can and cannot touch.
export function formatSideContextSummary(context: SideContext): string {
  const scope = context.truncated
    ? `last ${context.included} of ${context.sourceMessageCount} messages`
    : `${context.included} message${context.included === 1 ? "" : "s"}`;
  return (
    `Context (read-only): ${scope}. ` +
    "Tools and workspace changes are disabled; the main task is unaffected."
  );
}

export type SideQuestionReason = "completed" | "cancelled" | "provider_error";

export interface SideQuestionResult {
  ok: boolean;
  text: string;
  reason: SideQuestionReason;
}

export interface RunSideQuestionOptions {
  config: Config;
  context: SideContext;
  question: string;
  // Cooperative cancellation: when aborted, the runner stops contributing
  // further text and returns a cancelled result. The underlying provider call
  // has no abort capability (mirroring the main shell), so only the side turn's
  // output stops.
  signal?: AbortSignal;
  // Streaming text deltas, for live rendering.
  onDelta?: (delta: string) => void;
  // A transient provider failure is being retried (metadata only).
  onRetry?: (info: { attempt: number; maxAttempts: number; reasonClass: string }) => void;
}

/**
 * Run a side question against a bounded snapshot, streaming the answer. Issues
 * the provider call with no tool schemas and ignores any tool_call event, so a
 * side turn can never execute a tool or mutate the workspace. Touches no
 * session, goal, approval, or workspace state.
 */
export async function runSideQuestion(opts: RunSideQuestionOptions): Promise<SideQuestionResult> {
  const messages = buildSideMessages(opts.context, opts.question);
  let text = "";
  try {
    for await (const event of streamChat(opts.config, messages)) {
      if (opts.signal?.aborted) {
        return { ok: false, text, reason: "cancelled" };
      }
      if (event.type === "text") {
        text += event.delta;
        opts.onDelta?.(event.delta);
      } else if (event.type === "retry") {
        opts.onRetry?.({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          reasonClass: event.reasonClass,
        });
      }
      // tool_call and usage events are intentionally ignored: a side turn has no
      // tools and reports no token accounting into the main run.
    }
  } catch {
    if (opts.signal?.aborted) {
      return { ok: false, text, reason: "cancelled" };
    }
    return { ok: false, text, reason: "provider_error" };
  }
  if (opts.signal?.aborted) {
    return { ok: false, text, reason: "cancelled" };
  }
  return { ok: true, text, reason: "completed" };
}
