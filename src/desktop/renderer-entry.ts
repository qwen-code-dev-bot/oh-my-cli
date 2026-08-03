import type {
  DesktopBridge,
  DesktopSaveUiStateRequest,
  DesktopUiState,
} from "./contracts.js";
import {
  createDesktopViewModel,
  createInitialDesktopState,
  reduceDesktopState,
  renderDesktopWorkbench,
  renderSessionRail,
  shouldAdoptCompletedSession,
  type DesktopAction,
  type DesktopPrimaryView,
} from "./renderer.js";

declare global {
  interface Window {
    ohMyCliDesktop: DesktopBridge;
  }
}

let state = createInitialDesktopState();
// Local mirror of the persisted workspace UI state. The service responds to
// every save with the merged truth, so the mirror never drifts on writes.
let uiState: DesktopUiState = { activeSessionId: null, sessions: {} };
let restoreScrollTop: number | null = null;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
let tabPersistTimer: ReturnType<typeof setTimeout> | null = null;
let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;

// Debounced tab persistence while typing so keystrokes never hammer IPC.
function queueTabPersist(): void {
  if (tabPersistTimer) clearTimeout(tabPersistTimer);
  tabPersistTimer = setTimeout(() => {
    tabPersistTimer = null;
    persistEditorTabs();
  }, 400);
}

function render(): void {
  const root = document.querySelector<HTMLElement>("#desktop-root");
  if (!root) return;
  root.innerHTML = renderDesktopWorkbench(createDesktopViewModel(state));
  // The rebuild wipes renderer-owned DOM state; put it back synchronously so
  // a navigation or a save never eats the unsent draft of the active session.
  const composer = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message"]',
  );
  const activeId = state.activeSession?.id;
  if (composer && activeId && composer.value === "") {
    composer.value = uiState.sessions[activeId]?.draft ?? "";
  }
  if (state.renaming) {
    const rename = document.querySelector<HTMLInputElement>(
      '[aria-label="Rename session"]',
    );
    rename?.focus();
    rename?.select();
  }
  // Restore the editor reading position of the visible tab.
  const editor = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="File content"]',
  );
  const editorTab = editor?.dataset.editorPath
    ? state.editorTabs.find((tab) => tab.path === editor.dataset.editorPath)
    : undefined;
  if (editor && editorTab && editorTab.scrollTop > 0) {
    editor.scrollTop = editorTab.scrollTop;
  }
  requestAnimationFrame(() => {
    const stage = document.querySelector<HTMLElement>(".stage");
    if (stage && restoreScrollTop !== null) {
      stage.scrollTop = restoreScrollTop;
      restoreScrollTop = null;
      return;
    }
    const conversation = document.querySelector<HTMLElement>(
      "[data-conversation]",
    );
    if (conversation)
      conversation.parentElement?.scrollTo({ top: conversation.scrollHeight });
  });
}

function dispatch(action: DesktopAction, shouldRender = true): void {
  state = reduceDesktopState(state, action);
  if (shouldRender) render();
}

function mergeMirrorEntry(
  sessionId: string,
  patch: Record<string, unknown>,
): void {
  uiState = {
    ...uiState,
    sessions: {
      ...uiState.sessions,
      [sessionId]: { ...(uiState.sessions[sessionId] ?? {}), ...patch },
    },
  };
}

function persistUi(request: DesktopSaveUiStateRequest): void {
  void window.ohMyCliDesktop
    .saveUiState(request)
    .then((next) => {
      uiState = next;
    })
    .catch(() => {
      // Persistence is best-effort; a failed save must never break the UI.
    });
}

function composerElement(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
}

function stageElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".stage");
}

// Snapshot the active session's draft and reading position into the mirror
// before the view switches away from it.
function captureActiveContext(): void {
  const id = state.activeSession?.id;
  if (!id) return;
  const patch: Record<string, unknown> = {};
  const composer = composerElement();
  if (composer) patch.draft = composer.value;
  const stage = stageElement();
  if (stage) patch.scrollTop = stage.scrollTop;
  if (Object.keys(patch).length > 0) mergeMirrorEntry(id, patch);
}

function queueDraftPersist(): void {
  const id = state.activeSession?.id;
  const composer = composerElement();
  if (!id || !composer) return;
  const draft = composer.value;
  mergeMirrorEntry(id, { draft });
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    persistUi({ sessions: { [id]: { draft } } });
  }, 300);
}

function queueScrollPersist(): void {
  if (scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    const id = state.activeSession?.id;
    const stage = stageElement();
    if (!id || !stage) return;
    persistUi({ sessions: { [id]: { scrollTop: stage.scrollTop } } });
  }, 400);
}

// The read watermark uses the summary's messageCount so tool messages count
// the same way in the rail badge and in the watermark.
function markActiveRead(): void {
  const id = state.activeSession?.id;
  if (!id) return;
  const summary = state.sessions.find((session) => session.id === id);
  if (!summary) return;
  mergeMirrorEntry(id, { lastSeenMessageCount: summary.messageCount });
  persistUi({ sessions: { [id]: { lastSeenMessageCount: summary.messageCount } } });
}

async function selectSession(sessionId: string): Promise<void> {
  captureActiveContext();
  historyIndex = -1;
  try {
    const session = await window.ohMyCliDesktop.loadSession(sessionId);
    const entry = uiState.sessions[sessionId] ?? {};
    restoreScrollTop =
      typeof entry.scrollTop === "number" ? entry.scrollTop : null;
    dispatch({ type: "select-session", session });
    const composer = composerElement();
    if (composer) composer.value = entry.draft ?? "";
    persistUi({ activeSessionId: sessionId });
    markActiveRead();
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to load session",
    });
  }
}

async function refreshSessions(): Promise<void> {
  const sessions = await window.ohMyCliDesktop.listSessions();
  dispatch({ type: "set-sessions", sessions });
}

async function createSession(): Promise<void> {
  try {
    const session = await window.ohMyCliDesktop.createSession();
    await refreshSessions();
    await selectSession(session.id);
    composerElement()?.focus();
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to create session",
    });
  }
}

async function commitRename(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Rename session"]',
  );
  const sessionId = input?.dataset.sessionId;
  if (!input || !sessionId) return;
  try {
    await window.ohMyCliDesktop.renameSession({
      sessionId,
      title: input.value,
    });
    dispatch({ type: "set-renaming", renaming: false });
    await refreshSessions();
    if (state.activeSession?.id === sessionId) {
      const session = await window.ohMyCliDesktop.loadSession(sessionId);
      dispatch({ type: "select-session", session });
    }
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to rename session",
    });
  }
}

async function setArchived(sessionId: string, archived: boolean): Promise<void> {
  try {
    await window.ohMyCliDesktop.setSessionArchived({ sessionId, archived });
    await refreshSessions();
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to update session",
    });
  }
}

async function deleteConfirmed(): Promise<void> {
  const sessionId = state.confirmDeleteId;
  dispatch({ type: "confirm-delete" });
  if (!sessionId) return;
  try {
    await window.ohMyCliDesktop.deleteSession(sessionId);
    if (state.activeSession?.id === sessionId) {
      dispatch({ type: "clear-session" });
    }
    await refreshSessions();
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to delete session",
    });
  }
}

async function cancelTurn(): Promise<void> {
  const sessionId = state.activeSession?.id;
  if (!sessionId || !state.busy) return;
  try {
    await window.ohMyCliDesktop.cancelTurn(sessionId);
    dispatch({ type: "set-cancelling", cancelling: true });
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to cancel turn",
    });
  }
}

// Retry reuses the session's single persisted user turn: the service re-runs
// the turn without appending another user message, so no duplicate lands in
// the transcript.
function retryTurn(): void {
  const sessionId = state.activeSession?.id;
  if (!sessionId || state.busy) return;
  dispatch({ type: "set-busy", busy: true });
  void window.ohMyCliDesktop
    .retryTurn(sessionId)
    .then(async () => {
      if (shouldAdoptCompletedSession(state, sessionId)) {
        const session = await window.ohMyCliDesktop.loadSession(sessionId);
        if (shouldAdoptCompletedSession(state, sessionId)) {
          dispatch({ type: "select-session", session, preserveNotice: true });
        }
      }
      dispatch({ type: "set-busy", busy: false });
      await refreshSessions();
      markActiveRead();
    })
    .catch((error: unknown) => {
      dispatch({ type: "set-busy", busy: false });
      dispatch({
        type: "set-error",
        message: error instanceof Error ? error.message : "Retry failed",
      });
      void refreshSessions();
    });
}

const MAX_STAGED_ATTACHMENTS = 8;

async function stageAttachments(paths: string[], viaFiles: boolean): Promise<void> {
  try {
    const reports = viaFiles
      ? await window.ohMyCliDesktop.attachImageFiles(paths)
      : await window.ohMyCliDesktop.attachImages(paths);
    const merged = [...state.attachments];
    for (const report of reports) {
      const index = merged.findIndex((item) => item.path === report.path);
      if (index >= 0) merged[index] = report;
      else if (merged.length < MAX_STAGED_ATTACHMENTS) merged.push(report);
    }
    dispatch({ type: "set-attachments", attachments: merged });
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to attach files",
    });
  }
}

function removeAttachment(path: string): void {
  dispatch({
    type: "set-attachments",
    attachments: state.attachments.filter((item) => item.path !== path),
  });
}

// Prompt history is derived from the persisted transcript of the active
// session, so nothing extra is stored and it survives reloads.
let historyIndex = -1;
let historyDraft = "";

function sessionPrompts(): string[] {
  return (state.activeSession?.messages ?? [])
    .filter(
      (message): message is { role: "user"; content: string } =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.length > 0,
    )
    .map((message) => message.content);
}

// --- Workspace file workflow (#490) -----------------------------------------

function openFileTab(filePath: string): void {
  void window.ohMyCliDesktop
    .readWorkspaceFile(filePath)
    .then((doc) => {
      dispatch({ type: "file-opened", doc });
      persistEditorTabs();
    })
    .catch((error: unknown) =>
      dispatch({
        type: "set-error",
        message:
          error instanceof Error ? error.message : "Unable to open file",
      }),
    );
}

function editorTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(
    '[aria-label="File content"]',
  );
}

function currentTabContent(path: string): string | undefined {
  const editor = editorTextarea();
  const tab = state.editorTabs.find((item) => item.path === path);
  // The DOM value is freshest while the editor is focused on this tab.
  if (editor && state.activeTabPath === path) return editor.value;
  return tab?.content;
}

async function saveFileTab(path: string): Promise<void> {
  const tab = state.editorTabs.find((item) => item.path === path);
  if (!tab) return;
  const content = currentTabContent(path) ?? tab.content;
  try {
    const doc = await window.ohMyCliDesktop.writeWorkspaceFile({
      path,
      content,
      expectedRevision: tab.baseline.revision,
    });
    dispatch({ type: "file-tab-saved", doc });
    persistEditorTabs();
    void refreshDiffIfOpen();
  } catch (error) {
    dispatch({
      type: "file-tab-error",
      path,
      message: error instanceof Error ? error.message : "Unable to save file",
    });
  }
}

async function saveAllTabs(): Promise<void> {
  const dirty = state.editorTabs.filter(
    (tab) => tab.content !== tab.baseline.content,
  );
  for (const tab of dirty) {
    await saveFileTab(tab.path);
  }
}

async function revertFileTab(path: string): Promise<void> {
  try {
    const doc = await window.ohMyCliDesktop.readWorkspaceFile(path);
    dispatch({ type: "file-tab-reloaded", doc });
    persistEditorTabs();
  } catch (error) {
    dispatch({
      type: "file-tab-error",
      path,
      message: error instanceof Error ? error.message : "Unable to reload file",
    });
  }
}

async function deleteFileConfirmed(): Promise<void> {
  const path = state.confirmFileDelete;
  dispatch({ type: "confirm-file-delete" });
  if (!path) return;
  try {
    await window.ohMyCliDesktop.deleteWorkspaceFile(path);
    dispatch({ type: "file-tab-gone", path });
    persistEditorTabs();
    void loadRootTree();
    void refreshDiffIfOpen();
  } catch (error) {
    dispatch({
      type: "set-error",
      message: error instanceof Error ? error.message : "Unable to delete file",
    });
  }
}

async function commitFileDialog(): Promise<void> {
  const dialog = state.fileDialog;
  const input = document.querySelector<HTMLInputElement>(
    dialog?.kind === "new"
      ? '[aria-label="New file path"]'
      : '[aria-label="Rename file path"]',
  );
  const value = input?.value.trim() ?? "";
  if (!dialog || !value) return;
  try {
    if (dialog.kind === "new") {
      const doc = await window.ohMyCliDesktop.createWorkspaceFile(value);
      dispatch({ type: "file-dialog" });
      dispatch({ type: "file-opened", doc });
      persistEditorTabs();
      void loadRootTree();
      void refreshDiffIfOpen();
    } else if (dialog.path) {
      const doc = await window.ohMyCliDesktop.renameWorkspaceFile({
        from: dialog.path,
        to: value,
      });
      dispatch({ type: "file-dialog" });
      dispatch({ type: "file-tab-renamed", from: dialog.path, doc });
      persistEditorTabs();
      void loadRootTree();
      void refreshDiffIfOpen();
    }
  } catch (error) {
    dispatch({
      type: "set-error",
      message: error instanceof Error ? error.message : "File operation failed",
    });
  }
}

async function openDiff(): Promise<void> {
  try {
    const diff = await window.ohMyCliDesktop.getWorkspaceDiff();
    dispatch({ type: "diff-opened", diff });
    const first = diff.files[0]?.path;
    if (first) await openFileDiff(first);
  } catch (error) {
    dispatch({
      type: "set-error",
      message: error instanceof Error ? error.message : "Unable to read the diff",
    });
  }
}

async function openFileDiff(path: string): Promise<void> {
  try {
    const fileDiff = await window.ohMyCliDesktop.getWorkspaceFileDiff(path);
    dispatch({ type: "diff-file-selected", path, fileDiff });
  } catch (error) {
    dispatch({
      type: "set-error",
      message:
        error instanceof Error ? error.message : "Unable to read the file diff",
    });
  }
}

function refreshDiffIfOpen(): void {
  if (!state.diffOpen) return;
  void window.ohMyCliDesktop
    .getWorkspaceDiff()
    .then((diff) => dispatch({ type: "diff-opened", diff }))
    .catch(() => {});
}

async function loadRootTree(): Promise<void> {
  try {
    const result = await window.ohMyCliDesktop.listWorkspaceDirectory(".");
    dispatch({ type: "tree-dir-loaded", base: ".", entries: result.entries });
  } catch {
    dispatch({ type: "tree-dir-loaded", base: ".", entries: [] });
  }
}

async function toggleTreeDir(base: string): Promise<void> {
  const loaded = state.treeDirs[base] !== undefined;
  const expanded = state.expandedDirs.includes(base);
  dispatch({ type: "tree-dir-toggle", base });
  if (!loaded && !expanded) {
    try {
      const result = await window.ohMyCliDesktop.listWorkspaceDirectory(base);
      dispatch({
        type: "tree-dir-loaded",
        base: result.base || base,
        entries: result.entries,
      });
    } catch (error) {
      dispatch({
        type: "set-error",
        message:
          error instanceof Error ? error.message : "Unable to list directory",
      });
    }
  }
}

// Persist the open tabs (bounded) so a reload restores the coding context.
function persistEditorTabs(): void {
  const tabs = state.editorTabs.map((tab) => ({
    path: tab.path,
    scrollTop: tab.scrollTop,
    ...(tab.content !== tab.baseline.content
      ? { dirty: true, draft: tab.content.slice(0, 100_000) }
      : {}),
  }));
  void window.ohMyCliDesktop
    .saveUiState({ editorTabs: tabs, activeEditorTab: state.activeTabPath ?? null })
    .catch(() => {
      // Tab persistence is best-effort; a failed save never breaks editing.
    });
}

async function restoreEditorTabs(): Promise<void> {
  let ui;
  try {
    ui = await window.ohMyCliDesktop.getUiState();
  } catch {
    return;
  }
  const tabs = ui.editorTabs ?? [];
  for (const tab of tabs) {
    try {
      const doc = await window.ohMyCliDesktop.readWorkspaceFile(tab.path);
      dispatch({ type: "file-opened", doc });
      if (tab.dirty && typeof tab.draft === "string") {
        dispatch({ type: "file-tab-content", path: tab.path, content: tab.draft });
      }
      if (typeof tab.scrollTop === "number") {
        dispatch({
          type: "file-tab-scroll",
          path: tab.path,
          scrollTop: tab.scrollTop,
        });
      }
    } catch {
      // The file may have disappeared since; skip it honestly.
    }
  }
  if (ui.activeEditorTab) {
    dispatch({ type: "file-tab-select", path: ui.activeEditorTab });
  }
}

async function bootstrap(): Promise<void> {
  dispatch({ type: "bootstrap-started" });
  try {
    const [payload, sessions, files, ui] = await Promise.all([
      window.ohMyCliDesktop.getBootstrapState(),
      window.ohMyCliDesktop.listSessions(),
      window.ohMyCliDesktop.listWorkspaceFiles(),
      window.ohMyCliDesktop.getUiState(),
    ]);
    uiState = ui;
    dispatch({ type: "bootstrap-resolved", payload, sessions, files });
    window.ohMyCliDesktop
      .getRuntimeInfo()
      .then((runtime) => dispatch({ type: "set-runtime", runtime }))
      .catch(() => dispatch({ type: "set-runtime", runtime: null }));
    void loadRootTree();
    if (ui.activeSessionId) {
      await selectSession(ui.activeSessionId);
    }
    await restoreEditorTabs();
  } catch (error) {
    dispatch({
      type: "bootstrap-rejected",
      message:
        error instanceof Error ? error.message : "Desktop bridge unavailable",
    });
  }
}

window.ohMyCliDesktop.onAgentEvent((event) => {
  dispatch({ type: "agent-event", event });
  // Late events for other sessions never touch the active transcript (the
  // reducer drops them), but a background completion still changes rail
  // truth (unread, failed, title), so refresh the summaries.
  if (event.type === "complete") {
    void refreshSessions().then(() => {
      if (state.activeSession?.id === event.sessionId) markActiveRead();
    });
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const view = target.closest<HTMLElement>("[data-view]")?.dataset.view;
  if (view === "chat" || view === "workflow" || view === "changes") {
    dispatch({ type: "select-view", view: view as DesktopPrimaryView });
    return;
  }
  const sessionId =
    target.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  if (sessionId && !state.renaming) {
    void selectSession(sessionId);
    return;
  }
  const filePath =
    target.closest<HTMLElement>("[data-file-path]")?.dataset.filePath;
  if (filePath) {
    openFileTab(filePath);
    return;
  }
  const tabPath =
    target.closest<HTMLElement>("[data-tab-path]")?.dataset.tabPath;
  if (tabPath) {
    dispatch({ type: "file-tab-select", path: tabPath });
    persistEditorTabs();
    return;
  }
  const tabClose =
    target.closest<HTMLElement>("[data-tab-close]")?.dataset.tabClose;
  if (tabClose) {
    dispatch({ type: "file-tab-close", path: tabClose });
    persistEditorTabs();
    return;
  }
  const treeDir =
    target.closest<HTMLElement>("[data-tree-dir]")?.dataset.treeDir;
  if (treeDir) {
    void toggleTreeDir(treeDir);
    return;
  }
  const diffFilePath =
    target.closest<HTMLElement>("[data-diff-file-path]")?.dataset
      .diffFilePath;
  if (diffFilePath) {
    void openFileDiff(diffFilePath);
    return;
  }
  const attachFilePath =
    target.closest<HTMLElement>("[data-attach-file-path]")?.dataset
      .attachFilePath;
  if (attachFilePath) {
    dispatch({ type: "attach-picker", open: false });
    void stageAttachments([attachFilePath], false);
    return;
  }
  if (target.closest<HTMLElement>('[data-action="remove-attachment"]')) {
    const path =
      target.closest<HTMLElement>("[data-attachment-path]")?.dataset
        .attachmentPath;
    if (path) removeAttachment(path);
    return;
  }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "new-session") {
    void createSession();
  } else if (action === "rename-session" && state.activeSession) {
    dispatch({ type: "set-renaming", renaming: true });
  } else if (action === "archive-session" && state.activeSession) {
    void setArchived(state.activeSession.id, true);
  } else if (action === "restore-session" && state.activeSession) {
    void setArchived(state.activeSession.id, false);
  } else if (action === "request-delete-session" && state.activeSession) {
    dispatch({ type: "confirm-delete", sessionId: state.activeSession.id });
  } else if (action === "confirm-delete-session") {
    void deleteConfirmed();
  } else if (action === "cancel-delete") {
    dispatch({ type: "confirm-delete" });
  } else if (action === "toggle-archived") {
    dispatch({ type: "set-show-archived", show: !state.showArchived });
  } else if (action === "open-attach-picker" && state.activeSession) {
    dispatch({ type: "attach-picker", open: true });
  } else if (action === "close-attach-picker") {
    dispatch({ type: "attach-picker", open: false });
  } else if (action === "cancel-turn") {
    void cancelTurn();
  } else if (action === "retry-turn") {
    retryTurn();
  } else if (action === "save-file" && state.activeTabPath) {
    void saveFileTab(state.activeTabPath);
  } else if (action === "file-save-all") {
    void saveAllTabs();
  } else if (action === "file-revert" && state.activeTabPath) {
    void revertFileTab(state.activeTabPath);
  } else if (action === "file-reload" && state.activeTabPath) {
    void revertFileTab(state.activeTabPath);
  } else if (action === "file-new") {
    dispatch({
      type: "file-dialog",
      dialog: { kind: "new", value: "" },
    });
  } else if (action === "file-rename" && state.activeTabPath) {
    dispatch({
      type: "file-dialog",
      dialog: { kind: "rename", path: state.activeTabPath, value: state.activeTabPath },
    });
  } else if (action === "file-delete" && state.activeTabPath) {
    dispatch({ type: "confirm-file-delete", path: state.activeTabPath });
  } else if (action === "file-delete-cancel") {
    dispatch({ type: "confirm-file-delete" });
  } else if (action === "file-delete-confirm") {
    void deleteFileConfirmed();
  } else if (action === "file-dialog-cancel") {
    dispatch({ type: "file-dialog" });
  } else if (action === "file-dialog-commit") {
    void commitFileDialog();
  } else if (action === "open-diff") {
    void openDiff();
  } else if (action === "close-diff") {
    dispatch({ type: "diff-closed" });
  } else if (action === "refresh-diff") {
    void openDiff();
  } else if (action === "open-diagnostics") {
    dispatch({ type: "set-diagnostics", open: true });
  } else if (action === "close-diagnostics") {
    dispatch({ type: "set-diagnostics", open: false });
  } else if (action === "retry-bootstrap") {
    void bootstrap();
  } else if (action === "dismiss-error") {
    dispatch({ type: "set-error" });
  } else if (
    target instanceof HTMLElement &&
    target.dataset.dialogBackdrop === "true"
  ) {
    dispatch({ type: "set-diagnostics", open: false });
    dispatch({ type: "confirm-delete" });
    dispatch({ type: "attach-picker", open: false });
    dispatch({ type: "diff-closed" });
    dispatch({ type: "file-dialog" });
    dispatch({ type: "confirm-file-delete" });
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLTextAreaElement &&
    target.getAttribute("aria-label") === "File content"
  ) {
    const path = target.dataset.editorPath ?? state.activeTabPath;
    if (path) {
      dispatch(
        { type: "file-tab-content", path, content: target.value },
        false,
      );
      // No re-render while typing: sync the toolbar's enabled state directly
      // from the just-updated tab truth.
      const tab = state.editorTabs.find((item) => item.path === path);
      const dirty = tab ? tab.content !== tab.baseline.content : false;
      const saveButton =
        document.querySelector<HTMLButtonElement>('[data-action="save-file"]');
      if (saveButton) saveButton.disabled = !dirty;
      const revertButton = document.querySelector<HTMLButtonElement>(
        '[data-action="file-revert"]',
      );
      if (revertButton) revertButton.disabled = !dirty;
      queueTabPersist();
    }
    return;
  }
  if (
    target instanceof HTMLTextAreaElement &&
    target.getAttribute("aria-label") === "Message"
  ) {
    // Bounded draft: oversized pastes are truncated deterministically instead
    // of being silently lost at send time.
    if (target.value.length > 10_000) {
      target.value = target.value.slice(0, 10_000);
      dispatch({
        type: "set-error",
        message: "Draft truncated to 10,000 characters",
      });
    }
    historyIndex = -1;
    queueDraftPersist();
    return;
  }
  if (
    target instanceof HTMLInputElement &&
    target.getAttribute("aria-label") === "Search sessions"
  ) {
    // Patch only the rail so typing never rebuilds the composer or steals
    // focus from the search field.
    dispatch({ type: "set-session-search", value: target.value }, false);
    const list = document.querySelector<HTMLElement>(".session-list");
    if (list) list.innerHTML = renderSessionRail(createDesktopViewModel(state));
    return;
  }
  if (
    target instanceof HTMLInputElement &&
    target.getAttribute("aria-label") === "Search workspace files"
  ) {
    const query = target.value;
    dispatch({ type: "file-search", query, results: null }, false);
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
    fileSearchTimer = setTimeout(() => {
      fileSearchTimer = null;
      if (!query.trim()) {
        dispatch({ type: "file-search", query: "", results: null });
        return;
      }
      void window.ohMyCliDesktop
        .searchWorkspaceFiles(query)
        .then((results) =>
          dispatch({ type: "file-search", query, results }),
        )
        .catch(() =>
          dispatch({ type: "file-search", query, results: [] }),
        );
    }, 250);
  }
});

document.addEventListener("scroll", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains("code-editor")) {
    // Track the reading position of the focused editor tab.
    const path =
      (target as HTMLElement).dataset.editorPath ?? state.activeTabPath;
    if (path) {
      dispatch(
        {
          type: "file-tab-scroll",
          path,
          scrollTop: (target as HTMLElement).scrollTop,
        },
        false,
      );
    }
    return;
  }
  if (!target.classList.contains("stage")) return;
  queueScrollPersist();
}, true);

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (
    !(form instanceof HTMLFormElement) ||
    form.getAttribute("aria-label") !== "Message composer"
  )
    return;
  event.preventDefault();
  const input = form.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message"]',
  );
  const prompt = input?.value.trim() ?? "";
  const sessionId = state.activeSession?.id;
  if (!prompt || !sessionId || state.busy) return;
  // A staged attachment that failed validation blocks the turn: the composer
  // shows the reason and the user removes it explicitly.
  const invalid = state.attachments.find((item) => !item.ok);
  if (invalid) {
    dispatch({
      type: "set-error",
      message: "Remove rejected attachments before sending",
    });
    return;
  }
  const attachments = state.attachments
    .filter((item) => item.ok)
    .map((item) => item.path);
  if (input) input.value = "";
  // Cancel any pending draft debounce so the just-sent text cannot be written
  // back as a phantom draft after the composer is cleared.
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  mergeMirrorEntry(sessionId, { draft: "" });
  persistUi({ sessions: { [sessionId]: { draft: "" } } });
  dispatch({ type: "set-attachments", attachments: [] });
  historyIndex = -1;
  dispatch({ type: "optimistic-user", content: prompt });
  dispatch({ type: "set-busy", busy: true });
  void window.ohMyCliDesktop
    .sendMessage({
      sessionId,
      prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    .then(async () => {
      dispatch({ type: "set-busy", busy: false });
      // A finishing turn only reloads its own session when the user is still
      // there; otherwise the completion is background truth (summary refresh,
      // unread badge) and must never steal focus from the session the user
      // moved to while the turn was running.
      if (shouldAdoptCompletedSession(state, sessionId)) {
        const session = await window.ohMyCliDesktop.loadSession(sessionId);
        if (shouldAdoptCompletedSession(state, sessionId)) {
          dispatch({ type: "select-session", session, preserveNotice: true });
        }
      }
      await refreshSessions();
      markActiveRead();
    })
    .catch((error: unknown) => {
      dispatch({ type: "set-busy", busy: false });
      dispatch({
        type: "set-error",
        message: error instanceof Error ? error.message : "Agent turn failed",
      });
      void refreshSessions();
    });
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLInputElement &&
    (target.getAttribute("aria-label") === "New file path" ||
      target.getAttribute("aria-label") === "Rename file path")
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitFileDialog();
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "file-dialog" });
    }
    return;
  }
  if (
    target instanceof HTMLInputElement &&
    target.getAttribute("aria-label") === "Rename session"
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "set-renaming", renaming: false });
    }
    return;
  }
  if (
    target instanceof HTMLTextAreaElement &&
    target.getAttribute("aria-label") === "Message"
  ) {
    // Never intercept an IME composition: Enter confirms the composition, it
    // does not send the message.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      target.closest("form")?.requestSubmit();
      return;
    }
    // Prompt history (derived from the persisted transcript): ArrowUp recalls
    // older prompts, ArrowDown returns toward the draft.
    const prompts = sessionPrompts();
    if (event.key === "ArrowUp" && prompts.length > 0) {
      const caretAtStart =
        target.selectionStart === 0 && target.selectionEnd === 0;
      if (historyIndex === -1 && (target.value === "" || caretAtStart)) {
        historyDraft = target.value;
        historyIndex = prompts.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      } else {
        return;
      }
      event.preventDefault();
      target.value = prompts[historyIndex];
      queueDraftPersist();
      return;
    }
    if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      historyIndex++;
      if (historyIndex >= prompts.length) {
        historyIndex = -1;
        target.value = historyDraft;
      } else {
        target.value = prompts[historyIndex];
      }
      queueDraftPersist();
      return;
    }
  }
  if (
    target instanceof HTMLElement &&
    target.classList.contains("session-item") &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    const items = [
      ...document.querySelectorAll<HTMLElement>(".session-item"),
    ];
    const index = items.indexOf(target);
    const next =
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    return;
  }
  if (
    target instanceof HTMLElement &&
    target.getAttribute("role") === "tab" &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    const views: DesktopPrimaryView[] = ["chat", "workflow", "changes"];
    const current = views.indexOf(state.activeView);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const view = views[(current + direction + views.length) % views.length];
    dispatch({ type: "select-view", view });
    document.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    composerElement()?.focus();
  } else if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "n"
  ) {
    event.preventDefault();
    void createSession();
  } else if (event.key === "Escape") {
    if (state.fileDialog) {
      dispatch({ type: "file-dialog" });
    } else if (state.confirmFileDelete) {
      dispatch({ type: "confirm-file-delete" });
    } else if (state.diffOpen) {
      dispatch({ type: "diff-closed" });
    } else if (state.attachPickerOpen) {
      dispatch({ type: "attach-picker", open: false });
    } else if (state.confirmDeleteId) {
      dispatch({ type: "confirm-delete" });
    } else if (state.diagnosticsOpen) {
      dispatch({ type: "set-diagnostics", open: false });
    }
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLSelectElement &&
    target.getAttribute("aria-label") === "Model profile"
  ) {
    const profile = target.value === "" ? null : target.value;
    window.ohMyCliDesktop
      .setSelectedProfile(profile)
      .then((runtime) => dispatch({ type: "set-runtime", runtime }))
      .catch((error: unknown) =>
        dispatch({
          type: "set-error",
          message:
            error instanceof Error ? error.message : "Unable to change profile",
        }),
      );
  }
});

// Drag-and-drop attachments resolve through the preload (File -> path) and are
// confined + validated by the main process; only the composer accepts drops.
document.addEventListener("dragover", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".composer-wrap")) {
    event.preventDefault();
  }
});

document.addEventListener("drop", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".composer-wrap")) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0 || state.busy || !state.activeSession) return;
  let paths: string[];
  try {
    paths = files.map((file) => window.ohMyCliDesktop.getPathForFile(file));
  } catch {
    dispatch({
      type: "set-error",
      message: "Dropped files could not be resolved",
    });
    return;
  }
  void stageAttachments(paths, true);
});

window.addEventListener("beforeunload", () => {
  captureActiveContext();
  persistEditorTabs();
  const id = state.activeSession?.id;
  if (!id) return;
  const entry = uiState.sessions[id] ?? {};
  void window.ohMyCliDesktop.saveUiState({
    activeSessionId: id,
    sessions: { [id]: entry },
  });
});

render();
void bootstrap();
