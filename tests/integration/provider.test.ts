import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { streamChat } from "../../src/provider.js";
import type { Config } from "../../src/config.js";

describe("Provider: streamed text", () => {
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

  it("streams text deltas from the provider", async () => {
    server.setResponse({ type: "text", content: "The answer is 42" });

    const events: Array<{ type: string; delta?: string }> = [];
    for await (const event of streamChat(config, [{ role: "user", content: "What is the answer?" }])) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text");
    const fullText = textEvents.map((e) => e.delta).join("");
    expect(fullText).toBe("The answer is 42");
  });

  it("sends correct messages to the provider", async () => {
    server.setResponse({ type: "text", content: "ok" });

    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "user" as const, content: "Hello" },
    ];

    for await (const _event of streamChat(config, messages)) {
      // consume
    }

    expect(server.requests.length).toBeGreaterThan(0);
    const lastReq = server.requests[server.requests.length - 1].body as Record<string, unknown>;
    expect(lastReq.model).toBe("fake-model");
    expect(lastReq.stream).toBe(true);
    const msgs = lastReq.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });

  it("handles empty content response", async () => {
    server.setResponse({ type: "text", content: "" });

    const events: Array<{ type: string }> = [];
    for await (const event of streamChat(config, [{ role: "user", content: "test" }])) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBe(0);
  });

  it("requests usage and yields token totals when the provider reports them", async () => {
    server.setResponse({ type: "text", content: "hi" });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamChat(config, [{ role: "user", content: "x" }])) {
      events.push(event as Record<string, unknown>);
    }

    const lastReq = server.requests[server.requests.length - 1].body as Record<string, unknown>;
    expect(lastReq.stream_options).toEqual({ include_usage: true });

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect(usage).toMatchObject({ promptTokens: 5, completionTokens: 5, totalTokens: 10 });
  });
});
