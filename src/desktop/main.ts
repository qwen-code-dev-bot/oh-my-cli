import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { DESKTOP_CHANNELS } from "./contracts.js";
import { DesktopService } from "./service.js";
import { createDesktopWindow } from "./window.js";
import { buildDesktopMenuTemplate } from "./menu.js";
import { stepZoomLevel, type ZoomDecision } from "./zoom.js";

// The active service is swapped atomically when the user opens or switches a
// workspace (#491). Every handler closes over this binding, so all IPC after
// a switch is owned by the new workspace's service — sessions, drafts, and
// files never cross the boundary.
let service = new DesktopService({
  workspaceRoot: DesktopService.startupWorkspaceRoot(),
});
service.markWorkspaceOpened();

function broadcastWorkspaceSwitched(): void {
  const status = service.getWorkspaceStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    // Delivered on the agent-event channel: workspace-switched is part of the
    // DesktopAgentEvent union, and it is the only channel the sandboxed
    // renderer subscribes to.
    window.webContents.send(DESKTOP_CHANNELS.agentEvent, {
      type: "workspace-switched",
      path: status.path,
      name: status.name,
    });
  }
}

function switchWorkspace(requestedPath: string) {
  const canonical = service.canonicalWorkspacePath(requestedPath);
  if (canonical === service.workspace.root) {
    return service.getWorkspaceStatus();
  }
  if (service.busyTurnRunning()) {
    throw new Error("Wait for the running turn to finish before switching");
  }
  service = new DesktopService({ workspaceRoot: canonical });
  service.markWorkspaceOpened();
  broadcastWorkspaceSwitched();
  return service.getWorkspaceStatus();
}

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
  workspaceName:
    service.workspace.root.split(/[\\/]/).filter(Boolean).at(-1) ??
    "Workspace",
}));
ipcMain.handle(DESKTOP_CHANNELS.getWorkspaceStatus, () =>
  service.getWorkspaceStatus(),
);
ipcMain.handle(DESKTOP_CHANNELS.listRecents, () => service.listRecents());
ipcMain.handle(DESKTOP_CHANNELS.forgetWorkspace, (_event, workspacePath) =>
  service.forgetWorkspace(workspacePath),
);
ipcMain.handle(DESKTOP_CHANNELS.openWorkspaceDialog, async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = window
    ? await dialog.showOpenDialog(window, {
        title: "Open workspace folder",
        properties: ["openDirectory"],
      })
    : await dialog.showOpenDialog({
        title: "Open workspace folder",
        properties: ["openDirectory"],
      });
  if (result.canceled || result.filePaths.length === 0) return null;
  return switchWorkspace(result.filePaths[0]);
});
ipcMain.handle(DESKTOP_CHANNELS.switchWorkspace, (_event, workspacePath) =>
  switchWorkspace(workspacePath),
);
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
ipcMain.handle(DESKTOP_CHANNELS.listWorkspaceDirectory, (_event, dirPath) =>
  service.listWorkspaceDirectory(dirPath),
);
ipcMain.handle(DESKTOP_CHANNELS.searchWorkspaceFiles, (_event, query) =>
  service.searchWorkspaceFiles(query),
);
ipcMain.handle(DESKTOP_CHANNELS.createWorkspaceFile, (_event, filePath) =>
  service.createWorkspaceFile(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.renameWorkspaceFile, (_event, request) =>
  service.renameWorkspaceFile(request),
);
ipcMain.handle(DESKTOP_CHANNELS.deleteWorkspaceFile, (_event, filePath) =>
  service.deleteWorkspaceFile(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.getWorkspaceDiff, () =>
  service.getWorkspaceDiff(),
);
ipcMain.handle(DESKTOP_CHANNELS.getWorkspaceFileDiff, (_event, filePath) =>
  service.getWorkspaceFileDiff(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.readWorkspaceFile, (_event, filePath: string) =>
  service.readWorkspaceFile(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.writeWorkspaceFile, (_event, request) =>
  service.writeWorkspaceFile(request),
);

// Apply one zoom step (or the reset) to the focused window through the bounded
// ladder (Issue #523) and persist the resulting level (Issue #532). Menu zoom
// entries route here; keyboard zoom flows through the window's
// before-input-event path, which reports through onZoomChanged — both paths
// persist through the same service method.
function applyZoom(decision: ZoomDecision): void {
  const window = BrowserWindow.getFocusedWindow();
  if (!window) return;
  const next = stepZoomLevel(window.webContents.getZoomLevel(), decision);
  window.webContents.setZoomLevel(next);
  service.setZoomLevel(next);
}

// Open a window with the workspace's persisted zoom level applied (Issue
// #532): zoom is a user preference, so a relaunch restores the last scale.
async function openZoomedWindow(): Promise<void> {
  const window = await createDesktopWindow({
    onZoomChanged: (level) => service.setZoomLevel(level),
  });
  window.webContents.setZoomLevel(service.getZoomLevel());
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildDesktopMenuTemplate(applyZoom)));
  void openZoomedWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openZoomedWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
