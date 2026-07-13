import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { streamChat } from "../../src/provider.js";
import type { Config } from "../../src/config.js";

describe("Provider: streamed tool calls", () => {
  let server: FakeServer;
  let config: Config;

  beforeAll(async () => {
    server = await createFakeServer();
    config = {
      apiKey: "test-key",
      baseUrl: server.url,
      model: "fake-model",
    };
  });

  afterAll(async () => {
    await server.close();
  });

  it("streams tool call with aggregated arguments", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [{
        id: "call_1",
        name: "read",
        arguments: JSON.stringify({ path: "hello.txt" }),
      }],
    });

    const events: Array<{ type: string; id?: string; name?: string; arguments?: string }> = [];
    for await (const event of streamChat(config, [{ role: "user", content: "read file" }])) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].id).toBe("call_1");
    expect(toolCalls[0].name).toBe("read");
    const parsed = JSON.parse(toolCalls[0].arguments!);
    expect(parsed.path).toBe("hello.txt");
  });

  it("streams multiple tool calls", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [
        { id: "call_1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
        { id: "call_2", name: "write", arguments: JSON.stringify({ path: "b.txt", content: "hello" }) },
      ],
    });

    const events: Array<{ type: string; name?: string }> = [];
    for await (const event of streamChat(config, [{ role: "user", content: "do stuff" }])) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].name).toBe("read");
    expect(toolCalls[1].name).toBe("write");
  });

  it("sends tool schemas when tools are provided", async () => {
    server.setResponse({ type: "text", content: "no tools needed" });

    const tools = [{
      type: "function" as const,
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }];

    for await (const _event of streamChat(config, [{ role: "user", content: "test" }], { tools })) {
      // consume
    }

    const lastReq = server.requests[server.requests.length - 1].body as Record<string, unknown>;
    const sentTools = lastReq.tools as Array<unknown>;
    expect(sentTools).toBeDefined();
    expect(sentTools.length).toBe(1);
  });
});
