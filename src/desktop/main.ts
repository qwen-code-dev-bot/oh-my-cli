import { app, BrowserWindow, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "./contracts.js";
import { DesktopService } from "./service.js";
import { createDesktopWindow } from "./window.js";

const service = new DesktopService();

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
  workspaceName: service.workspace.root.split(/[\\/]/).at(-1) ?? "Workspace",
}));
ipcMain.handle(DESKTOP_CHANNELS.listSessions, () => service.listSessions());
ipcMain.handle(DESKTOP_CHANNELS.createSession, () => service.createSession());
ipcMain.handle(DESKTOP_CHANNELS.loadSession, (_event, sessionId: string) =>
  service.loadSession(sessionId),
);
ipcMain.handle(DESKTOP_CHANNELS.renameSession, (_event, request) =>
  service.renameSession(request),
);
ipcMain.handle(DESKTOP_CHANNELS.setSessionArchived, (_event, request) =>
  service.setSessionArchived(request),
);
ipcMain.handle(DESKTOP_CHANNELS.deleteSession, (_event, sessionId: string) =>
  service.deleteSession(sessionId),
);
ipcMain.handle(DESKTOP_CHANNELS.sendMessage, (event, request) =>
  service.sendMessage(request, (payload) => {
    event.sender.send(DESKTOP_CHANNELS.agentEvent, payload);
  }),
);
ipcMain.handle(DESKTOP_CHANNELS.cancelTurn, (_event, sessionId: string) =>
  service.cancelTurn(sessionId),
);
ipcMain.handle(DESKTOP_CHANNELS.retryTurn, (event, sessionId: string) =>
  service.retryTurn(sessionId, (payload) => {
    event.sender.send(DESKTOP_CHANNELS.agentEvent, payload);
  }),
);
ipcMain.handle(DESKTOP_CHANNELS.attachImages, (_event, paths: string[]) =>
  service.attachImages(paths),
);
ipcMain.handle(DESKTOP_CHANNELS.attachImageFiles, (_event, paths: string[]) =>
  service.attachImageFiles(paths),
);
ipcMain.handle(DESKTOP_CHANNELS.getRuntimeInfo, () => service.getRuntimeInfo());
ipcMain.handle(DESKTOP_CHANNELS.setSelectedProfile, (_event, profile) =>
  service.setSelectedProfile(profile),
);
ipcMain.handle(DESKTOP_CHANNELS.getUiState, () => service.getUiState());
ipcMain.handle(DESKTOP_CHANNELS.saveUiState, (_event, request) =>
  service.saveUiState(request),
);
ipcMain.handle(DESKTOP_CHANNELS.listWorkspaceFiles, () =>
  service.listWorkspaceFiles(),
);
ipcMain.handle(DESKTOP_CHANNELS.readWorkspaceFile, (_event, filePath: string) =>
  service.readWorkspaceFile(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.writeWorkspaceFile, (_event, request) =>
  service.writeWorkspaceFile(request),
);

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
