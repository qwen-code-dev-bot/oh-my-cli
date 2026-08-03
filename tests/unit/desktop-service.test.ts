import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../../src/agent.js";
import { DesktopService } from "../../src/desktop/service.js";
import { SessionStore } from "../../src/session.js";

let root: string;
let sessions: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-desktop-workspace-"));
  sessions = fs.mkdtempSync(
    path.join(os.tmpdir(), "oh-my-cli-desktop-sessions-"),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sessions, { recursive: true, force: true });
});

function result(ok = true): AgentResult {
  return {
    text: "Hello from Qwen",
    ok,
    reason: ok ? "completed" : "provider_error",
    rounds: 1,
    retries: 0,
    stats: { toolCalls: {}, toolFailures: {} },
    tokens: null,
    estimatedCostUsd: null,
    costKnown: false,
  };
}

describe("DesktopService", () => {
  it("creates, lists, and reloads workspace-owned sessions", () => {
    const service = new DesktopService({
      workspaceRoot: root,
      store: new SessionStore(sessions),
    });
    const created = service.createSession();

    expect(created).toMatchObject({ title: "New session", messages: [] });
    expect(service.listSessions()).toEqual([
      expect.objectContaining({ id: created.id, title: "New session" }),
    ]);
    expect(service.loadSession(created.id)).toEqual(created);
    expect(() => service.loadSession("../../outside")).toThrow(
      "Unknown Desktop session",
    );
  });

  it("runs a real persisted turn and streams bounded lifecycle events", async () => {
    const run = vi.fn(async (prompt, _messages, options) => {
      options.onMessage({ role: "user", content: prompt });
      options.sink?.assistantDelta("Hello ");
      options.sink?.toolStart({ id: "tool-1", name: "read", round: 0 });
      options.sink?.toolResult({
        id: "tool-1",
        name: "read",
        result: { content: "/secret/path" },
        round: 0,
      });
      options.sink?.assistantDelta("from Qwen");
      options.onMessage({ role: "assistant", content: "Hello from Qwen" });
      return result();
    });
    const service = new DesktopService({
      workspaceRoot: root,
      store: new SessionStore(sessions),
      run,
      resolveConfig: () => ({
        apiKey: "test",
        baseUrl: "https://example.test/v1",
        model: "qwen3.8-max",
      }),
    });
    const session = service.createSession();
    const events: unknown[] = [];

    await expect(
      service.sendMessage(
        { sessionId: session.id, prompt: "Build a useful desktop" },
        (event) => events.push(event),
      ),
    ).resolves.toEqual({ ok: true });

    expect(events).toContainEqual({
      type: "assistant-delta",
      sessionId: session.id,
      delta: "Hello ",
    });
    expect(events).toContainEqual({
      type: "tool-result",
      sessionId: session.id,
      name: "read",
      ok: true,
    });
    expect(JSON.stringify(events)).not.toContain("/secret/path");
    expect(service.loadSession(session.id).messages).toEqual([
      { role: "user", content: "Build a useful desktop" },
      { role: "assistant", content: "Hello from Qwen" },
    ]);
    expect(service.listSessions()[0].title).toBe("Build a useful desktop");
  });

  it("lists, reads, and atomically writes bounded UTF-8 workspace files", () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "app.ts"),
      "export const value = 1;\n",
    );
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const service = new DesktopService({
      workspaceRoot: root,
      store: new SessionStore(sessions),
    });

    expect(service.listWorkspaceFiles()).toContainEqual({ path: "src/app.ts" });
    expect(service.readWorkspaceFile("src/app.ts")).toMatchObject({
      path: "src/app.ts",
      content: "export const value = 1;\n",
    });
    expect(
      service.writeWorkspaceFile({
        path: "src/app.ts",
        content: "export const value = 2;\n",
      }),
    ).toMatchObject({ content: "export const value = 2;\n" });
    expect(
      fs.readFileSync(path.join(root, "src", "app.ts"), "utf-8"),
    ).toContain("value = 2");
    expect(() => service.readWorkspaceFile("binary.bin")).toThrow(
      "Binary files",
    );
    expect(() => service.readWorkspaceFile("../outside.txt")).toThrow(
      /escape/i,
    );
  });

  it("rejects a symlink escape from the editor", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "oh-my-cli-desktop-outside-"),
    );
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "escape.txt"),
    );
    const service = new DesktopService({
      workspaceRoot: root,
      store: new SessionStore(sessions),
    });
    try {
      expect(() => service.readWorkspaceFile("escape.txt")).toThrow(/escape/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
