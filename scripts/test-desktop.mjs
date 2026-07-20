import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { app, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "../dist/desktop/contracts.js";
import { createDesktopWindow } from "../dist/desktop/window.js";

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
}));

async function run() {
  console.log("Electron Xvfb interaction: app ready");
  const window = await createDesktopWindow();
  console.log("Electron Xvfb interaction: window loaded");
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const ready = () => document.querySelector('[data-workbench-state="ready"]');
    if (ready()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Desktop renderer did not reach ready state'));
    }, 5000);
  })`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const chat = document.querySelector('[data-view="chat"]');
    chat?.focus();
    chat?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    document.querySelector('[data-action="open-diagnostics"]')?.click();
    const composer = document.querySelector('[aria-label="Message"]');
    composer?.focus();
    return {
      state: document.querySelector('[data-workbench-state]')?.dataset.workbenchState,
      projects: Boolean(document.querySelector('[aria-label="Projects and sessions"]')),
      workbench: Boolean(document.querySelector('[aria-label="Agent workbench"]')),
      inspector: Boolean(document.querySelector('[aria-label="Context inspector"]')),
      focused: document.activeElement?.getAttribute('aria-label'),
      activeView: document.querySelector('[aria-selected="true"]')?.getAttribute('data-view'),
      diagnostics: Boolean(document.querySelector('[role="dialog"]')),
      version: document.querySelector('[data-diagnostic="version"]')?.textContent,
      protocol: location.protocol,
    };
  })()`);

  assert.deepEqual(result, {
    state: "ready",
    projects: true,
    workbench: true,
    inspector: true,
    focused: "Message",
    activeView: "workflow",
    diagnostics: true,
    version: app.getVersion(),
    protocol: "file:",
  });
  if (process.env.DESKTOP_SCREENSHOT_PATH) {
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const image = await window.webContents.capturePage();
    await writeFile(process.env.DESKTOP_SCREENSHOT_PATH, image.toPNG());
    console.log(
      `Electron Xvfb interaction: screenshot ${process.env.DESKTOP_SCREENSHOT_PATH}`,
    );
  }
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
