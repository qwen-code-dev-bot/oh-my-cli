import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke },
}));

describe("desktop preload", () => {
  beforeEach(() => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    vi.resetModules();
  });

  it("publishes only the typed desktop bridge", async () => {
    electron.invoke.mockResolvedValue({
      platform: "darwin",
      version: "0.1.0",
    });

    await import("../../src/desktop/preload.js");

    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, bridge] = electron.exposeInMainWorld.mock.calls[0] as [
      string,
      { getBootstrapState(): Promise<unknown> },
    ];
    expect(name).toBe("ohMyCliDesktop");
    expect(Object.keys(bridge)).toEqual(["getBootstrapState"]);
    await bridge.getBootstrapState();
    expect(electron.invoke).toHaveBeenCalledWith(
      "desktop:get-bootstrap-state",
    );
  });
});
