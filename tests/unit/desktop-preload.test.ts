import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn((file: { name?: string }) => `/tmp/${file?.name}`),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  webUtils: { getPathForFile: electron.getPathForFile },
}));

describe("desktop preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("publishes only the typed desktop bridge", async () => {
    electron.invoke.mockResolvedValue({ ok: true });
    await import("../../src/desktop/preload.js");

    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, bridge] = electron.exposeInMainWorld.mock.calls[0] as [
      string,
      Record<string, (...args: unknown[]) => unknown>,
    ];
    expect(name).toBe("ohMyCliDesktop");
    expect(Object.keys(bridge)).toEqual([
      "getBootstrapState",
      "listSessions",
      "createSession",
      "loadSession",
      "renameSession",
      "setSessionArchived",
      "deleteSession",
      "sendMessage",
      "cancelTurn",
      "retryTurn",
      "attachImages",
      "attachImageFiles",
      "getRuntimeInfo",
      "setSelectedProfile",
      "getUiState",
      "saveUiState",
      "listWorkspaceFiles",
      "readWorkspaceFile",
      "writeWorkspaceFile",
      "getPathForFile",
      "onAgentEvent",
    ]);

    await bridge.sendMessage({ sessionId: "one", prompt: "hello" });
    expect(electron.invoke).toHaveBeenCalledWith("desktop:send-message", {
      sessionId: "one",
      prompt: "hello",
    });

    const dropped = { name: "pic.png" };
    expect(bridge.getPathForFile(dropped)).toBe("/tmp/pic.png");
    expect(electron.getPathForFile).toHaveBeenCalledWith(dropped);

    const listener = vi.fn();
    const unsubscribe = bridge.onAgentEvent(listener) as () => void;
    expect(electron.on).toHaveBeenCalledWith(
      "desktop:agent-event",
      expect.any(Function),
    );
    const handler = electron.on.mock.calls[0][1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    handler({}, { type: "status", sessionId: "one", message: "ready" });
    expect(listener).toHaveBeenCalledWith({
      type: "status",
      sessionId: "one",
      message: "ready",
    });
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "desktop:agent-event",
      handler,
    );
  });
});
