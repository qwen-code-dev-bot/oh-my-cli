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
}

export async function runAgent(
  userPrompt: string,
  existingMessages: SessionMessage[],
  opts: AgentOptions,
): Promise<string> {
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
          process.stdout.write(event.delta);
        } else if (event.type === "tool_call") {
          assistantToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `\nProvider error: ${msg}`;
      process.stderr.write(errMsg + "\n");
      return assistantText || errMsg;
    }

    if (assistantToolCalls.length === 0) {
      // Final answer
      finalText = assistantText;
      const assistantMsg: SessionMessage = { role: "assistant", content: assistantText };
      messages.push(assistantMsg);
      opts.onMessage(assistantMsg);
      process.stdout.write("\n");
      break;
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
      const tool = toolMap.get(tc.name);
      let result: ToolResult;

      if (!tool) {
        result = { content: `Error: unknown tool "${tc.name}"`, isError: true };
      } else {
        // Check approval
        if (needsApproval(opts.approvalMode, tool.category)) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.arguments);
          } catch { /* ignore */ }
          const approved = await promptApproval(tc.name, parsed);
          if (!approved) {
            result = { content: "Tool execution denied by user", isError: true };
            const toolMsg: SessionMessage = {
              role: "tool",
              content: result.content,
              tool_call_id: tc.id,
            };
            messages.push(toolMsg);
            opts.onMessage(toolMsg);
            continue;
          }
        }

        try {
          const parsed = JSON.parse(tc.arguments);
          result = await tool.execute(parsed, opts.workspace);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { content: `Tool error: ${msg}`, isError: true };
        }
      }

      const toolMsg: SessionMessage = {
        role: "tool",
        content: result.content,
        tool_call_id: tc.id,
      };
      messages.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  return finalText;
}
