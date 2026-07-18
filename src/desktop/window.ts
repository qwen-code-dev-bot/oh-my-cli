import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";
import {
  createDesktopViewModel,
  renderDesktopShell,
} from "./renderer.js";
import { createDesktopWindowOptions } from "./window-options.js";

export async function createDesktopWindow(): Promise<BrowserWindow> {
  const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const window = new BrowserWindow(createDesktopWindowOptions(preload));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shell = renderDesktopShell(createDesktopViewModel("ready"));
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(shell)}`,
  );
  return window;
}
