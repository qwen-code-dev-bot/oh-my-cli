import type { Config } from "./config.js";
import type { SessionMessage } from "./session.js";
import type { ToolDef, ToolResult } from "./tools.js";
import { createTools, toolSchemasForOpenAI } from "./tools.js";
import { streamChat } from "./provider.js";
import type { Workspace } from "./workspace.js";
import type { ApprovalMode } from "./approval.js";
import { needsApproval, promptApproval } from "./approval.js";

const MAX_ROUNDS = 30;

export interface AgentOptions {
  config: Config;
  workspace: Workspace;
  approvalMode: ApprovalMode;
  sessionId: string;
  onMessage: (msg: SessionMessage) => void;
  sink?: AgentSink;
}

// Output sink for the agent loop. The default console sink reproduces the
// existing terminal behaviour; the headless sink (see headless-protocol.ts)
// renders the same lifecycle as a versioned JSON event stream.
export interface AgentSink {
  assistantDelta(delta: string): void;
  assistantTurn(text: string, round: number, opts: { final: boolean }): void;
  toolStart(info: { id: string; name: string; round: number }): void;
  toolResult(info: { id: string; name: string; result: ToolResult; round: number }): void;
  providerError(message: string): void;
}

export function createConsoleSink(): AgentSink {
  return {
    assistantDelta: (delta) => {
      process.stdout.write(delta);
    },
    assistantTurn: (_text, _round, opts) => {
      if (opts.final) process.stdout.write("\n");
    },
    toolStart: () => {},
    toolResult: () => {},
    providerError: (message) => {
      process.stderr.write(`\nProvider error: ${message}\n`);
    },
  };
}

export interface AgentResult {
  text: string;
  ok: boolean;
  reason: "completed" | "provider_error" | "max_rounds";
  rounds: number;
}

export async function runAgent(
  userPrompt: string,
  existingMessages: SessionMessage[],
  opts: AgentOptions,
): Promise<AgentResult> {
  const sink = opts.sink ?? createConsoleSink();
  const tools = createTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const schemas = toolSchemasForOpenAI(tools);

  const messages: SessionMessage[] = [...existingMessages];

  if (messages.length === 0) {
    const system: SessionMessage = {
      role: "system",
      content: "You are a helpful coding assistant with file and shell tools. Use tools when needed.",
    };
    messages.push(system);
    opts.onMessage(system);
  }

  const userMsg: SessionMessage = { role: "user", content: userPrompt };
  messages.push(userMsg);
  opts.onMessage(userMsg);

  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let assistantText = "";
    const assistantToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      for await (const event of streamChat(opts.config, messages, { tools: schemas })) {
        if (event.type === "text") {
          assistantText += event.delta;
          sink.assistantDelta(event.delta);
        } else if (event.type === "tool_call") {
          assistantToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sink.providerError(msg);
      return { text: assistantText, ok: false, reason: "provider_error", rounds: round };
    }

    const final = assistantToolCalls.length === 0;
    sink.assistantTurn(assistantText, round, { final });

    if (final) {
      // Final answer
      finalText = assistantText;
      const assistantMsg: SessionMessage = { role: "assistant", content: assistantText };
      messages.push(assistantMsg);
      opts.onMessage(assistantMsg);
      return { text: finalText, ok: true, reason: "completed", rounds: round + 1 };
    }

    // Record assistant message with tool calls
    const assistantMsg: SessionMessage = {
      role: "assistant",
      content: assistantText || null,
      tool_calls: assistantToolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);
    opts.onMessage(assistantMsg);

    // Execute each tool call
    for (const tc of assistantToolCalls) {
      sink.toolStart({ id: tc.id, name: tc.name, round });
      const result = await executeToolCall(tc, toolMap, opts.approvalMode, opts.workspace);
      sink.toolResult({ id: tc.id, name: tc.name, result, round });

      const toolMsg: SessionMessage = {
        role: "tool",
        content: result.content,
        tool_call_id: tc.id,
      };
      messages.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  return { text: finalText, ok: false, reason: "max_rounds", rounds: MAX_ROUNDS };
}

// Resolve a single tool call to its result, applying approval gating and
// uniform error handling. Approval is sought only when required; a denial or an
// unknown tool yields an error result rather than throwing.
async function executeToolCall(
  tc: { id: string; name: string; arguments: string },
  toolMap: Map<string, ToolDef>,
  approvalMode: ApprovalMode,
  workspace: Workspace,
): Promise<ToolResult> {
  const tool = toolMap.get(tc.name);
  if (!tool) {
    return { content: `Error: unknown tool "${tc.name}"`, isError: true };
  }

  if (needsApproval(approvalMode, tool.category)) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(tc.arguments);
    } catch { /* ignore */ }
    const approved = await promptApproval(tc.name, parsed);
    if (!approved) {
      return { content: "Tool execution denied by user", isError: true };
    }
  }

  try {
    const parsed = JSON.parse(tc.arguments);
    return await tool.execute(parsed, workspace);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Tool error: ${msg}`, isError: true };
  }
}
