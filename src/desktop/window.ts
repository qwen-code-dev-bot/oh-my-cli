import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";
import { createDesktopWindowOptions } from "./window-options.js";
import { classifyZoomKey, stepZoomLevel } from "./zoom.js";

export async function createDesktopWindow(): Promise<BrowserWindow> {
  const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const window = new BrowserWindow(createDesktopWindowOptions(preload));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  // Layout-independent keyboard zoom (Issue #523, community report #521): the
  // classifier matches the zoom chords regardless of Shift state or layout,
  // and the ladder clamps to the bounded 50%–200% range. This is the only
  // keyboard zoom path — the menu's zoom entries carry no accelerators.
  window.webContents.on("before-input-event", (event, input) => {
    const decision = classifyZoomKey(input);
    if (!decision) return;
    event.preventDefault();
    window.webContents.setZoomLevel(
      stepZoomLevel(window.webContents.getZoomLevel(), decision),
    );
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shell = fileURLToPath(
    new URL("../../dist/desktop/index.html", import.meta.url),
  );
  await window.loadFile(shell);
  return window;
}
