import { app, BrowserWindow, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "./contracts.js";
import { createDesktopWindow } from "./window.js";

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
}));

void app.whenReady().then(() => {
  void createDesktopWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createDesktopWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
