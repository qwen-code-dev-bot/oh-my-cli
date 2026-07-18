import assert from "node:assert/strict";
import { app } from "electron";
import { createDesktopWindow } from "../dist/desktop/window.js";

async function run() {
  console.log("Electron Xvfb interaction: app ready");
  const window = await createDesktopWindow();
  console.log("Electron Xvfb interaction: window loaded");
  const result = await window.webContents.executeJavaScript(`(() => {
    const composer = document.querySelector('[aria-label="Message"]');
    composer?.focus();
    return {
      state: document.querySelector('[data-workbench-state]')?.dataset.workbenchState,
      projects: Boolean(document.querySelector('[aria-label="Projects and sessions"]')),
      workbench: Boolean(document.querySelector('[aria-label="Agent workbench"]')),
      inspector: Boolean(document.querySelector('[aria-label="Context inspector"]')),
      focused: document.activeElement?.getAttribute('aria-label'),
      protocol: location.protocol,
    };
  })()`);

  assert.deepEqual(result, {
    state: "ready",
    projects: true,
    workbench: true,
    inspector: true,
    focused: "Message",
    protocol: "data:",
  });
  window.destroy();
  console.log("Electron Xvfb interaction: PASS");
  app.quit();
}

function fail(error) {
  console.error(error);
  app.exit(1);
}

console.log("Electron Xvfb interaction: starting");
void app.whenReady().then(run).catch(fail);
