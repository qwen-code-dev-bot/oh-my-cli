// The Desktop application menu (Issue #523, community report #521).
//
// Installed explicitly so zoom is a visible product feature instead of an
// accident of Electron/Chromium defaults. The zoom entries deliberately carry
// no accelerators: keyboard zoom flows through the window's layout-independent
// before-input-event path (src/desktop/zoom.ts), so a key press can never
// trigger zoom twice (once via a menu accelerator, once via the key handler).

import type { MenuItemConstructorOptions } from "electron";
import type { ZoomDecision } from "./zoom.js";

export function buildDesktopMenuTemplate(
  onZoom: (decision: ZoomDecision) => void,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", click: () => onZoom("zoom-reset") },
        { label: "Zoom In", click: () => onZoom("zoom-in") },
        { label: "Zoom Out", click: () => onZoom("zoom-out") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
