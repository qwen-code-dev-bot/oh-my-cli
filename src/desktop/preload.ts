import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createDesktopBridge, type DesktopAgentEvent } from "./contracts.js";

const bridge = createDesktopBridge(
  (channel, ...args) =>
    ipcRenderer.invoke(channel, ...args) as Promise<unknown>,
  (channel, listener) => {
    const handler = (_event: unknown, payload: DesktopAgentEvent) =>
      listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // Drag-and-drop provenance: resolve a dropped File to its filesystem path so
  // the main process can confine it to the workspace before validation.
  (file: File) => webUtils.getPathForFile(file),
);

contextBridge.exposeInMainWorld("ohMyCliDesktop", bridge);
