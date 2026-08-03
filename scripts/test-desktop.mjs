import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "../dist/desktop/contracts.js";
import { DesktopService } from "../dist/desktop/service.js";
import { SessionStore } from "../dist/session.js";
import { createDesktopWindow } from "../dist/desktop/window.js";

const fixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "oh-my-cli-desktop-e2e-"),
);
const sessionRoot = await mkdtemp(
  path.join(os.tmpdir(), "oh-my-cli-desktop-e2e-sessions-"),
);
await writeFile(path.join(fixtureRoot, "demo.txt"), "before\n", "utf-8");

const service = new DesktopService({
  workspaceRoot: fixtureRoot,
  store: new SessionStore(sessionRoot),
  resolveConfig: () => ({
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "qwen3.8-max",
  }),
  run: async (prompt, _messages, options) => {
    options.onMessage({ role: "user", content: prompt });
    options.sink?.assistantDelta("Desktop ");
    options.sink?.toolStart({ id: "one", name: "read", round: 0 });
    options.sink?.toolResult({
      id: "one",
      name: "read",
      result: { content: "ok" },
      round: 0,
    });
    options.sink?.assistantDelta("ready");
    options.onMessage({ role: "assistant", content: "Desktop ready" });
    return {
      text: "Desktop ready",
      ok: true,
      reason: "completed",
      rounds: 1,
      retries: 0,
      stats: { toolCalls: { read: 1 }, toolFailures: {} },
      tokens: null,
      estimatedCostUsd: null,
      costKnown: false,
    };
  },
});

ipcMain.handle(DESKTOP_CHANNELS.getBootstrapState, () => ({
  platform: process.platform,
  version: app.getVersion(),
  workspaceName: "desktop-e2e",
}));
ipcMain.handle(DESKTOP_CHANNELS.listSessions, () => service.listSessions());
ipcMain.handle(DESKTOP_CHANNELS.createSession, () => service.createSession());
ipcMain.handle(DESKTOP_CHANNELS.loadSession, (_event, id) =>
  service.loadSession(id),
);
ipcMain.handle(DESKTOP_CHANNELS.sendMessage, (event, request) =>
  service.sendMessage(request, (payload) =>
    event.sender.send(DESKTOP_CHANNELS.agentEvent, payload),
  ),
);
ipcMain.handle(DESKTOP_CHANNELS.listWorkspaceFiles, () =>
  service.listWorkspaceFiles(),
);
ipcMain.handle(DESKTOP_CHANNELS.readWorkspaceFile, (_event, filePath) =>
  service.readWorkspaceFile(filePath),
);
ipcMain.handle(DESKTOP_CHANNELS.writeWorkspaceFile, (_event, request) =>
  service.writeWorkspaceFile(request),
);

async function waitFor(window, expression) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const ready = () => (${expression});
    if (ready()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Desktop renderer did not reach expected state'));
    }, 5000);
  })`);
}

async function run() {
  console.log("Electron Xvfb interaction: app ready");
  const window = await createDesktopWindow();
  console.log("Electron Xvfb interaction: window loaded");
  await waitFor(
    window,
    `document.querySelector('[data-workbench-state="ready"]')`,
  );

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="new-session"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-session-id]') && !document.querySelector('[aria-label="Message"]')?.disabled`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Prove the Desktop chat works';
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(
    window,
    `document.body.textContent.includes('Desktop ready') && document.querySelector('[data-agent-busy="false"]')`,
  );
  const transcriptVisible = await window.webContents.executeJavaScript(
    `document.body.textContent.includes('Desktop ready')`,
  );

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-file-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[aria-label="File content"]');
    editor.value = 'after\\n';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="save-file"]')?.click();
  })()`);
  await waitFor(window, `document.body.textContent.includes('6 bytes')`);

  const result = await window.webContents.executeJavaScript(`(() => ({
    state: document.querySelector('[data-workbench-state]')?.dataset.workbenchState,
    projects: Boolean(document.querySelector('[aria-label="Projects and sessions"]')),
    workbench: Boolean(document.querySelector('[aria-label="Agent workbench"]')),
    inspector: Boolean(document.querySelector('[aria-label="Context inspector"]')),
    session: Boolean(document.querySelector('[data-session-id]')),
    editor: document.querySelector('[aria-label="File content"]')?.value,
    protocol: location.protocol,
  }))()`);

  assert.deepEqual(result, {
    state: "ready",
    projects: true,
    workbench: true,
    inspector: true,
    session: true,
    editor: "after\n",
    protocol: "file:",
  });
  assert.equal(transcriptVisible, true);
  assert.equal(
    await readFile(path.join(fixtureRoot, "demo.txt"), "utf-8"),
    "after\n",
  );
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
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(sessionRoot, { recursive: true, force: true });
  app.quit();
}

function fail(error) {
  console.error(error);
  void rm(fixtureRoot, { recursive: true, force: true });
  void rm(sessionRoot, { recursive: true, force: true });
  app.exit(1);
}

console.log("Electron Xvfb interaction: starting");
void app.whenReady().then(run).catch(fail);
