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
      renameSession: "desktop:rename-session",
      setSessionArchived: "desktop:set-session-archived",
      deleteSession: "desktop:delete-session",
      sendMessage: "desktop:send-message",
      getUiState: "desktop:get-ui-state",
      saveUiState: "desktop:save-ui-state",
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
    await bridge.renameSession({ sessionId: "session-id", title: "Renamed" });
    await bridge.setSessionArchived({ sessionId: "session-id", archived: true });
    await bridge.deleteSession("session-id");
    await bridge.sendMessage({ sessionId: "session-id", prompt: "hello" });
    await bridge.getUiState();
    await bridge.saveUiState({ activeSessionId: "session-id" });
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
        DESKTOP_CHANNELS.renameSession,
        { sessionId: "session-id", title: "Renamed" },
      ],
      [
        DESKTOP_CHANNELS.setSessionArchived,
        { sessionId: "session-id", archived: true },
      ],
      [DESKTOP_CHANNELS.deleteSession, "session-id"],
      [
        DESKTOP_CHANNELS.sendMessage,
        { sessionId: "session-id", prompt: "hello" },
      ],
      [DESKTOP_CHANNELS.getUiState],
      [DESKTOP_CHANNELS.saveUiState, { activeSessionId: "session-id" }],
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
