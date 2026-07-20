import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";
import { createDesktopWindowOptions } from "./window-options.js";

export async function createDesktopWindow(): Promise<BrowserWindow> {
  const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const window = new BrowserWindow(createDesktopWindowOptions(preload));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shell = fileURLToPath(
    new URL("../../dist/desktop/index.html", import.meta.url),
  );
  await window.loadFile(shell);
  return window;
}
