import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../../src/agent.js";
import {
  DesktopService,
  type DesktopServiceOptions,
} from "../../src/desktop/service.js";
import { SessionStore } from "../../src/session.js";

let root: string;
let sessions: string;
let uiStatePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-desktop-workspace-"));
  sessions = fs.mkdtempSync(
    path.join(os.tmpdir(), "oh-my-cli-desktop-sessions-"),
  );
  uiStatePath = path.join(sessions, "desktop-ui.json");
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

function makeService(overrides: Partial<DesktopServiceOptions> = {}): DesktopService {
  return new DesktopService({
    workspaceRoot: root,
    store: new SessionStore(sessions),
    uiStatePath,
    resolveConfig: () => ({
      apiKey: "test",
      baseUrl: "https://example.test/v1",
      model: "qwen3.8-max",
    }),
    ...overrides,
  });
}

function summaryOf(service: DesktopService, id: string) {
  const summary = service.listSessions().find((item) => item.id === id);
  if (!summary) throw new Error(`missing summary for ${id}`);
  return summary;
}

describe("DesktopService", () => {
  it("creates, lists, and reloads workspace-owned sessions", () => {
    const service = makeService();
    const created = service.createSession();

    expect(created).toMatchObject({ title: "New session", messages: [] });
    expect(service.listSessions()).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "New session",
        draft: true,
        streaming: false,
        failed: false,
        unread: false,
        archived: false,
      }),
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
    const service = makeService({
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
    const summary = summaryOf(service, session.id);
    expect(summary.title).toBe("Build a useful desktop");
    expect(summary.draft).toBe(false);
    expect(summary.failed).toBe(false);
  });

  it("keeps the draft state and skips auto-titling when the first turn fails", async () => {
    const run = vi.fn(async (prompt, _messages, options) => {
      options.onMessage({ role: "user", content: prompt });
      return result(false);
    });
    const service = makeService({ run });
    const session = service.createSession();

    await service.sendMessage(
      { sessionId: session.id, prompt: "This turn will fail" },
      () => {},
    );

    const summary = summaryOf(service, session.id);
    expect(summary.title).toBe("New session");
    expect(summary.draft).toBe(true);
    expect(summary.failed).toBe(true);
  });

  it("clears the failed state once a later turn completes", async () => {
    let ok = false;
    const run = vi.fn(async (prompt, _messages, options) => {
      options.onMessage({ role: "user", content: prompt });
      options.onMessage({ role: "assistant", content: "answered" });
      return result(ok);
    });
    const service = makeService({ run });
    const session = service.createSession();

    await service.sendMessage(
      { sessionId: session.id, prompt: "first try" },
      () => {},
    );
    expect(summaryOf(service, session.id).failed).toBe(true);

    ok = true;
    await service.sendMessage(
      { sessionId: session.id, prompt: "second try" },
      () => {},
    );
    const summary = summaryOf(service, session.id);
    expect(summary.failed).toBe(false);
    expect(summary.draft).toBe(false);
  });

  it("renames sessions and never overwrites the chosen name on the first turn", async () => {
    const run = vi.fn(async (prompt, _messages, options) => {
      options.onMessage({ role: "user", content: prompt });
      options.onMessage({ role: "assistant", content: "done" });
      return result();
    });
    const service = makeService({ run });
    const session = service.createSession();

    const renamed = service.renameSession({
      sessionId: session.id,
      title: "Refactor the rail",
    });
    expect(renamed.title).toBe("Refactor the rail");
    expect(service.loadSession(session.id).title).toBe("Refactor the rail");

    await service.sendMessage(
      { sessionId: session.id, prompt: "Some prompt text" },
      () => {},
    );
    expect(summaryOf(service, session.id).title).toBe("Refactor the rail");

    expect(() =>
      service.renameSession({ sessionId: session.id, title: "   " }),
    ).toThrow("Session title cannot be empty");
    expect(() =>
      service.renameSession({ sessionId: session.id, title: "bad\u001bname" }),
    ).toThrow(/control characters/);
    expect(() =>
      service.renameSession({
        sessionId: "../outside",
        title: "nope",
      }),
    ).toThrow("Unknown Desktop session");
  });

  it("archives and restores sessions without hiding them from listing", () => {
    const service = makeService();
    const session = service.createSession();

    const archived = service.setSessionArchived({
      sessionId: session.id,
      archived: true,
    });
    expect(archived.archived).toBe(true);
    expect(summaryOf(service, session.id).archived).toBe(true);

    const restored = service.setSessionArchived({
      sessionId: session.id,
      archived: false,
    });
    expect(restored.archived).toBe(false);
    expect(summaryOf(service, session.id).archived).toBe(false);
  });

  it("deletes sessions only with ownership and no running turn", async () => {
    const hang = new Promise<never>(() => {});
    const run = vi.fn(() => hang);
    const service = makeService({ run });
    const victim = service.createSession();
    const busy = service.createSession();

    const pending = service
      .sendMessage({ sessionId: busy.id, prompt: "keep running" }, () => {})
      .catch(() => {});
    await vi.waitFor(() =>
      expect(summaryOf(service, busy.id).streaming).toBe(true),
    );
    expect(() => service.deleteSession(busy.id)).toThrow(
      "Session has a running turn",
    );

    expect(service.deleteSession(victim.id)).toEqual({ ok: true });
    expect(service.listSessions().map((item) => item.id)).toEqual([busy.id]);
    expect(new SessionStore(sessions).listIds()).toEqual([busy.id]);
    expect(() => service.loadSession(victim.id)).toThrow(
      "Unknown Desktop session",
    );
    expect(() => service.deleteSession("../outside")).toThrow(
      "Unknown Desktop session",
    );
    void pending;
  });

  it("tracks unread truth against the persisted read watermark", () => {
    const service = makeService();
    const session = service.createSession();
    // A meta-only session has no conversation messages yet.
    expect(summaryOf(service, session.id).unread).toBe(false);

    service.saveUiState({
      sessions: { [session.id]: { lastSeenMessageCount: 0 } },
    });
    fs.appendFileSync(
      new SessionStore(sessions).filePath(session.id),
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
    );
    expect(summaryOf(service, session.id).unread).toBe(true);

    const saved = service.saveUiState({
      sessions: { [session.id]: { lastSeenMessageCount: 1 } },
    });
    expect(saved.sessions[session.id]?.lastSeenMessageCount).toBe(1);
    expect(summaryOf(service, session.id).unread).toBe(false);
  });

  it("persists drafts, positions, and the active session across reloads", () => {
    const service = makeService();
    const session = service.createSession();

    service.saveUiState({
      activeSessionId: session.id,
      sessions: { [session.id]: { draft: "unfinished thought", scrollTop: 120 } },
    });

    // A brand-new service instance over the same store and UI file models an
    // app reload: everything the renderer needs must come back from disk.
    const reloaded = makeService();
    const ui = reloaded.getUiState();
    expect(ui.activeSessionId).toBe(session.id);
    expect(ui.sessions[session.id]).toMatchObject({
      draft: "unfinished thought",
      scrollTop: 120,
    });
  });

  it("sanitizes UI-state writes and refuses forged lifecycle fields", () => {
    const service = makeService();
    const session = service.createSession();

    const saved = service.saveUiState({
      activeSessionId: session.id,
      sessions: {
        [session.id]: {
          draft: "x".repeat(20_000),
          scrollTop: -5,
          lastSeenMessageCount: 1.5,
          archived: true,
          lastTurnFailed: true,
        } as never,
        "not-a-session": { draft: "other workspace?" },
      },
    });

    const entry = saved.sessions[session.id] ?? {};
    expect(entry.draft).toHaveLength(10_000);
    expect(entry.scrollTop).toBeUndefined();
    expect(entry.lastSeenMessageCount).toBeUndefined();
    expect(entry.archived).toBeUndefined();
    expect(entry.lastTurnFailed).toBeUndefined();
    expect(saved.sessions["not-a-session"]).toBeUndefined();

    const staleActive = service.saveUiState({ activeSessionId: "nope" });
    expect(staleActive.activeSessionId).toBeNull();
  });

  it("merges UI-state keys instead of clobbering them", () => {
    const service = makeService();
    const session = service.createSession();

    service.saveUiState({
      sessions: { [session.id]: { draft: "kept", scrollTop: 42 } },
    });
    const merged = service.saveUiState({
      sessions: { [session.id]: { lastSeenMessageCount: 3 } },
    });
    expect(merged.sessions[session.id]).toMatchObject({
      draft: "kept",
      scrollTop: 42,
      lastSeenMessageCount: 3,
    });
  });

  it("lists, reads, and atomically writes bounded UTF-8 workspace files", () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "app.ts"),
      "export const value = 1;\n",
    );
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const service = makeService();

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
      fs.readFileSync(path.join(root, "src/app.ts"), "utf-8"),
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
    const service = makeService();
    try {
      expect(() => service.readWorkspaceFile("escape.txt")).toThrow(/escape/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
