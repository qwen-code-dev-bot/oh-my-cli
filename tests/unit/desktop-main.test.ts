import { describe, expect, it, vi } from "vitest";

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

    options: unknown;
    loadedUrl?: string;
    webContents = {
      navigationHandler: undefined as
        | ((event: { preventDefault(): void }) => void)
        | undefined,
      openHandler: undefined as
        | (() => { action: "deny" })
        | undefined,
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
      setWindowOpenHandler: vi.fn(
        (handler: () => { action: "deny" }) => {
          this.webContents.openHandler = handler;
        },
      ),
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
    BrowserWindow,
    handlers,
    windows,
    app: {
      getVersion: vi.fn(() => "0.1.0"),
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: () => unknown) => {
        handlers.set(channel, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  ipcMain: electron.ipcMain,
}));

describe("desktop main process", () => {
  it("registers the allowlisted handler and opens a local shell", async () => {
    await import("../../src/desktop/main.js");

    await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
    const handler = electron.handlers.get("desktop:get-bootstrap-state");
    expect(handler?.()).toEqual({
      platform: process.platform,
      version: "0.1.0",
    });

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
    const preventDefault = vi.fn();
    window.webContents.navigationHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.openHandler?.()).toEqual({ action: "deny" });
  });
});
