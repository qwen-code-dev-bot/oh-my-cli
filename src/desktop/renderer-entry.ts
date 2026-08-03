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
    if (ui.activeSessionId) {
      await selectSession(ui.activeSessionId);
    }
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
    void window.ohMyCliDesktop
      .readWorkspaceFile(filePath)
      .then((file) => dispatch({ type: "select-file", file }))
      .catch((error: unknown) =>
        dispatch({
          type: "set-error",
          message:
            error instanceof Error ? error.message : "Unable to open file",
        }),
      );
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
  } else if (action === "save-file" && state.activeFile) {
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="File content"]',
    );
    const content = editor?.value ?? state.activeFile.content;
    void window.ohMyCliDesktop
      .writeWorkspaceFile({ path: state.activeFile.path, content })
      .then((file) => dispatch({ type: "file-saved", file }))
      .catch((error: unknown) =>
        dispatch({
          type: "set-error",
          message:
            error instanceof Error ? error.message : "Unable to save file",
        }),
      );
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
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLTextAreaElement &&
    target.getAttribute("aria-label") === "File content"
  ) {
    dispatch({ type: "file-changed", content: target.value }, false);
    document
      .querySelector<HTMLButtonElement>('[data-action="save-file"]')
      ?.removeAttribute("disabled");
    return;
  }
  if (
    target instanceof HTMLTextAreaElement &&
    target.getAttribute("aria-label") === "Message"
  ) {
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
  }
});

document.addEventListener("scroll", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.classList.contains("stage"))
    return;
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
  if (input) input.value = "";
  // Cancel any pending draft debounce so the just-sent text cannot be written
  // back as a phantom draft after the composer is cleared.
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  mergeMirrorEntry(sessionId, { draft: "" });
  persistUi({ sessions: { [sessionId]: { draft: "" } } });
  dispatch({ type: "optimistic-user", content: prompt });
  dispatch({ type: "set-busy", busy: true });
  void window.ohMyCliDesktop
    .sendMessage({ sessionId, prompt })
    .then(async () => {
      const session = await window.ohMyCliDesktop.loadSession(sessionId);
      dispatch({ type: "select-session", session });
      dispatch({ type: "set-busy", busy: false });
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
    target.getAttribute("aria-label") === "Message" &&
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    event.preventDefault();
    target.closest("form")?.requestSubmit();
    return;
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
    if (state.confirmDeleteId) {
      dispatch({ type: "confirm-delete" });
    } else if (state.diagnosticsOpen) {
      dispatch({ type: "set-diagnostics", open: false });
    }
  }
});

window.addEventListener("beforeunload", () => {
  captureActiveContext();
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
