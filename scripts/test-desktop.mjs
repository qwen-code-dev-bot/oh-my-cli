import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
await writeFile(path.join(fixtureRoot, "notes.txt"), "not an image\n", "utf-8");
// A real 1x1 PNG so attachment validation runs against honest magic bytes.
await writeFile(
  path.join(fixtureRoot, "demo.png"),
  Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  ),
);
// A subdirectory so the lazy tree exercises expansion.
await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
await writeFile(path.join(fixtureRoot, "src", "leaf.ts"), "export {};\n", "utf-8");
const settingsPath = path.join(fixtureRoot, "e2e-settings.json");
await writeFile(
  settingsPath,
  JSON.stringify({
    model: {
      name: "qwen3.8-max",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "OMC_E2E_API_KEY",
    },
  }),
  "utf-8",
);
process.env.OMC_E2E_API_KEY = "e2e-key";

// Make the fixture a Git repository with demo.txt committed, so the diff
// phase reviews a real working-tree patch.
execFileSync("git", ["init", "-q", "-b", "main", fixtureRoot], {
  stdio: ["ignore", "pipe", "ignore"],
});
execFileSync(
  "git",
  ["-C", fixtureRoot, "config", "user.email", "e2e@example.test"],
  { stdio: ["ignore", "pipe", "ignore"] },
);
execFileSync("git", ["-C", fixtureRoot, "config", "user.name", "E2E"], {
  stdio: ["ignore", "pipe", "ignore"],
});
execFileSync("git", ["-C", fixtureRoot, "add", "demo.txt"], {
  stdio: ["ignore", "pipe", "ignore"],
});
execFileSync("git", ["-C", fixtureRoot, "commit", "-q", "-m", "base"], {
  stdio: ["ignore", "pipe", "ignore"],
});

let retryCalls = 0;

const service = new DesktopService({
  workspaceRoot: fixtureRoot,
  store: new SessionStore(sessionRoot),
  uiStatePath: path.join(sessionRoot, "desktop-ui.json"),
  settingsPath,
  resolveConfig: () => ({
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "qwen3.8-max",
  }),
  run: async (prompt, _messages, options) => {
    const appendUser = () => {
      if (options.appendUserMessage !== false)
        options.onMessage({ role: "user", content: prompt });
    };
    if (prompt === "Slow background turn") {
      appendUser();
      options.sink?.assistantDelta("Background ");
      await sleep(800);
      options.sink?.assistantDelta("done");
      options.onMessage({ role: "assistant", content: "Background done" });
      return {
        text: "Background done",
        ok: true,
        reason: "completed",
        rounds: 1,
        retries: 0,
        stats: { toolCalls: {}, toolFailures: {} },
        tokens: null,
        estimatedCostUsd: null,
        costKnown: false,
      };
    }
    if (prompt === "Slow cancel turn") {
      appendUser();
      options.sink?.assistantDelta("Partial answer");
      for (let i = 0; i < 60; i++) {
        await sleep(50);
        if (options.cancelRequested?.()) {
          options.onMessage({
            role: "assistant",
            content: "Partial answer",
            interrupted: true,
          });
          return {
            text: "Partial answer",
            ok: false,
            reason: "cancelled",
            rounds: 0,
            retries: 0,
            stats: { toolCalls: {}, toolFailures: {} },
            tokens: null,
            estimatedCostUsd: null,
            costKnown: false,
          };
        }
      }
      options.onMessage({ role: "assistant", content: "Partial answer" });
      return {
        text: "Partial answer",
        ok: true,
        reason: "completed",
        rounds: 1,
        retries: 0,
        stats: { toolCalls: {}, toolFailures: {} },
        tokens: null,
        estimatedCostUsd: null,
        costKnown: false,
      };
    }
    if (prompt === "Retry me") {
      retryCalls++;
      appendUser();
      if (retryCalls === 1) {
        return {
          text: "",
          ok: false,
          reason: "provider_error",
          rounds: 0,
          retries: 0,
          stats: { toolCalls: {}, toolFailures: {} },
          tokens: null,
          estimatedCostUsd: null,
          costKnown: false,
        };
      }
      options.sink?.assistantDelta("Recovered answer");
      options.onMessage({ role: "assistant", content: "Recovered answer" });
      return {
        text: "Recovered answer",
        ok: true,
        reason: "completed",
        rounds: 1,
        retries: 0,
        stats: { toolCalls: {}, toolFailures: {} },
        tokens: null,
        estimatedCostUsd: null,
        costKnown: false,
      };
    }
    appendUser();
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
ipcMain.handle(DESKTOP_CHANNELS.cancelTurn, (_event, id) =>
  service.cancelTurn(id),
);
ipcMain.handle(DESKTOP_CHANNELS.retryTurn, (event, id) =>
  service.retryTurn(id, (payload) =>
    event.sender.send(DESKTOP_CHANNELS.agentEvent, payload),
  ),
);
ipcMain.handle(DESKTOP_CHANNELS.attachImages, (_event, paths) =>
  service.attachImages(paths),
);
ipcMain.handle(DESKTOP_CHANNELS.attachImageFiles, (_event, paths) =>
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

  // --- Composer controls (#489) — all exercised on the first session ---
  // The effective model and approval mode are visible in the composer.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${firstId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('.workspace-bar')?.textContent.includes('Prove the Desktop chat works')`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-runtime-chip="ready"]')?.textContent.includes('qwen3.8-max') && document.body.textContent.includes('auto-edit')`,
  );

  // Attachment picker lists workspace images; staging shows name/type/size,
  // removal works, and a send consumes the staged attachment.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="open-attach-picker"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-attach-file-path="demo.png"]') && !document.querySelector('[data-attach-file-path="notes.txt"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-attach-file-path="demo.png"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-attachment-path="demo.png"]')?.textContent.includes('demo.png · image/png')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="remove-attachment"]')?.click()`,
  );
  await waitFor(
    window,
    `!document.querySelector('[data-attachment-path="demo.png"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="open-attach-picker"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-attach-file-path="demo.png"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-attach-file-path="demo.png"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-attachment-path="demo.png"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Attach turn';
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="false"]') && !document.querySelector('[data-attachment-path="demo.png"]')`,
  );

  // Cancel preserves the partial transcript as an interrupted turn.
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Slow cancel turn';
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="true"]') && document.querySelector('[data-action="cancel-turn"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="cancel-turn"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="false"]') && document.body.textContent.includes('Turn cancelled') && document.body.textContent.includes('Partial answer') && document.body.textContent.includes('Interrupted')`,
  );

  // Retry reuses one request identity: the user turn is never duplicated.
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Retry me';
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="false"]') && document.querySelector('[data-action="retry-turn"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="retry-turn"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="false"]') && document.body.textContent.includes('Recovered answer') && !document.querySelector('[data-action="retry-turn"]')`,
  );
  const retryUsers = service
    .loadSession(firstId)
    .messages.filter((m) => m.role === "user" && m.content === "Retry me");
  assert.equal(
    retryUsers.length,
    1,
    "retry must reuse the single persisted user turn",
  );

  // Switching away during an in-flight turn keeps focus on the chosen
  // session: completion becomes background truth, never a forced pull-back.
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Slow background turn';
    input.closest('form').requestSubmit();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="true"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-session-id="${draftId}"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-agent-busy="false"]') && document.querySelector('[data-session-id="${draftId}"][aria-current="true"]')`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-session-id="${firstId}"][data-status="unread"]')`,
  );
  const inFlight = await window.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.workspace-bar strong')?.textContent,
    composer: document.querySelector('[aria-label="Message"]')?.value,
    leaked: document.body.textContent.includes('Background done'),
  }))()`);
  assert.deepEqual(inFlight, {
    title: "Renamed draft",
    composer: "remember me",
    leaked: false,
  });

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

  // --- Coding workflow (#490) ---
  // Lazy tree: files listed at bootstrap, directories expand on demand.
  await waitFor(
    window,
    `document.querySelector('[data-file-path="demo.txt"]') && document.querySelector('[data-tree-dir="src"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-tree-dir="src"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-file-path="src/leaf.ts"]')`,
  );

  // Multiple tabs: drafts survive switching between them.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-file-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'before\\n'`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-file-path="notes.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-tab-path="notes.txt"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[aria-label="File content"]');
    editor.value = 'unsaved notes';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-tab-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'before\\n'`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-tab-path="notes.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'unsaved notes'`,
  );

  // External-change conflict: the save fails closed, reload recovers.
  await writeFile(path.join(fixtureRoot, "demo.txt"), "external\n", "utf-8");
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-tab-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'before\\n'`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[aria-label="File content"]');
    editor.value = 'stale write\\n';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="save-file"]')?.click();
  })()`);
  await waitFor(
    window,
    `document.body.textContent.includes('File changed outside Desktop')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-reload"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'external\\n'`,
  );

  // Path policy: escapes are rejected before anything touches the disk.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-new"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="New file path"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="New file path"]');
    input.value = '../evil.md';
    document.querySelector('[data-action="file-dialog-commit"]')?.click();
  })()`);
  await waitFor(window, `document.body.textContent.includes('escape')`);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-dialog-cancel"]')?.click()`,
  );

  // Create, rename, and delete with explicit valid targets.
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-action="file-new"]')?.click();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[aria-label="New file path"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="New file path"]');
    input.value = 'scratch.md';
    document.querySelector('[data-action="file-dialog-commit"]')?.click();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-tab-path="scratch.md"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-rename"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="Rename file path"]')`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="Rename file path"]');
    input.value = 'scratch2.md';
    document.querySelector('[data-action="file-dialog-commit"]')?.click();
  })()`);
  await waitFor(
    window,
    `document.querySelector('[data-tab-path="scratch2.md"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-delete"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-action="file-delete-confirm"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="file-delete-confirm"]')?.click()`,
  );
  await waitFor(
    window,
    `!document.querySelector('[data-tab-path="scratch2.md"]')`,
  );
  assert.equal(
    existsSync(path.join(fixtureRoot, "scratch.md")),
    false,
    "rename must remove the old path",
  );
  assert.equal(
    existsSync(path.join(fixtureRoot, "scratch2.md")),
    false,
    "confirmed delete must remove the file",
  );

  // Save the final content, then review the real working-tree patch.
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-tab-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'external\\n'`,
  );
  await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[aria-label="File content"]');
    editor.value = 'after\\n';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="save-file"]')?.click();
  })()`);
  await waitFor(window, `document.body.textContent.includes('Saved demo.txt')`);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="open-diff"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-diff-file-path="demo.txt"]') && document.querySelector('[data-diff-file-path="notes.txt"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-diff-file-path="demo.txt"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('.diff-patch')?.textContent.includes('-before') && document.querySelector('.diff-patch')?.textContent.includes('+after')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="refresh-diff"]')?.click()`,
  );
  await waitFor(
    window,
    `document.querySelector('[data-diff-file-path="demo.txt"]')`,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-action="close-diff"]')?.click()`,
  );

  // Reload restores the coding context: tabs reopen from disk.
  window.webContents.reload();
  await new Promise((resolve) =>
    window.webContents.once("did-finish-load", resolve),
  );
  await waitFor(
    window,
    `document.querySelector('[data-workbench-state="ready"]') && document.querySelector('[data-tab-path="demo.txt"]')`,
  );
  await waitFor(
    window,
    `document.querySelector('[aria-label="File content"]')?.value === 'after\\n'`,
  );

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
