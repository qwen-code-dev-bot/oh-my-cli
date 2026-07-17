import OpenAI from "openai";
import type { Config } from "./config.js";
import type { SessionMessage } from "./session.js";

export interface StreamedText {
  type: "text";
  delta: string;
}

export interface StreamedToolCall {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

// Token usage for a single completion, emitted last when the provider reports it
// (we request `stream_options.include_usage`). Absent when the provider does not
// surface usage, in which case callers treat totals as unavailable.
export interface StreamedUsage {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// A transient provider failure is about to be retried. Metadata only — which
// attempt, the transient reason class, and the scheduled wait — so a consumer
// can observe resilience without ever seeing error text, request bodies, or
// secrets.
export type TransientReasonClass = "rate_limited" | "server_error" | "network_error";

export interface StreamedRetry {
  type: "retry";
  // The attempt about to run (2-based; attempt 1 is the initial try).
  attempt: number;
  maxAttempts: number;
  reasonClass: TransientReasonClass;
  delayMs: number;
}

export type StreamEvent = StreamedText | StreamedToolCall | StreamedUsage | StreamedRetry;

// Bounded retry policy. Fixed so an unattended run can never hang: at most
// RETRY_MAX_ATTEMPTS total tries, each wait capped at RETRY_MAX_DELAY_MS, so the
// worst-case cumulative wait is bounded by their product.
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 200;
export const RETRY_MAX_DELAY_MS = 2000;

// Network error codes treated as transient, mirroring the preflight vocabulary.
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

export interface TransientClassification {
  reasonClass: TransientReasonClass;
  retryAfterMs: number | null;
}

// Classify a provider error as transient (retryable) or not. Returns null for
// non-retryable failures (auth, invalid request, unsupported model, …), which
// must surface immediately.
export function classifyTransient(err: unknown): TransientClassification | null {
  const e = err as {
    status?: number;
    code?: string;
    cause?: { code?: string };
    // May be a plain record (tests) or a fetch Headers object (SDK errors).
    headers?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === 429) {
    return { reasonClass: "rate_limited", retryAfterMs: parseRetryAfterMs(e.headers) };
  }
  if (status !== undefined && (status === 500 || status === 502 || status === 503 || status === 504)) {
    return { reasonClass: "server_error", retryAfterMs: parseRetryAfterMs(e.headers) };
  }
  const code = e.code ?? e.cause?.code;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return { reasonClass: "network_error", retryAfterMs: null };
  }
  return null;
}

// Parse a Retry-After header (delta-seconds) into milliseconds, clamped to the
// per-attempt maximum. HTTP-date forms are ignored (treated as absent). Accepts
// either a plain record (tests) or a fetch Headers object (SDK errors).
function parseRetryAfterMs(headers: unknown): number | null {
  if (!headers || typeof headers !== "object") return null;
  let raw: string | null | undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    raw = (get as (name: string) => string | null).call(headers, "retry-after");
  } else {
    const h = headers as Record<string, string | undefined>;
    raw = h["retry-after"] ?? h["Retry-After"];
  }
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), RETRY_MAX_DELAY_MS);
}

// Exponential backoff with bounded (equal) jitter, honoring a clamped
// Retry-After when present. `rng` is injectable so tests are deterministic.
export function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  rng: () => number = Math.random,
): number {
  if (retryAfterMs != null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS);
  }
  const exp = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, RETRY_MAX_DELAY_MS);
  const jittered = capped / 2 + (capped / 2) * rng();
  return Math.max(1, Math.round(jittered));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProviderOptions {
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

// Stream a provider call, retrying transient failures (429, 5xx, retryable
// network errors) that occur BEFORE any output is produced, with bounded
// exponential backoff. A `retry` event is emitted before each wait so consumers
// can observe the resilience. A failure after output has started is never
// retried (it would duplicate partial content); it propagates to the caller.
export async function* streamChat(
  config: Config,
  messages: SessionMessage[],
  options?: ProviderOptions,
): AsyncGenerator<StreamEvent> {
  let attempt = 0;
  while (true) {
    attempt++;
    let producedOutput = false;
    try {
      for await (const event of streamOnce(config, messages, options)) {
        producedOutput = true;
        yield event;
      }
      return;
    } catch (err) {
      const transient = classifyTransient(err);
      if (transient && !producedOutput && attempt < RETRY_MAX_ATTEMPTS) {
        const delayMs = backoffDelayMs(attempt, transient.retryAfterMs);
        yield {
          type: "retry",
          attempt: attempt + 1,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          reasonClass: transient.reasonClass,
          delayMs,
        };
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

async function* streamOnce(
  config: Config,
  messages: SessionMessage[],
  options?: ProviderOptions,
): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    // We own retry policy here so it is explicit and observable; the SDK's own
    // (invisible) retries are disabled to avoid double-backoff.
    maxRetries: 0,
  });

  const params: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toOpenAIMessage),
    stream: true,
    // Ask for a trailing usage chunk so the run summary can report token totals
    // when the provider supports it. Providers that ignore this simply omit it.
    stream_options: { include_usage: true },
  };
  if (options?.tools?.length) {
    params.tools = options.tools;
  }

  const stream = await client.chat.completions.create(
    params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
  );

  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: OpenAI.CompletionUsage | undefined;

  for await (const chunk of stream) {
    // The usage chunk (when present) arrives last and carries an empty choices
    // array, so capture it before the per-choice handling below.
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta?.content) {
      yield { type: "text", delta: delta.content };
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
        }
        const entry = toolCalls.get(idx)!;
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }

    if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
      // Emit accumulated tool calls
      for (const [, tc] of toolCalls) {
        if (tc.id && tc.name) {
          yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.args };
        }
      }
      toolCalls.clear();
    }
  }

  if (usage) {
    yield {
      type: "usage",
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    };
  }
}

export function toOpenAIMessage(msg: SessionMessage): OpenAI.ChatCompletionMessageParam {
  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content ?? "",
      tool_call_id: msg.tool_call_id ?? "",
    };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    return {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  // A user message carrying image data URLs becomes a multimodal content-parts
  // array (text + image_url) so a vision-capable model receives the images
  // alongside the prompt. Persisted historical images have no dataUrl (it is
  // stripped before the session log) and fall through to plain text — their
  // non-secret reference stays in the transcript, but their bytes are never
  // re-sent on resume.
  if (msg.role === "user" && msg.images?.some((img) => img.dataUrl)) {
    const parts: OpenAI.ChatCompletionContentPart[] = [];
    if (msg.content) {
      parts.push({ type: "text", text: msg.content });
    }
    for (const img of msg.images) {
      if (img.dataUrl) {
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
    }
    return { role: "user", content: parts };
  }
  return {
    role: msg.role as "system" | "user" | "assistant",
    content: msg.content ?? "",
  };
}
