import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import type { Config } from "../../src/config.js";
import type { SessionMessage } from "../../src/session.js";
import {
  SIDE_QUESTION_SCHEMA,
  SIDE_QUESTION_VERSION,
  DEFAULT_SIDE_MAX_MESSAGES,
  buildSideContext,
  buildSideMessages,
  sideBoundaryNote,
  formatSideContextSummary,
  runSideQuestion,
} from "../../src/side-question.js";

describe("buildSideContext", () => {
  it("returns an empty snapshot for an empty session", () => {
    const ctx = buildSideContext([]);
    expect(ctx.schema).toBe(SIDE_QUESTION_SCHEMA);
    expect(ctx.v).toBe(SIDE_QUESTION_VERSION);
    expect(ctx.messages).toEqual([]);
    expect(ctx.included).toBe(0);
    expect(ctx.sourceMessageCount).toBe(0);
    expect(ctx.truncated).toBe(false);
    expect(ctx.systemPresent).toBe(false);
  });

  it("carries the system seed and recent messages", () => {
    const messages: SessionMessage[] = [
      { role: "system", content: "you are a coding agent" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const ctx = buildSideContext(messages);
    expect(ctx.systemPresent).toBe(true);
    expect(ctx.included).toBe(2);
    expect(ctx.truncated).toBe(false);
    expect(ctx.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("drops older messages to satisfy the bound and flags truncation", () => {
    const messages: SessionMessage[] = [
      { role: "system", content: "seed" },
      ...Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ];
    const ctx = buildSideContext(messages, { maxMessages: 5 });
    expect(ctx.truncated).toBe(true);
    expect(ctx.included).toBe(5);
    expect(ctx.sourceMessageCount).toBe(21);
    // System seed plus the last 5 user messages.
    expect(ctx.messages[0]).toEqual({ role: "system", content: "seed" });
    expect(ctx.messages.map((m) => m.content)).toEqual(["seed", "m15", "m16", "m17", "m18", "m19"]);
  });

  it("defaults the recent-message bound to DEFAULT_SIDE_MAX_MESSAGES", () => {
    const messages: SessionMessage[] = Array.from({ length: DEFAULT_SIDE_MAX_MESSAGES + 4 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const ctx = buildSideContext(messages);
    expect(ctx.included).toBe(DEFAULT_SIDE_MAX_MESSAGES);
    expect(ctx.truncated).toBe(true);
  });

  it("clamps oversized message content", () => {
    const messages: SessionMessage[] = [{ role: "user", content: "x".repeat(6_000) }];
    const ctx = buildSideContext(messages, { maxChars: 100 });
    expect(ctx.messages[0].content?.length).toBe(101); // 100 chars + ellipsis
    expect(ctx.messages[0].content?.endsWith("…")).toBe(true);
  });

  it("drops tool-call bookkeeping so a side turn cannot resume a tool plan", () => {
    const messages: SessionMessage[] = [
      {
        role: "assistant",
        content: "running",
        tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const ctx = buildSideContext(messages);
    for (const m of ctx.messages) {
      expect(m.tool_calls).toBeUndefined();
      expect(m.tool_call_id).toBeUndefined();
    }
  });

  it("never mutates the source transcript", () => {
    const messages: SessionMessage[] = [
      { role: "system", content: "seed" },
      { role: "user", content: "x".repeat(6_000) },
    ];
    const before = JSON.stringify(messages);
    buildSideContext(messages, { maxChars: 10 });
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe("buildSideMessages", () => {
  it("appends the boundary note and the question after the snapshot", () => {
    const ctx = buildSideContext([{ role: "user", content: "earlier" }]);
    const out = buildSideMessages(ctx, "what does this do?");
    expect(out[out.length - 1]).toEqual({ role: "user", content: "what does this do?" });
    expect(out[out.length - 2]).toEqual({ role: "system", content: sideBoundaryNote() });
    expect(out[0]).toEqual({ role: "user", content: "earlier" });
  });

  it("copies snapshot messages rather than aliasing them", () => {
    const ctx = buildSideContext([{ role: "user", content: "earlier" }]);
    const out = buildSideMessages(ctx, "q");
    expect(out[0]).not.toBe(ctx.messages[0]);
    expect(out[0]).toEqual(ctx.messages[0]);
  });
});

describe("sideBoundaryNote / formatSideContextSummary", () => {
  it("states the no-tools, no-mutation, main-task-untouched contract", () => {
    const note = sideBoundaryNote();
    expect(note).toMatch(/side question/i);
    expect(note).toMatch(/Do not request or run any tool/i);
    expect(note).toMatch(/do not change files/i);
    expect(note).toMatch(/not affected/i);
  });

  it("summarizes a non-truncated context", () => {
    const ctx = buildSideContext([{ role: "user", content: "a" }]);
    const s = formatSideContextSummary(ctx);
    expect(s).toContain("1 message");
    expect(s).toContain("read-only");
    expect(s).toContain("Tools and workspace changes are disabled");
    expect(s).toContain("the main task is unaffected");
  });

  it("summarizes a truncated context with the source total", () => {
    const ctx = buildSideContext(
      Array.from({ length: 30 }, () => ({ role: "user" as const, content: "x" })),
      { maxMessages: 5 },
    );
    expect(formatSideContextSummary(ctx)).toContain("last 5 of 30 messages");
  });
});

describe("runSideQuestion (streaming, isolated)", () => {
  let server: FakeServer;
  let config: Config;

  beforeAll(async () => {
    server = await createFakeServer();
    config = { apiKey: "fake-key", baseUrl: server.url, model: "fake-model" };
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("streams the answer and reports completion", async () => {
    server.setResponse({ type: "text", content: "Hello side" });
    let streamed = "";
    const res = await runSideQuestion({
      config,
      context: buildSideContext([]),
      question: "hi?",
      onDelta: (d) => {
        streamed += d;
      },
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("completed");
    expect(res.text).toBe("Hello side");
    expect(streamed).toBe("Hello side");
  });

  it("sends no tool schemas and includes the boundary note and question", async () => {
    server.setResponse({ type: "text", content: "ok" });
    await runSideQuestion({
      config,
      context: buildSideContext([{ role: "user", content: "earlier" }]),
      question: "the question",
    });
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0].body as { tools?: unknown; messages: Array<{ role: string; content: string }> };
    expect(body.tools).toBeUndefined();
    const last = body.messages[body.messages.length - 1];
    expect(last).toEqual({ role: "user", content: "the question" });
    const boundary = body.messages[body.messages.length - 2];
    expect(boundary.role).toBe("system");
    expect(boundary.content).toBe(sideBoundaryNote());
  });

  it("ignores any tool_call event so a side turn can never run a tool", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [{ id: "c1", name: "write", arguments: JSON.stringify({ path: "x", content: "y" }) }],
    });
    const res = await runSideQuestion({
      config,
      context: buildSideContext([]),
      question: "do something",
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("completed");
    expect(res.text).toBe(""); // tool call contributed no text
  });

  it("reports a provider failure without throwing", async () => {
    // A non-retryable status (401) fails immediately, so the result is
    // deterministic without exercising the bounded retry/backoff path.
    server.setResponse({ type: "text", content: "x", failWith: { status: 401 } });
    const res = await runSideQuestion({
      config,
      context: buildSideContext([]),
      question: "hi?",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("provider_error");
  });

  it("honors cooperative cancellation mid-stream", async () => {
    server.setResponse({ type: "text", content: "Hello world" });
    const controller = new AbortController();
    const res = await runSideQuestion({
      config,
      context: buildSideContext([]),
      question: "hi?",
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("cancelled");
    expect(res.text.length).toBeLessThan("Hello world".length);
  });

  it("returns cancelled immediately when the signal is already aborted", async () => {
    server.setResponse({ type: "text", content: "Hello" });
    const controller = new AbortController();
    controller.abort();
    const res = await runSideQuestion({
      config,
      context: buildSideContext([]),
      question: "hi?",
      signal: controller.signal,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("cancelled");
    expect(res.text).toBe("");
  });
});
