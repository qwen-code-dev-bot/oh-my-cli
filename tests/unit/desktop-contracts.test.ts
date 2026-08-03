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
      cancelTurn: "desktop:cancel-turn",
      retryTurn: "desktop:retry-turn",
      attachImages: "desktop:attach-images",
      attachImageFiles: "desktop:attach-image-files",
      getRuntimeInfo: "desktop:get-runtime-info",
      setSelectedProfile: "desktop:set-selected-profile",
      getUiState: "desktop:get-ui-state",
      saveUiState: "desktop:save-ui-state",
      listWorkspaceFiles: "desktop:list-workspace-files",
      listWorkspaceDirectory: "desktop:list-workspace-directory",
      searchWorkspaceFiles: "desktop:search-workspace-files",
      createWorkspaceFile: "desktop:create-workspace-file",
      renameWorkspaceFile: "desktop:rename-workspace-file",
      deleteWorkspaceFile: "desktop:delete-workspace-file",
      getWorkspaceDiff: "desktop:get-workspace-diff",
      getWorkspaceFileDiff: "desktop:get-workspace-file-diff",
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
    const pathForFile = vi.fn((file: File) => `/workspace/${file.name}`);
    const bridge = createDesktopBridge(invoke, subscribe, pathForFile);

    await bridge.getBootstrapState();
    await bridge.listSessions();
    await bridge.createSession();
    await bridge.loadSession("session-id");
    await bridge.renameSession({ sessionId: "session-id", title: "Renamed" });
    await bridge.setSessionArchived({ sessionId: "session-id", archived: true });
    await bridge.deleteSession("session-id");
    await bridge.sendMessage({ sessionId: "session-id", prompt: "hello" });
    await bridge.cancelTurn("session-id");
    await bridge.retryTurn("session-id");
    await bridge.attachImages(["img.png"]);
    await bridge.attachImageFiles(["/abs/img.png"]);
    await bridge.getRuntimeInfo();
    await bridge.setSelectedProfile("qwen");
    await bridge.getUiState();
    await bridge.saveUiState({ activeSessionId: "session-id" });
    await bridge.listWorkspaceFiles();
    await bridge.listWorkspaceDirectory("src");
    await bridge.searchWorkspaceFiles("app");
    await bridge.createWorkspaceFile("src/new.ts");
    await bridge.renameWorkspaceFile({ from: "src/a.ts", to: "src/b.ts" });
    await bridge.deleteWorkspaceFile("src/b.ts");
    await bridge.getWorkspaceDiff();
    await bridge.getWorkspaceFileDiff("src/app.ts");
    await bridge.readWorkspaceFile("src/index.ts");
    await bridge.writeWorkspaceFile({ path: "src/index.ts", content: "next" });
    const dropped = { name: "pic.png" } as File;
    expect(bridge.getPathForFile(dropped)).toBe("/workspace/pic.png");
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
      [DESKTOP_CHANNELS.cancelTurn, "session-id"],
      [DESKTOP_CHANNELS.retryTurn, "session-id"],
      [DESKTOP_CHANNELS.attachImages, ["img.png"]],
      [DESKTOP_CHANNELS.attachImageFiles, ["/abs/img.png"]],
      [DESKTOP_CHANNELS.getRuntimeInfo],
      [DESKTOP_CHANNELS.setSelectedProfile, "qwen"],
      [DESKTOP_CHANNELS.getUiState],
      [DESKTOP_CHANNELS.saveUiState, { activeSessionId: "session-id" }],
      [DESKTOP_CHANNELS.listWorkspaceFiles],
      [DESKTOP_CHANNELS.listWorkspaceDirectory, "src"],
      [DESKTOP_CHANNELS.searchWorkspaceFiles, "app"],
      [DESKTOP_CHANNELS.createWorkspaceFile, "src/new.ts"],
      [
        DESKTOP_CHANNELS.renameWorkspaceFile,
        { from: "src/a.ts", to: "src/b.ts" },
      ],
      [DESKTOP_CHANNELS.deleteWorkspaceFile, "src/b.ts"],
      [DESKTOP_CHANNELS.getWorkspaceDiff],
      [DESKTOP_CHANNELS.getWorkspaceFileDiff, "src/app.ts"],
      [DESKTOP_CHANNELS.readWorkspaceFile, "src/index.ts"],
      [
        DESKTOP_CHANNELS.writeWorkspaceFile,
        { path: "src/index.ts", content: "next" },
      ],
    ]);
    expect(pathForFile).toHaveBeenCalledWith(dropped);
    expect(subscribe).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.agentEvent,
      listener,
    );
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it("fails closed when file path resolution is unavailable", () => {
    const bridge = createDesktopBridge(vi.fn(), vi.fn());
    expect(() => bridge.getPathForFile({ name: "x" } as File)).toThrow(
      "File path resolution is unavailable",
    );
  });
});
