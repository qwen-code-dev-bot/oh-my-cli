import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "./contracts.js";
import {
  createDesktopViewModel,
  renderDesktopShell,
} from "./renderer.js";
import { createDesktopWindowOptions } from "./window-options.js";

function createDesktopWindow(): BrowserWindow {
  const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const window = new BrowserWindow(createDesktopWindowOptions(preload));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shell = renderDesktopShell(createDesktopViewModel("ready"));
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(shell)}`,
  );
  return window;
}

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
}));

void app.whenReady().then(() => {
  createDesktopWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDesktopWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
