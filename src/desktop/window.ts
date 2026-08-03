import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";
import { createDesktopWindowOptions } from "./window-options.js";
import { classifyZoomKey, stepZoomLevel } from "./zoom.js";

export interface CreateDesktopWindowOptions {
  // Called with the resulting level after a keyboard zoom chord is applied,
  // so the main process can persist it (Issue #532).
  onZoomChanged?: (level: number) => void;
}

export async function createDesktopWindow(
  opts: CreateDesktopWindowOptions = {},
): Promise<BrowserWindow> {
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
    const next = stepZoomLevel(window.webContents.getZoomLevel(), decision);
    window.webContents.setZoomLevel(next);
    opts.onZoomChanged?.(next);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shell = fileURLToPath(
    new URL("../../dist/desktop/index.html", import.meta.url),
  );
  await window.loadFile(shell);
  return window;
}
