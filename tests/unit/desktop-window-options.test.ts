import { describe, expect, it } from "vitest";
import { createDesktopWindowOptions } from "../../src/desktop/window-options.js";

describe("desktop window security", () => {
  it("creates a hardened macOS-first BrowserWindow configuration", () => {
    const options = createDesktopWindowOptions("/app/dist/desktop/preload.js");

    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#0b0f14",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: "/app/dist/desktop/preload.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(options.webPreferences).not.toHaveProperty("enableRemoteModule");
  });
});
