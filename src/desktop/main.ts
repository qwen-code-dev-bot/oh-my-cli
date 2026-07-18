import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "./contracts.js";
import { createDesktopWindowOptions } from "./window-options.js";

const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <title>Oh My CLI Desktop</title>
  </head>
  <body><main>Oh My CLI Desktop</main></body>
</html>`;

function createDesktopWindow(): BrowserWindow {
  const preload = fileURLToPath(
    new URL("./preload.cjs", import.meta.url),
  );
  const window = new BrowserWindow(
    createDesktopWindowOptions(preload),
  );
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
