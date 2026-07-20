import type { DesktopBootstrapState } from "./contracts.js";

export type DesktopWorkbenchState =
  | "empty"
  | "loading"
  | "ready"
  | "error";

export type DesktopPrimaryView = "chat" | "workflow" | "changes";

export interface DesktopRuntimeState {
  phase: DesktopWorkbenchState;
  activeView: DesktopPrimaryView;
  diagnosticsOpen: boolean;
  bootstrap?: DesktopBootstrapState;
  error?: string;
}

export type DesktopAction =
  | { type: "bootstrap-started" }
  | { type: "bootstrap-resolved"; payload: DesktopBootstrapState }
  | { type: "bootstrap-rejected"; message: string }
  | { type: "select-view"; view: DesktopPrimaryView }
  | { type: "set-diagnostics"; open: boolean };

export interface DesktopViewModel extends DesktopRuntimeState {
  heading: string;
  detail: string;
}

const STATE_COPY: Record<
  DesktopWorkbenchState,
  Pick<DesktopViewModel, "heading" | "detail">
> = {
  empty: {
    heading: "Choose a project to begin",
    detail: "Open a local workspace to start a focused agent session.",
  },
  loading: {
    heading: "Opening the Desktop workbench",
    detail: "Checking the secure local bridge and application runtime.",
  },
  ready: {
    heading: "Desktop foundation ready",
    detail:
      "The secure shell is connected. Session execution remains gated until the native macOS evidence requirement is satisfied.",
  },
  error: {
    heading: "Desktop bridge unavailable",
    detail: "The local application bridge did not finish starting.",
  },
};

export function createInitialDesktopState(): DesktopRuntimeState {
  return {
    phase: "loading",
    activeView: "chat",
    diagnosticsOpen: false,
  };
}

export function reduceDesktopState(
  state: DesktopRuntimeState,
  action: DesktopAction,
): DesktopRuntimeState {
  switch (action.type) {
    case "bootstrap-started":
      return { ...state, phase: "loading", error: undefined };
    case "bootstrap-resolved":
      return {
        ...state,
        phase: "ready",
        bootstrap: action.payload,
        error: undefined,
      };
    case "bootstrap-rejected":
      return {
        ...state,
        phase: "error",
        bootstrap: undefined,
        error: action.message,
      };
    case "select-view":
      return { ...state, activeView: action.view };
    case "set-diagnostics":
      return { ...state, diagnosticsOpen: action.open };
  }
}

export function createDesktopViewModel(
  state: DesktopWorkbenchState | DesktopRuntimeState,
): DesktopViewModel {
  const runtime =
    typeof state === "string"
      ? {
          ...createInitialDesktopState(),
          phase: state,
        }
      : state;
  const copy = STATE_COPY[runtime.phase];
  return {
    ...runtime,
    ...copy,
    detail: runtime.error ?? copy.detail,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function platformLabel(platform?: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "Starting";
}

function renderView(model: DesktopViewModel): string {
  if (model.phase === "loading") {
    return `<div class="state-card is-loading"><span class="spinner" aria-hidden="true"></span><p class="eyebrow">Secure local bridge</p><h1>${model.heading}</h1><p>${model.detail}</p></div>`;
  }
  if (model.phase === "error") {
    return `<div class="state-card is-error"><span class="state-symbol">!</span><p class="eyebrow">Recoverable startup error</p><h1>${model.heading}</h1><p>${escapeHtml(model.detail)}</p><button class="secondary-button" type="button" data-action="retry-bootstrap">Try again</button></div>`;
  }
  if (model.phase === "empty") {
    return `<div class="state-card"><span class="state-symbol">⌘</span><p class="eyebrow">Local workbench</p><h1>${model.heading}</h1><p>${model.detail}</p></div>`;
  }
  if (model.activeView === "workflow") {
    return `<div class="state-card"><span class="state-symbol">◇</span><p class="eyebrow">Dynamic Workflow</p><h1>Workflow view is staged</h1><p>Real checkpoints and approval actions unlock after session continuity and live workbench events are delivered through #107–#109.</p><div class="gate-row"><span>Session authority</span><strong>Waiting for #107</strong></div><div class="gate-row"><span>Checkpoint authority</span><strong>Waiting for #109</strong></div></div>`;
  }
  if (model.activeView === "changes") {
    return `<div class="state-card"><span class="state-symbol">±</span><p class="eyebrow">Changes</p><h1>No fabricated diff</h1><p>File changes will appear here only when a real selected session emits a head-bound diff receipt through #108.</p><div class="gate-row"><span>Selected session</span><strong>Not connected</strong></div></div>`;
  }
  return `<div class="welcome"><div class="welcome-copy"><p class="eyebrow">Agent workbench</p><h1>${model.heading}</h1><p>${model.detail}</p></div><div class="capability-grid"><article class="capability is-ready"><span class="capability-icon">✓</span><div><strong>Secure Electron shell</strong><p>Isolated renderer and allowlisted preload bridge.</p></div><span class="status-label">Ready</span></article><article class="capability" data-capability="session-continuity"><span class="capability-icon">1</span><div><strong>Session continuity</strong><p>Real project, session, and Terminal ownership.</p></div><span class="status-label">After #133</span></article><article class="capability"><span class="capability-icon">2</span><div><strong>Live workbench</strong><p>Ordered chat, tool, diff, and failure events.</p></div><span class="status-label">After #107</span></article><article class="capability"><span class="capability-icon">3</span><div><strong>Workflow delivery</strong><p>Approvals, evidence, checks, and delivery state.</p></div><span class="status-label">After #108</span></article></div></div>`;
}

function renderDiagnostics(model: DesktopViewModel): string {
  if (!model.diagnosticsOpen) return "";
  const platform = platformLabel(model.bootstrap?.platform);
  const version = model.bootstrap?.version ?? "Unavailable";
  return `<div class="dialog-backdrop" data-dialog-backdrop="true"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title"><div class="dialog-heading"><div><p class="eyebrow">Local runtime</p><h2 id="diagnostics-title">Desktop diagnostics</h2></div><button class="icon-button" type="button" aria-label="Close diagnostics" data-action="close-diagnostics">×</button></div><dl><div><dt>Platform</dt><dd data-diagnostic="platform">${escapeHtml(platform)}</dd></div><div><dt>Application version</dt><dd data-diagnostic="version">${escapeHtml(version)}</dd></div><div><dt>Renderer access</dt><dd>Isolated · no Node.js</dd></div><div><dt>Session execution</dt><dd>Not connected</dd></div></dl><p class="dialog-note">Diagnostics intentionally exclude credentials, account identifiers, and workspace paths.</p></section></div>`;
}

function tab(
  view: DesktopPrimaryView,
  label: string,
  active: DesktopPrimaryView,
): string {
  const selected = view === active;
  return `<button class="tab" role="tab" type="button" data-view="${view}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${label}</button>`;
}

export function renderDesktopWorkbench(model: DesktopViewModel): string {
  const platform = platformLabel(model.bootstrap?.platform);
  const version = model.bootstrap?.version ?? "—";
  return `<div class="app" data-workbench-state="${model.phase}">
    <header class="titlebar"><span aria-hidden="true"></span><strong>Oh My CLI</strong><span class="runtime-status ${model.phase === "ready" ? "is-ready" : ""}"><i></i>${escapeHtml(platform)}</span></header>
    <nav class="rail" aria-label="Projects and sessions">
      <div class="brand"><span class="mark">OM</span><span>Oh My CLI</span></div>
      <p class="section-label">Workspace</p>
      <button class="rail-item active" type="button"><span class="rail-icon">□</span><span>Local workspace</span><small>foundation</small></button>
      <p class="section-label">Sessions</p>
      <button class="rail-item" type="button" disabled><span class="rail-icon">›_</span><span>No connected session</span></button>
      <p class="section-label">Workflows</p>
      <button class="rail-item" type="button" disabled><span class="rail-icon">◇</span><span>Waiting for session</span></button>
      <div class="rail-footer"><span class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></span><div><strong>${model.phase === "ready" ? "Desktop connected" : "Desktop starting"}</strong><small>session continuity not connected</small></div></div>
    </nav>
    <main class="workbench" aria-label="Agent workbench">
      <div class="workspace-bar"><div><strong>Desktop foundation</strong><small>maintainer-directed · Issue #176</small></div><div class="tabs" role="tablist" aria-label="Primary workbench views">${tab("chat", "Chat", model.activeView)}${tab("workflow", "Workflow", model.activeView)}${tab("changes", "Changes", model.activeView)}</div><button class="icon-button" type="button" aria-label="Open diagnostics" data-action="open-diagnostics">•••</button></div>
      <section class="stage" role="tabpanel" aria-live="polite">${renderView(model)}</section>
      <div class="composer-wrap" data-fixed-composer="true"><form class="composer" aria-label="Message composer"><textarea rows="2" aria-label="Message" placeholder="Connect a real session in #107 before sending a task"></textarea><div class="composer-footer"><span>⌘K focus · session required</span><button class="send" type="button" aria-label="Send message" disabled>↵</button></div></form></div>
      <footer class="statusbar"><span><i class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></i>Secure bridge ${model.phase}</span><span>${escapeHtml(platform)} · ${escapeHtml(version)}</span></footer>
    </main>
    <aside class="inspector" aria-label="Context inspector">
      <div class="inspector-heading"><span>Delivery</span><strong>Foundation only</strong></div>
      <section class="inspector-section"><p class="section-label">Desktop gate</p><h2>#106 · Session shell</h2><div class="progress-label"><span>Evidence lanes</span><strong>2 of 3 landed</strong></div><div class="progress"><i></i></div><div class="evidence-row"><span>Electron security</span><strong>Landed · #128</strong></div><div class="evidence-row"><span>Linux interaction</span><strong>Landed · #132</strong></div><div class="evidence-row is-blocked"><span>Native macOS evidence</span><strong>Requires #133</strong></div></section>
      <section class="inspector-section"><p class="section-label">Available now</p><div class="check-row"><span>✓</span>Keyboard navigation</div><div class="check-row"><span>✓</span>Typed bootstrap bridge</div><div class="check-row"><span>✓</span>Honest capability gates</div></section>
      <section class="inspector-section"><p class="section-label">Diagnostics</p><p class="muted">Inspect the real local platform and application version without exposing secrets.</p><button class="wide-button" type="button" data-action="open-diagnostics">Open diagnostics</button></section>
    </aside>
    ${renderDiagnostics(model)}
  </div>`;
}

export function renderDesktopShell(model: DesktopViewModel): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Oh My CLI Desktop</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: #070809; color: #f3f4f6; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 960px; min-height: 640px; overflow: hidden; background: #070809; }
      button, textarea { font: inherit; }
      button { color: inherit; }
      button:focus-visible, textarea:focus-visible { outline: 2px solid #7c6cff; outline-offset: 2px; }
      button:disabled { cursor: not-allowed; }
      .app { display: grid; grid-template: 48px 1fr / 244px minmax(480px, 1fr) 300px; height: 100vh; background: #090a0c; }
      .titlebar { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 16px; border-bottom: 1px solid #25272d; background: #15161a; -webkit-app-region: drag; font-size: 12px; }
      .titlebar strong { font-weight: 650; }
      .runtime-status { justify-self: end; color: #858892; }
      .runtime-status i, .connection-dot { display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: #60636b; }
      .runtime-status.is-ready i, .connection-dot.is-ready { background: #19e879; box-shadow: 0 0 12px #19e87955; }
      .rail, .inspector { min-width: 0; background: #0f1013; }
      .rail { position: relative; padding: 18px 12px 82px; border-right: 1px solid #25272d; }
      .brand { display: flex; align-items: center; gap: 10px; margin: 0 8px 27px; font-size: 13px; font-weight: 650; }
      .mark { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 8px; background: linear-gradient(135deg, #6f62ef, #b46bd1); font-size: 10px; }
      .section-label { margin: 18px 8px 8px; color: #686b74; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      .rail-item { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; width: 100%; gap: 8px; padding: 10px 9px; border: 0; border-radius: 7px; color: #b5b7be; background: transparent; text-align: left; font-size: 12px; }
      .rail-item.active { color: #fff; background: #25242d; }
      .rail-item:disabled { opacity: .55; }
      .rail-item small { color: #686b74; font-size: 10px; }
      .rail-icon { color: #8b8e97; font-family: "SFMono-Regular", Consolas, monospace; }
      .rail-footer { position: absolute; right: 18px; bottom: 18px; left: 18px; display: flex; align-items: flex-start; color: #b2b4ba; font-size: 11px; }
      .rail-footer strong, .rail-footer small { display: block; }
      .rail-footer small { margin-top: 5px; color: #61646c; }
      .workbench { display: grid; grid-template-rows: 62px minmax(0, 1fr) auto 30px; min-width: 0; background: #08090b; }
      .workspace-bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 20px; border-bottom: 1px solid #22242a; }
      .workspace-bar > div:first-child strong, .workspace-bar > div:first-child small { display: block; }
      .workspace-bar strong { font-size: 12px; font-weight: 650; }
      .workspace-bar small { margin-top: 3px; color: #72757e; font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; }
      .tabs { display: flex; align-self: stretch; gap: 22px; }
      .tab { position: relative; border: 0; color: #787b84; background: transparent; font-size: 11px; }
      .tab[aria-selected="true"] { color: #f4f5f6; }
      .tab[aria-selected="true"]::after { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: #6f62ef; content: ""; }
      .icon-button { justify-self: end; min-width: 30px; height: 30px; border: 0; border-radius: 7px; color: #8d9099; background: transparent; }
      .icon-button:hover { background: #1c1e23; }
      .stage { min-height: 0; overflow: auto; padding: 48px clamp(28px, 7vw, 86px); }
      .state-card { max-width: 620px; margin: 10vh auto 0; text-align: center; }
      .state-card h1, .welcome h1 { margin: 10px 0 10px; font-size: 24px; font-weight: 620; letter-spacing: -.025em; }
      .state-card > p, .welcome-copy > p:last-child { margin: 0 auto; max-width: 570px; color: #8d9099; font-size: 13px; line-height: 1.6; }
      .eyebrow { color: #737680 !important; font-size: 9px !important; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
      .state-symbol { display: grid; width: 36px; height: 36px; margin: 0 auto 22px; place-items: center; border: 1px solid #373a42; border-radius: 10px; color: #c4c6cc; background: #14161a; }
      .is-error .state-symbol { color: #ff8a82; border-color: #542a2b; background: #241416; }
      .spinner { display: block; width: 28px; height: 28px; margin: 0 auto 24px; border: 2px solid #292c33; border-top-color: #7c6cff; border-radius: 50%; animation: spin 900ms linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: #292c33; } }
      .welcome { max-width: 760px; margin: 0 auto; }
      .welcome-copy { margin-bottom: 28px; text-align: center; }
      .capability-grid { display: grid; gap: 8px; }
      .capability { display: grid; grid-template-columns: 30px 1fr auto; align-items: center; gap: 12px; padding: 13px 14px; border: 1px solid #252830; border-radius: 9px; background: #0e1013; }
      .capability.is-ready { border-color: #16472e; background: #0a1510; }
      .capability-icon { display: grid; width: 25px; height: 25px; place-items: center; border: 1px solid #343740; border-radius: 7px; color: #9b9ea7; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; }
      .is-ready .capability-icon { color: #19e879; border-color: #1b5f39; }
      .capability strong { font-size: 11px; font-weight: 600; }
      .capability p { margin: 4px 0 0; color: #676a73; font-size: 10px; }
      .status-label { color: #777a83; font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; }
      .is-ready .status-label { color: #19e879; }
      .gate-row { display: flex; justify-content: space-between; max-width: 510px; margin: 18px auto 0; padding: 12px 14px; border: 1px solid #282b32; border-radius: 8px; color: #8d9099; background: #0e1013; font-size: 10px; }
      .gate-row + .gate-row { margin-top: 8px; }
      .gate-row strong { color: #d0d2d6; font-weight: 500; }
      .secondary-button, .wide-button { margin-top: 22px; padding: 9px 14px; border: 1px solid #343740; border-radius: 7px; color: #d5d7db; background: #17191e; font-size: 11px; }
      .composer-wrap { padding: 0 24px 16px; }
      .composer { min-height: 86px; padding: 14px 14px 11px 16px; border: 1px solid #2b2e35; border-radius: 10px; background: #111216; box-shadow: 0 18px 60px #0008; }
      textarea { width: 100%; min-height: 38px; resize: none; border: 0; outline: 0; color: #eff0f2; background: transparent; font-size: 12px; line-height: 1.45; }
      textarea::placeholder { color: #666972; }
      .composer-footer { display: flex; align-items: center; justify-content: space-between; color: #6f727b; font-size: 9px; }
      .send { width: 27px; height: 27px; border: 0; border-radius: 7px; color: #858891; background: #292b31; }
      .statusbar { display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-top: 1px solid #22242a; color: #666972; font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; }
      .inspector { border-left: 1px solid #25272d; }
      .inspector-heading { display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 16px; border-bottom: 1px solid #25272d; font-size: 9px; text-transform: uppercase; }
      .inspector-heading strong { color: #d2a93b; font-weight: 600; }
      .inspector-section { padding: 0 16px 18px; border-bottom: 1px solid #25272d; }
      .inspector-section .section-label { margin-left: 0; }
      .inspector-section h2 { margin: 0 0 8px; font-size: 12px; }
      .progress-label { display: flex; justify-content: space-between; margin-top: 14px; color: #737680; font-size: 9px; }
      .progress-label strong { color: #d2a93b; font-weight: 600; }
      .progress { height: 7px; margin: 8px 0 18px; overflow: hidden; border-radius: 4px; background: #27292e; }
      .progress i { display: block; width: 66.666%; height: 100%; background: linear-gradient(90deg, #19e879, #d2a93b); }
      .evidence-row { display: flex; justify-content: space-between; margin: 11px 0; color: #9a9da5; font-size: 10px; }
      .evidence-row strong { color: #19e879; font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; }
      .evidence-row.is-blocked strong { color: #d2a93b; }
      .check-row { display: flex; gap: 8px; margin: 11px 0; color: #a8abb2; font-size: 10px; }
      .check-row span { color: #19e879; }
      .muted { color: #71747d; font-size: 10px; line-height: 1.55; }
      .wide-button { width: 100%; margin-top: 12px; }
      .dialog-backdrop { position: fixed; inset: 0; display: grid; place-items: center; background: #000a; z-index: 10; }
      .dialog { width: min(430px, calc(100vw - 48px)); padding: 22px; border: 1px solid #343740; border-radius: 12px; background: #121419; box-shadow: 0 30px 100px #000; }
      .dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; }
      .dialog h2 { margin: 5px 0 18px; font-size: 18px; }
      .dialog dl { margin: 0; }
      .dialog dl div { display: flex; justify-content: space-between; padding: 11px 0; border-top: 1px solid #292c32; font-size: 10px; }
      .dialog dt { color: #767982; }
      .dialog dd { margin: 0; color: #d2d4d8; }
      .dialog-note { margin: 16px 0 0; color: #666972; font-size: 9px; line-height: 1.5; }
      @media (max-width: 1120px) { .app { grid-template-columns: 210px minmax(440px, 1fr) 260px; } .stage { padding-inline: 28px; } }
    </style>
    <script src="./renderer-entry.js" defer></script>
  </head>
  <body><div id="desktop-root">${renderDesktopWorkbench(model)}</div></body>
</html>`;
}
