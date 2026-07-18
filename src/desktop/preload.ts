import { contextBridge, ipcRenderer } from "electron";
import {
  createDesktopBridge,
  type DesktopBootstrapState,
} from "./contracts.js";

const bridge = createDesktopBridge(
  (channel) =>
    ipcRenderer.invoke(channel) as Promise<DesktopBootstrapState>,
);

contextBridge.exposeInMainWorld("ohMyCliDesktop", bridge);
