import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: Array<{
    options: unknown;
    loadedFile?: string;
  }> = [];
  const handlers = new Map<string, () => unknown>();
  class BrowserWindow {
    static getAllWindows(): BrowserWindow[] {
      return windows as BrowserWindow[];
    }

    static fromWebContents(): undefined {
      return undefined;
    }

    options: unknown;
    loadedUrl?: string;
    webContents = {
      send: vi.fn(),
      navigationHandler: undefined as
        ((event: { preventDefault(): void }) => void) | undefined,
      openHandler: undefined as (() => { action: "deny" }) | undefined,
      on: vi.fn(
        (
          event: string,
          handler: (event: { preventDefault(): void }) => void,
        ) => {
          if (event === "will-navigate") {
            this.webContents.navigationHandler = handler;
          }
        },
      ),
      setWindowOpenHandler: vi.fn((handler: () => { action: "deny" }) => {
        this.webContents.openHandler = handler;
      }),
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(),
    };

    constructor(options: unknown) {
      this.options = options;
      windows.push(this);
    }

    async loadFile(file: string): Promise<void> {
      this.loadedFile = file;
    }
  }

  return {
    BrowserWindow: Object.assign(BrowserWindow, {
      getFocusedWindow: () => undefined,
    }),
    handlers,
    windows,
    app: {
      getVersion: vi.fn(() => "0.1.0"),
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: () => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn((template: unknown) => template),
    },
  };
});

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  Menu: electron.Menu,
}));

// The module under test constructs its service at import time and persists the
// startup workspace; point HOME at a scratch dir so the unit test never
// touches the real user state.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "omc-main-home-"));
const savedHome = process.env.HOME;
process.env.HOME = scratchHome;
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe("desktop main process", () => {
  it("registers the allowlisted handler and opens a local shell", async () => {
    await import("../../src/desktop/main.js");

    await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
    const handler = electron.handlers.get("desktop:get-bootstrap-state");
    expect(handler?.()).toEqual({
      platform: process.platform,
      version: "0.1.0",
      workspaceName: path.basename(process.cwd()),
    });
    expect([...electron.handlers.keys()]).toEqual(
      expect.arrayContaining([
        "desktop:get-workspace-status",
        "desktop:list-recents",
        "desktop:forget-workspace",
        "desktop:open-workspace-dialog",
        "desktop:switch-workspace",
        "desktop:list-sessions",
        "desktop:create-session",
        "desktop:load-session",
        "desktop:rename-session",
        "desktop:set-session-archived",
        "desktop:delete-session",
        "desktop:send-message",
        "desktop:cancel-turn",
        "desktop:retry-turn",
        "desktop:attach-images",
        "desktop:attach-image-files",
        "desktop:get-runtime-info",
        "desktop:set-selected-profile",
        "desktop:get-ui-state",
        "desktop:save-ui-state",
        "desktop:list-workspace-files",
        "desktop:read-workspace-file",
        "desktop:write-workspace-file",
      ]),
    );

    const [window] = electron.windows;
    expect(window.options).toMatchObject({
      webPreferences: {
        preload: expect.stringMatching(/preload\.cjs$/),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(window.loadedFile).toMatch(/dist\/desktop\/index\.html$/);

    // The application menu is installed explicitly (Issue #523): the View
    // submenu carries zoom entries without accelerators, so keyboard zoom
    // flows only through the layout-independent before-input-event path and a
    // key press can never zoom twice.
    const installed = electron.Menu.setApplicationMenu.mock.calls[0]?.[0] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(installed).toBeDefined();
    const view = installed?.find((item) => item.label === "View") as
      | { submenu: Array<Record<string, unknown>> }
      | undefined;
    expect(view).toBeDefined();
    const zoomEntries = (view?.submenu ?? []).filter(
      (item) => typeof item.label === "string",
    );
    expect(zoomEntries.map((item) => item.label)).toEqual([
      "Actual Size",
      "Zoom In",
      "Zoom Out",
    ]);
    for (const entry of zoomEntries) {
      expect(entry.accelerator).toBeUndefined();
      expect(typeof entry.click).toBe("function");
    }

    const preventDefault = vi.fn();
    window.webContents.navigationHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.openHandler?.()).toEqual({ action: "deny" });
  });

  it("tracks workspace status, recents, and fail-closed switching", async () => {
    await import("../../src/desktop/main.js");
    const call = <T>(channel: string, ...args: unknown[]): T => {
      const handler = electron.handlers.get(channel) as
        | ((...a: unknown[]) => T)
        | undefined;
      if (!handler) throw new Error(`missing handler ${channel}`);
      // ipcMain handlers receive the event first.
      return handler({ sender: { send: () => {} } }, ...args);
    };

    // The startup workspace is canonical, honest about git, and remembered.
    const status = call<{ path: string; name: string }>(
      "desktop:get-workspace-status",
    );
    expect(status.path).toBe(fs.realpathSync(process.cwd()));
    expect(status.name).toBe(path.basename(process.cwd()));
    const recents = call<Array<{ path: string }>>("desktop:list-recents");
    expect(recents.map((r) => r.path)).toContain(status.path);

    // Switching to a valid folder swaps the owning service and remembers it.
    const other = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "omc-main-other-")),
    );
    try {
      const switched = call<{ path: string }>(
        "desktop:switch-workspace",
        other,
      );
      expect(switched.path).toBe(other);
      // The renderer is told to re-bootstrap against the new workspace. The
      // signal rides the agent-event channel (the only one the sandboxed
      // renderer subscribes to).
      const [broadcastWindow] = electron.windows;
      expect(broadcastWindow.webContents.send).toHaveBeenCalledWith(
        "desktop:agent-event",
        expect.objectContaining({
          type: "workspace-switched",
          path: other,
        }),
      );
      expect(
        call<Array<{ path: string }>>("desktop:list-recents").map(
          (r) => r.path,
        )[0],
      ).toBe(other);
      // The bootstrap state follows the new workspace.
      expect(
        call<{ workspaceName: string }>("desktop:get-bootstrap-state")
          .workspaceName,
      ).toBe(path.basename(other));

      // Switching back restores the original boundary.
      expect(call<{ path: string }>("desktop:switch-workspace", status.path).path).toBe(
        status.path,
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }

    // Missing paths fail closed; the active workspace is untouched.
    expect(() =>
      call("desktop:switch-workspace", path.join(os.tmpdir(), "nope-404")),
    ).toThrow("Workspace not found");
    expect(() => call("desktop:switch-workspace", "")).toThrow(
      "A workspace path is required",
    );
    expect(
      call<{ path: string }>("desktop:get-workspace-status").path,
    ).toBe(status.path);

    // Forgetting removes the entry from recents.
    const forgotten = call<Array<{ path: string }>>(
      "desktop:forget-workspace",
      status.path,
    );
    expect(forgotten.map((r) => r.path)).not.toContain(status.path);

    // The dialog handler honors a cancelled dialog.
    const cancelled = await (
      electron.handlers.get("desktop:open-workspace-dialog") as (
        event: unknown,
      ) => Promise<unknown>
    )({ sender: { send: () => {} } });
    expect(cancelled).toBeNull();
  });
});
