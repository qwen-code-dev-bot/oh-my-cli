import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CHANNELS,
  createDesktopBridge,
} from "../../src/desktop/contracts.js";

describe("desktop preload contract", () => {
  it("freezes the complete allowlist", () => {
    expect(DESKTOP_CHANNELS).toEqual({
      getBootstrapState: "desktop:get-bootstrap-state",
      listSessions: "desktop:list-sessions",
      createSession: "desktop:create-session",
      loadSession: "desktop:load-session",
      sendMessage: "desktop:send-message",
      listWorkspaceFiles: "desktop:list-workspace-files",
      readWorkspaceFile: "desktop:read-workspace-file",
      writeWorkspaceFile: "desktop:write-workspace-file",
      agentEvent: "desktop:agent-event",
    });
    expect(Object.isFrozen(DESKTOP_CHANNELS)).toBe(true);
  });

  it("maps every operation to an allowlisted channel", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const bridge = createDesktopBridge(invoke, subscribe);

    await bridge.getBootstrapState();
    await bridge.listSessions();
    await bridge.createSession();
    await bridge.loadSession("session-id");
    await bridge.sendMessage({ sessionId: "session-id", prompt: "hello" });
    await bridge.listWorkspaceFiles();
    await bridge.readWorkspaceFile("src/index.ts");
    await bridge.writeWorkspaceFile({ path: "src/index.ts", content: "next" });
    const listener = vi.fn();
    expect(bridge.onAgentEvent(listener)).toBe(unsubscribe);

    expect(invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.getBootstrapState],
      [DESKTOP_CHANNELS.listSessions],
      [DESKTOP_CHANNELS.createSession],
      [DESKTOP_CHANNELS.loadSession, "session-id"],
      [
        DESKTOP_CHANNELS.sendMessage,
        { sessionId: "session-id", prompt: "hello" },
      ],
      [DESKTOP_CHANNELS.listWorkspaceFiles],
      [DESKTOP_CHANNELS.readWorkspaceFile, "src/index.ts"],
      [
        DESKTOP_CHANNELS.writeWorkspaceFile,
        { path: "src/index.ts", content: "next" },
      ],
    ]);
    expect(subscribe).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.agentEvent,
      listener,
    );
    expect(Object.isFrozen(bridge)).toBe(true);
  });
});
