import type { DesktopBridge } from "./contracts.js";
import {
  createDesktopViewModel,
  createInitialDesktopState,
  reduceDesktopState,
  renderDesktopWorkbench,
  type DesktopAction,
  type DesktopPrimaryView,
} from "./renderer.js";

declare global {
  interface Window {
    ohMyCliDesktop: DesktopBridge;
  }
}

let state = createInitialDesktopState();

function render(): void {
  const root = document.querySelector<HTMLElement>("#desktop-root");
  if (!root) return;
  root.innerHTML = renderDesktopWorkbench(createDesktopViewModel(state));
  requestAnimationFrame(() => {
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

async function selectSession(sessionId: string): Promise<void> {
  try {
    const session = await window.ohMyCliDesktop.loadSession(sessionId);
    dispatch({ type: "select-session", session });
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

async function bootstrap(): Promise<void> {
  dispatch({ type: "bootstrap-started" });
  try {
    const [payload, sessions, files] = await Promise.all([
      window.ohMyCliDesktop.getBootstrapState(),
      window.ohMyCliDesktop.listSessions(),
      window.ohMyCliDesktop.listWorkspaceFiles(),
    ]);
    dispatch({ type: "bootstrap-resolved", payload, sessions, files });
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
  if (sessionId) {
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
    void window.ohMyCliDesktop
      .createSession()
      .then(async (session) => {
        await refreshSessions();
        dispatch({ type: "select-session", session });
        document
          .querySelector<HTMLTextAreaElement>('[aria-label="Message"]')
          ?.focus();
      })
      .catch((error: unknown) =>
        dispatch({
          type: "set-error",
          message:
            error instanceof Error ? error.message : "Unable to create session",
        }),
      );
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
  }
});

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
  dispatch({ type: "optimistic-user", content: prompt });
  dispatch({ type: "set-busy", busy: true });
  void window.ohMyCliDesktop
    .sendMessage({ sessionId, prompt })
    .then(async () => {
      const session = await window.ohMyCliDesktop.loadSession(sessionId);
      dispatch({ type: "select-session", session });
      dispatch({ type: "set-busy", busy: false });
      await refreshSessions();
    })
    .catch((error: unknown) => {
      dispatch({ type: "set-busy", busy: false });
      dispatch({
        type: "set-error",
        message: error instanceof Error ? error.message : "Agent turn failed",
      });
    });
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
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
    document
      .querySelector<HTMLTextAreaElement>('[aria-label="Message"]')
      ?.focus();
  } else if (event.key === "Escape" && state.diagnosticsOpen) {
    dispatch({ type: "set-diagnostics", open: false });
  }
});

render();
void bootstrap();
