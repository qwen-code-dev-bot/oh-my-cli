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

export type StreamEvent = StreamedText | StreamedToolCall;

export interface ProviderOptions {
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

export async function* streamChat(
  config: Config,
  messages: SessionMessage[],
  options?: ProviderOptions,
): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  const params: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(toOpenAIMessage),
    stream: true,
  };
  if (options?.tools?.length) {
    params.tools = options.tools;
  }

  const stream = await client.chat.completions.create(
    params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
  );

  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
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
}

function toOpenAIMessage(msg: SessionMessage): OpenAI.ChatCompletionMessageParam {
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
  return {
    role: msg.role as "system" | "user" | "assistant",
    content: msg.content ?? "",
  };
}
