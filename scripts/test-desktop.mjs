import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, ipcMain } from "electron";
import { DESKTOP_CHANNELS } from "../dist/desktop/contracts.js";
import { DesktopService } from "../dist/desktop/service.js";
import { SessionStore } from "../dist/session.js";
import { createDesktopWindow } from "../dist/desktop/window.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  uiStatePath: path.join(sessionRoot, "desktop-ui.json"),
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
ipcMain.handle(DESKTOP_CHANNELS.renameSession, (_event, request) =>
  service.renameSession(request),
);
ipcMain.handle(DESKTOP_CHANNELS.setSessionArchived, (_event, request) =>
  service.setSessionArchived(request),
);
ipcMain.handle(DESKTOP_CHANNELS.deleteSession, (_event, id) =>
  service.deleteSession(id),
);
ipcMain.handle(DESKTOP_CHANNELS.sendMessage, (event, request) =>
  service.sendMessage(request, (payload) =>
    event.sender.send(DESKTOP_CHANNELS.agentEvent, payload),
  ),
);
ipcMain.handle(DESKTOP_CHANNELS.getUiState, () => service.getUiState());
ipcMain.handle(DESKTOP_CHANNELS.saveUiState, (_event, request) =>
  service.saveUiState(request),
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

  // --- Session lifecycle (#488) ---
  // The first completed turn earns a stable auto-title.
  await waitFor(
    window,
    `[...document.querySelectorAll('[data-session-id]')].some((el) => el.textContent.includes('Prove the Desktop chat works'))`,
  );

  // A second session starts in the editable draft state.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="new-session"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelectorAll('[data-session-id]').length === 2 && document.querySelector('[data-status="draft"]')`,
  );
  const draftId = await window.webContents.executeJavaScript(
    `document.querySelector('[data-status="draft"]')?.dataset.sessionId`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'remember me';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600); // let the debounced draft persistence reach disk

  // Switching away and back preserves the per-session draft.
  const firstId = await window.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-session-id]')].find((el) => el.dataset.sessionId !== '${draftId}')?.dataset.sessionId`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${firstId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('.workspace-bar')?.textContent.includes('Prove the Desktop chat works') && document.querySelector('[aria-label="Message"]')?.value === ''`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${draftId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="Message"]')?.value === 'remember me'`,
  );

  // Rename the draft session from the workspace bar.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="rename-session"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="Rename session"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Rename session"]');
    input.value = 'Renamed draft';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(
    window,
    `[...document.querySelectorAll('[data-session-id]')].some((el) => el.textContent.includes('Renamed draft'))`,
  );

  // Search filters the rail live.
  await window.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('[aria-label="Search sessions"]');
    search.value = 'Renamed';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    window,
    `!document.querySelector('[data-session-id="${firstId}"]') && document.querySelector('[data-session-id="${draftId}"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('[aria-label="Search sessions"]');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-session-id="${firstId}"]')`,
  );

  // Archive hides the session; the archived view restores it.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="archive-session"]')?.click()`,
  );
  await waitFor(
    window,
    `!document.querySelector('[data-session-id="${draftId}"]') && document.querySelector('[data-action="toggle-archived"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="toggle-archived"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-session-id="${draftId}"][data-archived="true"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${draftId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-action="restore-session"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="restore-session"]')?.click()`,
  );
  await waitFor(
    window,
    `!document.querySelector('[data-session-id="${draftId}"][data-archived="true"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="toggle-archived"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-session-id="${draftId}"]') && !document.querySelector('[data-session-id="${draftId}"][data-archived="true"]')`,
  );

  // Confirmed deletion removes the session from the rail and from disk.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="new-session"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelectorAll('[data-session-id]').length === 3`,
  );
  const victimId = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-current="true"]')?.dataset.sessionId`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="request-delete-session"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-action="confirm-delete-session"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="confirm-delete-session"]')?.click()`,
  );
  await waitFor(
    window,
    `!document.querySelector('[data-session-id="${victimId}"]') && document.querySelectorAll('[data-session-id]').length === 2`,
  );
  assert.equal(
    existsSync(path.join(sessionRoot, `${victimId}.jsonl`)),
    false,
    "deleted session must be removed from the session store",
  );

  // Reload restores sessions, the active selection, and the saved draft.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${draftId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="Message"]')?.value === 'remember me'`,
  );
  window.webContents.reload();
  await new Promise((resolve) =>
    window.webContents.once("did-finish-load", resolve),
  );
  await waitFor(
    window,
    `document.querySelector('[data-workbench-state="ready"]') && document.querySelector('[data-session-id="${draftId}"][aria-current="true"]')`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="Message"]')?.value === 'remember me' && document.querySelector('.workspace-bar')?.textContent.includes('Renamed draft')`,
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
  await waitFor(window, `document.body.textContent.includes('Saved demo.txt')`);

  const result = await window.webContents.executeJavaScript(`(() => ({
    state: document.querySelector('[data-workbench-state]')?.dataset.workbenchState,
    projects: Boolean(document.querySelector('[aria-label="Projects and sessions"]')),
    workbench: Boolean(document.querySelector('[aria-label="Agent workbench"]')),
    inspector: Boolean(document.querySelector('[aria-label="Context inspector"]')),
    session: Boolean(document.querySelector('[data-session-id]')),
    sessionCount: document.querySelectorAll('[data-session-id]').length,
    activeTitle: document.querySelector('.workspace-bar strong')?.textContent,
    composerDraft: document.querySelector('[aria-label="Message"]')?.value,
    search: Boolean(document.querySelector('[aria-label="Search sessions"]')),
    editor: document.querySelector('[aria-label="File content"]')?.value,
    protocol: location.protocol,
  }))()`);

  assert.deepEqual(result, {
    state: "ready",
    projects: true,
    workbench: true,
    inspector: true,
    session: true,
    sessionCount: 2,
    activeTitle: "Renamed draft",
    composerDraft: "remember me",
    search: true,
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
