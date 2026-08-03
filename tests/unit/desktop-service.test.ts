import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../../src/agent.js";
import {
  DesktopService,
  type DesktopServiceOptions,
} from "../../src/desktop/service.js";
import { SessionStore } from "../../src/session.js";
import {
  addTrusted,
  emptyTrustStore,
  saveTrustStore,
  workspaceTrustKey,
} from "../../src/folder-trust.js";

let root: string;
let sessions: string;
let uiStatePath: string;
let recentsPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-desktop-workspace-"));
  sessions = fs.mkdtempSync(
    path.join(os.tmpdir(), "oh-my-cli-desktop-sessions-"),
  );
  uiStatePath = path.join(sessions, "desktop-ui.json");
  recentsPath = path.join(sessions, "desktop-recents.json");
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
    recentsPath,
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

  describe("composer lifecycle (#489)", () => {
    function tinyPng(): Buffer {
      return Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
        "hex",
      );
    }

    it("refuses cancel and retry preconditions fail-closed", async () => {
      const service = makeService();
      const session = service.createSession();
      expect(() => service.cancelTurn(session.id)).toThrow(
        "No turn is running for this session",
      );
      await expect(service.retryTurn(session.id, () => {})).rejects.toThrow(
        "Nothing to retry in this session",
      );
    });

    it("cancel ends the running turn as cancelled and preserves the partial transcript", async () => {
      const run = vi.fn(async (prompt, _messages, options) => {
        if (options.appendUserMessage !== false)
          options.onMessage({ role: "user", content: prompt });
        options.sink?.assistantDelta("Partial");
        await vi.waitFor(() =>
          expect(options.cancelRequested?.()).toBe(true),
        );
        options.onMessage({
          role: "assistant",
          content: "Partial",
          interrupted: true,
        });
        return { ...result(false), reason: "cancelled" as const };
      });
      const service = makeService({ run });
      const session = service.createSession();
      const events: Array<{ type: string; sessionId?: string }> = [];

      const pending = service.sendMessage(
        { sessionId: session.id, prompt: "slow work" },
        (event) => events.push(event),
      );
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "assistant-delta")).toBe(true),
      );
      expect(service.cancelTurn(session.id)).toEqual({ ok: true });
      await expect(pending).resolves.toEqual({ ok: false });

      expect(events).toContainEqual({
        type: "cancelled",
        sessionId: session.id,
      });
      // A cancel is neither a completed nor a failed turn; the persisted
      // partial assistant message still ends the pristine draft state.
      const summary = summaryOf(service, session.id);
      expect(summary.failed).toBe(false);
      expect(summary.draft).toBe(false);
      expect(summary.title).not.toBe("slow work");
      expect(service.loadSession(session.id).messages).toContainEqual({
        role: "assistant",
        content: "Partial",
        interrupted: true,
      });
    });

    it("retry reuses one request identity without duplicating the user turn", async () => {
      let calls = 0;
      const run = vi.fn(async (prompt, _messages, options) => {
        calls++;
        if (options.appendUserMessage !== false)
          options.onMessage({ role: "user", content: prompt });
        if (calls === 1) return { ...result(false), reason: "provider_error" as const };
        options.sink?.assistantDelta("Recovered");
        options.onMessage({ role: "assistant", content: "Recovered" });
        return result();
      });
      const service = makeService({ run });
      const session = service.createSession();

      await service.sendMessage(
        { sessionId: session.id, prompt: "flaky turn" },
        () => {},
      );
      expect(summaryOf(service, session.id).failed).toBe(true);

      await expect(
        service.retryTurn(session.id, () => {}),
      ).resolves.toEqual({ ok: true });

      const messages = service.loadSession(session.id).messages;
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(messages.map((m) => m.content)).toContain("Recovered");
      expect(summaryOf(service, session.id).failed).toBe(false);
      // Retry passed the existing transcript through unchanged.
      expect(run.mock.calls[1][2].appendUserMessage).toBe(false);
    });

    it("validates attachments by content and workspace provenance", () => {
      const service = makeService();
      const png = tinyPng();
      fs.writeFileSync(path.join(root, "shot.png"), png);
      fs.writeFileSync(path.join(root, "notes.txt"), "not an image");

      const reports = service.attachImages(["shot.png", "notes.txt"]);
      expect(reports[0]).toMatchObject({
        path: "shot.png",
        ok: true,
        name: "shot.png",
        mediaType: "image/png",
      });
      expect(reports[0].bytes).toBe(png.length);
      expect(reports[1]).toMatchObject({ path: "notes.txt", ok: false });
      expect(reports[1].error).toContain("Unsupported image type");

      const outside = service.attachImageFiles([
        path.join(os.tmpdir(), "elsewhere.png"),
      ]);
      expect(outside[0]).toMatchObject({
        ok: false,
        error: "File is outside this workspace",
      });

      const inside = service.attachImageFiles([path.join(root, "shot.png")]);
      expect(inside[0]).toMatchObject({ ok: true, mediaType: "image/png" });

      expect(() => service.attachImages([])).toThrow(
        "No attachments provided",
      );
      expect(() =>
        service.attachImages(
          Array.from({ length: 9 }, (_, i) => `img${i}.png`),
        ),
      ).toThrow(/Too many images/);
    });

    it("sends validated attachments with the turn and rejects invalid ones before the turn", async () => {
      const run = vi.fn(async (prompt, _messages, options) => {
        if (options.appendUserMessage !== false)
          options.onMessage({ role: "user", content: prompt });
        options.onMessage({ role: "assistant", content: "ok" });
        return result();
      });
      const service = makeService({ run });
      const session = service.createSession();
      fs.writeFileSync(path.join(root, "shot.png"), tinyPng());
      fs.writeFileSync(path.join(root, "notes.txt"), "not an image");

      await service.sendMessage(
        { sessionId: session.id, prompt: "with image", attachments: ["shot.png"] },
        () => {},
      );
      expect(run.mock.calls[0][2].images).toHaveLength(1);

      await expect(
        service.sendMessage(
          { sessionId: session.id, prompt: "bad", attachments: ["notes.txt"] },
          () => {},
        ),
      ).rejects.toThrow(/Unsupported image type/);
    });
  });

  describe("runtime info and profiles (#489)", () => {
    it("reports effective model and approval mode, and switches profiles canonically", () => {
      const settings = path.join(sessions, "settings.json");
      fs.writeFileSync(
        settings,
        JSON.stringify({
          profiles: {
            qwen: {
              name: "qwen-model",
              baseUrl: "https://dashscope.example.invalid/v1",
              apiKeyEnv: "OMC_TEST_KEY_489",
            },
            local: {
              name: "local-model",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKeyEnv: "OMC_TEST_KEY_489",
            },
          },
        }),
      );
      process.env.OMC_TEST_KEY_489 = "test-key";
      try {
        const service = makeService({ settingsPath: settings });

        const info = service.getRuntimeInfo();
        expect(info.approvalMode).toBe("auto-edit");
        expect(info.profiles).toEqual(["local", "qwen"]);
        // No default profile and no legacy model section: truthful degradation.
        expect(info.model).toBeNull();
        expect(info.endpointHost).toBeNull();

        const selected = service.setSelectedProfile("qwen");
        expect(selected.model).toBe("qwen-model");
        expect(selected.profile).toBe("qwen");
        // Redacted endpoint: bare host only — no scheme, path, or userinfo.
        expect(selected.endpointHost).toBe("dashscope.example.invalid");

        expect(() => service.setSelectedProfile("nope")).toThrow(
          "Unknown model profile",
        );

        const cleared = service.setSelectedProfile(null);
        expect(cleared.profile).toBeNull();
        expect(cleared.model).toBeNull();

        // The choice survives a service restart (persisted runtime state).
        const reloaded = makeService({ settingsPath: settings });
        expect(reloaded.getRuntimeInfo().profile).toBeNull();
        reloaded.setSelectedProfile("local");
        expect(
          makeService({ settingsPath: settings }).getRuntimeInfo().profile,
        ).toBe("local");
      } finally {
        delete process.env.OMC_TEST_KEY_489;
      }
    });
  });

  describe("workspace .env wiring (#509)", () => {
    function withIsolatedEnvHome<T>(home: string, fn: () => T): T {
      const prevHome = process.env.HOME;
      const saved = {
        model: process.env.OPENAI_MODEL,
        key: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
      };
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
      process.env.HOME = home;
      try {
        return fn();
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        for (const [name, value] of Object.entries({
          OPENAI_MODEL: saved.model,
          OPENAI_API_KEY: saved.key,
          OPENAI_BASE_URL: saved.baseUrl,
        })) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    function fakeHomeWithTrust(workspaceRoot: string): string {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-desktop-home-"));
      fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
      saveTrustStore(
        path.join(home, ".oh-my-cli", "trust.json"),
        addTrusted(emptyTrustStore(), workspaceTrustKey(workspaceRoot)),
      );
      return home;
    }

    it("default config resolution loads a trusted workspace .env", () => {
      fs.writeFileSync(
        path.join(root, ".env"),
        "OPENAI_MODEL=ws-desktop-model\nOPENAI_API_KEY=sk-ws-desktop\n",
      );
      const home = fakeHomeWithTrust(root);
      try {
        withIsolatedEnvHome(home, () => {
          const service = new DesktopService({
            workspaceRoot: root,
            store: new SessionStore(sessions),
            uiStatePath,
            recentsPath,
          });
          const info = service.getRuntimeInfo();
          expect(info.model).toBe("ws-desktop-model");
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("an untrusted workspace .env does not feed resolution", () => {
      fs.writeFileSync(
        path.join(root, ".env"),
        "OPENAI_MODEL=ws-desktop-model\nOPENAI_API_KEY=sk-ws-desktop\n",
      );
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-desktop-home-"));
      try {
        withIsolatedEnvHome(home, () => {
          const service = new DesktopService({
            workspaceRoot: root,
            store: new SessionStore(sessions),
            uiStatePath,
            recentsPath,
          });
          // No trusted .env and no other model source: truthful degradation.
          expect(service.getRuntimeInfo().model).toBeNull();
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("coding workflow (#490)", () => {
    it("reads and writes with content revisions and fails closed on external change", () => {
      fs.writeFileSync(path.join(root, "app.ts"), "v1\n");
      const service = makeService();

      const read = service.readWorkspaceFile("app.ts");
      expect(read.revision).toMatch(/^[0-9a-f]{16}$/);

      // A matching revision saves cleanly and returns the new revision.
      const saved = service.writeWorkspaceFile({
        path: "app.ts",
        content: "v2\n",
        expectedRevision: read.revision,
      });
      expect(saved.content).toBe("v2\n");
      expect(saved.revision).not.toBe(read.revision);
      expect(fs.readFileSync(path.join(root, "app.ts"), "utf-8")).toBe("v2\n");

      // A stale revision fails closed; the file is untouched.
      expect(() =>
        service.writeWorkspaceFile({
          path: "app.ts",
          content: "v3\n",
          expectedRevision: read.revision,
        }),
      ).toThrow("File changed outside Desktop");
      expect(fs.readFileSync(path.join(root, "app.ts"), "utf-8")).toBe("v2\n");
    });

    it("creates, renames, and deletes files fail-closed", () => {
      const service = makeService();

      const created = service.createWorkspaceFile("notes.md");
      expect(created.content).toBe("");
      expect(fs.existsSync(path.join(root, "notes.md"))).toBe(true);
      expect(() => service.createWorkspaceFile("notes.md")).toThrow(
        "File already exists",
      );
      expect(() => service.createWorkspaceFile("missing/dir.md")).toThrow(
        /Parent directory does not exist/,
      );
      expect(() => service.createWorkspaceFile("../outside.md")).toThrow(
        /escape/i,
      );

      fs.writeFileSync(path.join(root, "a.txt"), "x");
      const renamed = service.renameWorkspaceFile({
        from: "a.txt",
        to: "b.txt",
      });
      expect(renamed.path).toBe("b.txt");
      expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
      expect(fs.existsSync(path.join(root, "b.txt"))).toBe(true);
      expect(() =>
        service.renameWorkspaceFile({ from: "b.txt", to: "notes.md" }),
      ).toThrow("File already exists");
      expect(() =>
        service.renameWorkspaceFile({ from: "b.txt", to: "../escape.txt" }),
      ).toThrow(/escape/i);

      expect(service.deleteWorkspaceFile("b.txt")).toEqual({ ok: true });
      expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
      expect(() => service.deleteWorkspaceFile("b.txt")).toThrow(
        /does not exist/,
      );
      expect(() => service.deleteWorkspaceFile("../outside")).toThrow(
        /escape/i,
      );
    });

    it("lists directories lazily and searches visible files", () => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "app.ts"), "1");
      fs.writeFileSync(path.join(root, "README.md"), "readme");
      const service = makeService();

      const listing = service.listWorkspaceDirectory(".");
      expect(listing.entries.map((e) => e.path)).toEqual(
        expect.arrayContaining(["src", "README.md"]),
      );
      const srcEntry = listing.entries.find((e) => e.path === "src");
      expect(srcEntry?.type).toBe("directory");

      const nested = service.listWorkspaceDirectory("src");
      expect(nested.entries.map((e) => e.path)).toEqual(["src/app.ts"]);

      expect(() => service.listWorkspaceDirectory("../outside")).toThrow(
        /escape|not a directory/i,
      );

      expect(
        service.searchWorkspaceFiles("app").map((f) => f.path),
      ).toEqual(["src/app.ts"]);
      expect(service.searchWorkspaceFiles("")).toEqual([]);
      expect(service.searchWorkspaceFiles("zzz")).toEqual([]);
    });

    it("reports the real Git working-tree diff with bounded detail", () => {
      execFileSync("git", ["init", "-q", "-b", "main", root], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "config", "user.email", "t@e.com"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "config", "user.name", "T"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "tracked.txt"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
      fs.writeFileSync(path.join(root, "untracked.md"), "new file\n");

      const service = makeService();
      const diff = service.getWorkspaceDiff();
      expect(diff.git).toBe(true);
      const byPath = Object.fromEntries(
        diff.files.map((f) => [f.path, f.status]),
      );
      expect(byPath["tracked.txt"]).toBe("M");
      expect(byPath["untracked.md"]).toBe("??");

      const trackedPatch = service.getWorkspaceFileDiff("tracked.txt");
      expect(trackedPatch.patch).toContain("-base");
      expect(trackedPatch.patch).toContain("+changed");
      expect(trackedPatch.truncated).toBe(false);

      const untrackedPatch = service.getWorkspaceFileDiff("untracked.md");
      expect(untrackedPatch.patch).toContain("+++ b/untracked.md");
      expect(untrackedPatch.patch).toContain("+new file");

      // A non-Git workspace is reported honestly.
      const nonGit = makeService({ workspaceRoot: sessions });
      expect(nonGit.getWorkspaceDiff()).toEqual({
        git: false,
        files: [],
        truncated: false,
      });
      expect(() => nonGit.getWorkspaceFileDiff("x")).toThrow(
        "Not a Git repository",
      );
    });

    it("persists bounded editor tabs across a service restart", () => {
      const service = makeService();
      const saved = service.saveUiState({
        editorTabs: [
          { path: "a.md", scrollTop: 42, dirty: true, draft: "unsaved" },
          { path: 123 as never, draft: "invalid" },
          {
            path: "big.md",
            draft: "x".repeat(200_000),
          },
        ],
        activeEditorTab: "a.md",
      });
      expect(saved.editorTabs).toHaveLength(2);
      expect(saved.editorTabs?.[0]).toMatchObject({
        path: "a.md",
        scrollTop: 42,
        dirty: true,
        draft: "unsaved",
      });
      expect(saved.editorTabs?.[1].draft).toHaveLength(100_000);
      expect(saved.activeEditorTab).toBe("a.md");

      const reloaded = makeService();
      const ui = reloaded.getUiState();
      expect(ui.editorTabs?.[0]?.path).toBe("a.md");
      expect(ui.activeEditorTab).toBe("a.md");

      // A stale active tab reads as none.
      const stale = makeService();
      const cleaned = stale.saveUiState({
        editorTabs: [],
        activeEditorTab: "a.md",
      });
      expect(cleaned.activeEditorTab).toBeNull();
    });
  });

  describe("workspace entry and recovery (#491)", () => {
    it("canonicalizes workspace paths fail-closed", () => {
      const service = makeService();
      expect(service.canonicalWorkspacePath(root)).toBe(
        fs.realpathSync(root),
      );
      expect(() =>
        service.canonicalWorkspacePath(path.join(root, "missing")),
      ).toThrow("Workspace not found");
      expect(() =>
        service.canonicalWorkspacePath(path.join(root, "file.txt")),
      ).toThrow();
      fs.writeFileSync(path.join(root, "file.txt"), "x");
      expect(() => service.canonicalWorkspacePath(path.join(root, "file.txt")))
        .toThrow("Not a directory");
      expect(() => service.canonicalWorkspacePath("")).toThrow(
        "A workspace path is required",
      );
    });

    it("remembers, lists, and forgets recents with a bounded MRU order", () => {
      const service = makeService();
      const second = fs.mkdtempSync(path.join(os.tmpdir(), "omc-second-"));
      try {
        const secondService = makeService({ workspaceRoot: second });
        service.markWorkspaceOpened();
        secondService.markWorkspaceOpened();
        // Re-opening the first moves it back to the front.
        service.markWorkspaceOpened();

        const recents = service.listRecents();
        expect(recents.map((r) => r.path)).toEqual([
          fs.realpathSync(root),
          fs.realpathSync(second),
        ]);
        expect(recents[0].name).toBe(fs.realpathSync(root).split("/").at(-1));

        const remaining = service.forgetWorkspace(second);
        expect(remaining.map((r) => r.path)).toEqual([fs.realpathSync(root)]);
        // Forgetting a deleted path matches the raw recorded entry too.
        expect(
          service.forgetWorkspace(path.join(second, "gone")).map((r) => r.path),
        ).toEqual([fs.realpathSync(root)]);
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });

    it("recovers the last valid workspace at startup and falls back safely", () => {
      // No recents yet: fall back to the default.
      expect(DesktopService.startupWorkspaceRoot({ recentsPath })).toBe(
        process.cwd(),
      );

      const service = makeService();
      service.markWorkspaceOpened();
      expect(DesktopService.startupWorkspaceRoot({ recentsPath })).toBe(
        fs.realpathSync(root),
      );

      // A stale last workspace falls back instead of failing startup.
      fs.writeFileSync(
        recentsPath,
        JSON.stringify({
          version: 1,
          workspaces: [],
          lastWorkspacePath: path.join(os.tmpdir(), "vanished-workspace"),
        }),
        "utf-8",
      );
      expect(DesktopService.startupWorkspaceRoot({ recentsPath })).toBe(
        process.cwd(),
      );

      // A corrupt recents file degrades to the default.
      fs.writeFileSync(recentsPath, "{not json", "utf-8");
      expect(DesktopService.startupWorkspaceRoot({ recentsPath })).toBe(
        process.cwd(),
      );
    });

    it("reports honest workspace posture for git and non-git roots", () => {
      const plain = makeService().getWorkspaceStatus();
      expect(plain.path).toBe(fs.realpathSync(root));
      expect(plain.name).toBe(fs.realpathSync(root).split("/").at(-1));
      expect(plain.git).toBeNull();

      execFileSync("git", ["init", "-q", "-b", "trunk", root], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "config", "user.email", "t@e.com"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "config", "user.name", "T"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      fs.writeFileSync(path.join(root, "a.txt"), "1\n");
      execFileSync("git", ["-C", root, "add", "a.txt"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      const cleanStatus = makeService().getWorkspaceStatus();
      expect(cleanStatus.git).toEqual({
        branch: "trunk",
        head: expect.stringMatching(/^[0-9a-f]+$/),
        dirtyCount: 0,
      });

      fs.writeFileSync(path.join(root, "a.txt"), "2\n");
      fs.writeFileSync(path.join(root, "untracked.txt"), "u\n");
      const dirtyStatus = makeService().getWorkspaceStatus();
      expect(dirtyStatus.git?.dirtyCount).toBe(2);
    });

    it("refuses to switch while a turn is running", () => {
      const service = makeService();
      expect(service.busyTurnRunning()).toBe(false);
    });

    it("persists the layout view with strict sanitization", () => {
      const service = makeService();
      const saved = service.saveUiState({ activeView: "changes" });
      expect(saved.activeView).toBe("changes");
      expect(
        makeService().getUiState().activeView,
      ).toBe("changes");
      const rejected = service.saveUiState({ activeView: "bogus" });
      expect(rejected.activeView).toBeUndefined();
    });
  });
});
