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
}

function dispatch(action: DesktopAction): void {
  state = reduceDesktopState(state, action);
  render();
}

async function bootstrap(): Promise<void> {
  dispatch({ type: "bootstrap-started" });
  try {
    const payload = await window.ohMyCliDesktop.getBootstrapState();
    dispatch({ type: "bootstrap-resolved", payload });
  } catch (error) {
    dispatch({
      type: "bootstrap-rejected",
      message:
        error instanceof Error ? error.message : "Desktop bridge unavailable",
    });
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const view = target.closest<HTMLElement>("[data-view]")?.dataset.view;
  if (view === "chat" || view === "workflow" || view === "changes") {
    dispatch({ type: "select-view", view: view as DesktopPrimaryView });
    return;
  }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "open-diagnostics") {
    dispatch({ type: "set-diagnostics", open: true });
  } else if (action === "close-diagnostics") {
    dispatch({ type: "set-diagnostics", open: false });
  } else if (action === "retry-bootstrap") {
    void bootstrap();
  } else if (
    target instanceof HTMLElement &&
    target.dataset.dialogBackdrop === "true"
  ) {
    dispatch({ type: "set-diagnostics", open: false });
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
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
    document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus();
    return;
  }
  if (event.key === "Escape" && state.diagnosticsOpen) {
    dispatch({ type: "set-diagnostics", open: false });
  }
});

render();
void bootstrap();
