import { contextBridge, ipcRenderer } from "electron";
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
);

contextBridge.exposeInMainWorld("ohMyCliDesktop", bridge);
