import type {
  DesktopAgentEvent,
  DesktopBootstrapState,
  DesktopFileDocument,
  DesktopSession,
  DesktopSessionSummary,
  DesktopWorkspaceFile,
} from "./contracts.js";

export type DesktopWorkbenchState = "empty" | "loading" | "ready" | "error";
export type DesktopPrimaryView = "chat" | "workflow" | "changes";

export interface DesktopRuntimeState {
  phase: DesktopWorkbenchState;
  activeView: DesktopPrimaryView;
  diagnosticsOpen: boolean;
  bootstrap?: DesktopBootstrapState;
  sessions: DesktopSessionSummary[];
  activeSession?: DesktopSession;
  busy: boolean;
  streamingText: string;
  activity: string[];
  files: DesktopWorkspaceFile[];
  activeFile?: DesktopFileDocument;
  fileDirty: boolean;
  notice?: string;
  error?: string;
}

export type DesktopAction =
  | { type: "bootstrap-started" }
  | {
      type: "bootstrap-resolved";
      payload: DesktopBootstrapState;
      sessions?: DesktopSessionSummary[];
      files?: DesktopWorkspaceFile[];
    }
  | { type: "bootstrap-rejected"; message: string }
  | { type: "select-view"; view: DesktopPrimaryView }
  | { type: "set-diagnostics"; open: boolean }
  | { type: "set-sessions"; sessions: DesktopSessionSummary[] }
  | { type: "select-session"; session: DesktopSession }
  | { type: "optimistic-user"; content: string }
  | { type: "set-busy"; busy: boolean }
  | { type: "agent-event"; event: DesktopAgentEvent }
  | { type: "select-file"; file: DesktopFileDocument }
  | { type: "file-changed"; content: string }
  | { type: "file-saved"; file: DesktopFileDocument }
  | { type: "set-error"; message?: string };

export interface DesktopViewModel extends DesktopRuntimeState {
  heading: string;
  detail: string;
}

const STATE_COPY: Record<
  DesktopWorkbenchState,
  Pick<DesktopViewModel, "heading" | "detail">
> = {
  empty: {
    heading: "Start a local agent session",
    detail:
      "Create a session, ask Qwen to work in this repository, or open a file from the workspace.",
  },
  loading: {
    heading: "Opening the Desktop workbench",
    detail: "Loading persisted sessions and the secure local workspace bridge.",
  },
  ready: {
    heading: "Ready for a real task",
    detail:
      "Messages are persisted locally and workspace edits stay inside this repository.",
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
    sessions: [],
    busy: false,
    streamingText: "",
    activity: [],
    files: [],
    fileDirty: false,
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
        sessions: action.sessions ?? state.sessions,
        files: action.files ?? state.files,
        error: undefined,
      };
    case "bootstrap-rejected":
      return { ...state, phase: "error", error: action.message };
    case "select-view":
      return { ...state, activeView: action.view };
    case "set-diagnostics":
      return { ...state, diagnosticsOpen: action.open };
    case "set-sessions":
      return { ...state, sessions: action.sessions };
    case "select-session":
      return {
        ...state,
        activeSession: action.session,
        activeView: "chat",
        streamingText: "",
        activity: [],
        notice: undefined,
        error: undefined,
      };
    case "optimistic-user":
      if (!state.activeSession) return state;
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          messages: [
            ...state.activeSession.messages,
            { role: "user", content: action.content },
          ],
        },
        streamingText: "",
        activity: [],
        notice: "Qwen is thinking",
      };
    case "set-busy":
      return { ...state, busy: action.busy };
    case "agent-event": {
      if (action.event.sessionId !== state.activeSession?.id) return state;
      if (action.event.type === "assistant-delta") {
        return {
          ...state,
          streamingText: state.streamingText + action.event.delta,
        };
      }
      if (action.event.type === "tool-start") {
        return {
          ...state,
          activity: [...state.activity, `Running ${action.event.name}`].slice(
            -8,
          ),
          notice: `${action.event.name} in progress`,
        };
      }
      if (action.event.type === "tool-result") {
        return {
          ...state,
          activity: [
            ...state.activity,
            `${action.event.name} ${action.event.ok ? "completed" : "failed"}`,
          ].slice(-8),
        };
      }
      if (action.event.type === "status")
        return { ...state, notice: action.event.message };
      if (action.event.type === "error")
        return { ...state, error: action.event.message };
      return {
        ...state,
        busy: false,
        notice: action.event.ok ? "Turn complete" : "Turn failed",
      };
    }
    case "select-file":
      return {
        ...state,
        activeFile: action.file,
        activeView: "changes",
        fileDirty: false,
        error: undefined,
      };
    case "file-changed":
      return state.activeFile
        ? {
            ...state,
            activeFile: { ...state.activeFile, content: action.content },
            fileDirty: true,
          }
        : state;
    case "file-saved":
      return {
        ...state,
        activeFile: action.file,
        fileDirty: false,
        notice: `Saved ${action.file.path}`,
      };
    case "set-error":
      return { ...state, error: action.message };
  }
}

export function createDesktopViewModel(
  state: DesktopWorkbenchState | DesktopRuntimeState,
): DesktopViewModel {
  const runtime =
    typeof state === "string"
      ? { ...createInitialDesktopState(), phase: state }
      : state;
  const copy = STATE_COPY[runtime.phase];
  return { ...runtime, ...copy, detail: runtime.error ?? copy.detail };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textHtml(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function platformLabel(platform?: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "Starting";
}

function tab(
  view: DesktopPrimaryView,
  label: string,
  active: DesktopPrimaryView,
): string {
  const selected = view === active;
  return `<button class="tab" role="tab" type="button" data-view="${view}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${label}</button>`;
}

function renderSessions(model: DesktopViewModel): string {
  if (model.sessions.length === 0) {
    return `<p class="rail-empty">No sessions yet</p>`;
  }
  return model.sessions
    .map((session) => {
      const active = session.id === model.activeSession?.id;
      return `<button class="rail-item session-item ${active ? "active" : ""}" type="button" data-session-id="${escapeHtml(session.id)}"><span class="rail-icon">›_</span><span>${escapeHtml(session.title)}</span><small>${session.messageCount}</small></button>`;
    })
    .join("");
}

function renderMessages(model: DesktopViewModel): string {
  if (!model.activeSession) {
    return `<div class="state-card"><span class="state-symbol">＋</span><p class="eyebrow">Local sessions</p><h1>${model.heading}</h1><p>${model.detail}</p><button class="primary-button" type="button" data-action="new-session">New session</button></div>`;
  }
  const messages = model.activeSession.messages
    .map(
      (message) =>
        `<article class="message ${message.role}"><div class="avatar">${message.role === "user" ? "You" : "Q"}</div><div><strong>${message.role === "user" ? "You" : "Qwen"}</strong><p>${textHtml(message.content)}</p>${message.interrupted ? '<small class="interrupted">Interrupted response</small>' : ""}</div></article>`,
    )
    .join("");
  const streaming = model.streamingText
    ? `<article class="message assistant is-streaming"><div class="avatar">Q</div><div><strong>Qwen <small>streaming</small></strong><p>${textHtml(model.streamingText)}<span class="cursor" aria-hidden="true"></span></p></div></article>`
    : "";
  const empty =
    messages || streaming
      ? ""
      : `<div class="conversation-empty"><p class="eyebrow">Session ready</p><h1>What should we build?</h1><p>Ask about the codebase, request a change, or edit a file directly from the workspace panel.</p></div>`;
  return `<div class="conversation" data-conversation="true">${empty}${messages}${streaming}</div>`;
}

function renderWorkflow(model: DesktopViewModel): string {
  const items = model.activity.length
    ? model.activity
        .map(
          (item, index) =>
            `<li><span>${index + 1}</span><strong>${escapeHtml(item)}</strong></li>`,
        )
        .join("")
    : `<li class="is-empty"><span>◇</span><strong>Tool activity appears here during a turn</strong></li>`;
  return `<div class="workflow-view"><p class="eyebrow">Live execution</p><h1>Agent activity</h1><ol>${items}</ol></div>`;
}

function renderEditor(model: DesktopViewModel): string {
  if (!model.activeFile) {
    return `<div class="state-card"><span class="state-symbol">{ }</span><p class="eyebrow">Workspace editor</p><h1>Open a text file</h1><p>Select a file from the right panel. Reads and saves are confined to this workspace.</p></div>`;
  }
  return `<div class="editor"><header><div><p class="eyebrow">Workspace file</p><h1>${escapeHtml(model.activeFile.path)}</h1></div><div class="editor-actions"><span>${model.fileDirty ? "Unsaved" : `${model.activeFile.bytes} bytes`}</span><button class="primary-button" type="button" data-action="save-file" ${model.fileDirty ? "" : "disabled"}>Save</button></div></header><textarea class="code-editor" aria-label="File content" spellcheck="false">${escapeHtml(model.activeFile.content)}</textarea></div>`;
}

function renderStage(model: DesktopViewModel): string {
  if (model.phase === "loading") {
    return `<div class="state-card is-loading"><span class="spinner" aria-hidden="true"></span><p class="eyebrow">Secure local bridge</p><h1>${model.heading}</h1><p>${model.detail}</p></div>`;
  }
  if (model.phase === "error" && !model.bootstrap) {
    return `<div class="state-card is-error"><span class="state-symbol">!</span><p class="eyebrow">Startup error</p><h1>${model.heading}</h1><p>${escapeHtml(model.detail)}</p><button class="secondary-button" type="button" data-action="retry-bootstrap">Try again</button></div>`;
  }
  if (model.activeView === "workflow") return renderWorkflow(model);
  if (model.activeView === "changes") return renderEditor(model);
  return renderMessages(model);
}

function renderFiles(model: DesktopViewModel): string {
  if (model.files.length === 0)
    return `<p class="inspector-empty">No editable files found.</p>`;
  return model.files
    .map(
      (file) =>
        `<button class="file-item ${file.path === model.activeFile?.path ? "active" : ""}" type="button" data-file-path="${escapeHtml(file.path)}"><span>⌁</span>${escapeHtml(file.path)}</button>`,
    )
    .join("");
}

function renderDiagnostics(model: DesktopViewModel): string {
  if (!model.diagnosticsOpen) return "";
  return `<div class="dialog-backdrop" data-dialog-backdrop="true"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title"><div class="dialog-heading"><div><p class="eyebrow">Local runtime</p><h2 id="diagnostics-title">Desktop diagnostics</h2></div><button class="icon-button" type="button" aria-label="Close diagnostics" data-action="close-diagnostics">×</button></div><dl><div><dt>Platform</dt><dd data-diagnostic="platform">${escapeHtml(platformLabel(model.bootstrap?.platform))}</dd></div><div><dt>Application version</dt><dd data-diagnostic="version">${escapeHtml(model.bootstrap?.version ?? "Unavailable")}</dd></div><div><dt>Renderer access</dt><dd>Sandboxed · typed IPC</dd></div><div><dt>Sessions</dt><dd>${model.sessions.length} local</dd></div></dl><p class="dialog-note">Diagnostics exclude credentials, account identifiers, and absolute workspace paths.</p></section></div>`;
}

export function renderDesktopWorkbench(model: DesktopViewModel): string {
  const platform = platformLabel(model.bootstrap?.platform);
  const version = model.bootstrap?.version ?? "—";
  const canSend =
    Boolean(model.activeSession) && !model.busy && model.phase === "ready";
  return `<div class="app" data-workbench-state="${model.phase}" data-agent-busy="${model.busy}">
    <header class="titlebar"><span></span><strong>Oh My CLI</strong><span class="runtime-status ${model.phase === "ready" ? "is-ready" : ""}"><i></i>${escapeHtml(platform)}</span></header>
    <nav class="rail" aria-label="Projects and sessions">
      <div class="brand"><span class="mark">OM</span><span>Oh My CLI</span></div>
      <div class="section-heading"><p class="section-label">Workspace</p></div>
      <button class="rail-item workspace-item" type="button"><span class="rail-icon">□</span><span>${escapeHtml(model.bootstrap?.workspaceName ?? "Local workspace")}</span><small>local</small></button>
      <div class="section-heading"><p class="section-label">Sessions</p><button class="new-session" type="button" aria-label="New session" data-action="new-session">＋</button></div>
      <div class="session-list">${renderSessions(model)}</div>
      <div class="rail-footer"><span class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></span><div><strong>${model.phase === "ready" ? "Desktop connected" : "Desktop starting"}</strong><small>${model.sessions.length} persisted session${model.sessions.length === 1 ? "" : "s"}</small></div></div>
    </nav>
    <main class="workbench" aria-label="Agent workbench">
      <div class="workspace-bar"><div><strong>${escapeHtml(model.activeSession?.title ?? "Local agent workbench")}</strong><small>${model.busy ? "Qwen is working" : (model.notice ?? "Issue #486 · usable Desktop foundation")}</small></div><div class="tabs" role="tablist" aria-label="Primary workbench views">${tab("chat", "Chat", model.activeView)}${tab("workflow", "Activity", model.activeView)}${tab("changes", "Files", model.activeView)}</div><button class="icon-button" type="button" aria-label="Open diagnostics" data-action="open-diagnostics">•••</button></div>
      ${model.error ? `<div class="error-banner" role="alert">${escapeHtml(model.error)}<button type="button" data-action="dismiss-error">×</button></div>` : ""}
      <section class="stage" role="tabpanel" aria-live="polite">${renderStage(model)}</section>
      <div class="composer-wrap" data-fixed-composer="true"><form class="composer" aria-label="Message composer"><textarea rows="2" aria-label="Message" placeholder="${model.activeSession ? "Ask Qwen to inspect, explain, or change this workspace" : "Create or select a session to start"}" ${canSend ? "" : "disabled"}></textarea><div class="composer-footer"><span>⌘K focus · Enter send · Shift+Enter newline</span><button class="send" type="submit" aria-label="Send message" ${canSend ? "" : "disabled"}>↵</button></div></form></div>
      <footer class="statusbar"><span><i class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></i>${model.busy ? "Agent turn running" : "Secure bridge ready"}</span><span>${escapeHtml(platform)} · ${escapeHtml(version)}</span></footer>
    </main>
    <aside class="inspector" aria-label="Context inspector"><div class="inspector-heading"><span>Workspace files</span><strong>${model.files.length}</strong></div><div class="file-list">${renderFiles(model)}</div><div class="inspector-note"><strong>Safe local editor</strong><p>UTF-8 text only · 1 MiB max · path confined</p></div></aside>
    ${renderDiagnostics(model)}
  </div>`;
}

export function renderDesktopShell(model: DesktopViewModel): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oh My CLI Desktop</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif; background:#f7f8fb; color:#1b1d24; }
    * { box-sizing:border-box; } body { margin:0; min-width:960px; min-height:640px; overflow:hidden; background:#f7f8fb; } button,textarea { font:inherit; } button { color:inherit; } button:focus-visible,textarea:focus-visible { outline:2px solid #6257d9; outline-offset:2px; } button:disabled,textarea:disabled { cursor:not-allowed; opacity:.55; }
    .app { display:grid; grid-template:48px 1fr / 238px minmax(480px,1fr) 318px; height:100vh; background:#f7f8fb; }
    .titlebar { grid-column:1/-1; display:grid; grid-template-columns:1fr auto 1fr; align-items:center; padding:0 16px; border-bottom:1px solid #dfe2e8; background:#f4f5f8; -webkit-app-region:drag; font-size:12px; }
    .runtime-status { justify-self:end; color:#747985; }.runtime-status i,.connection-dot { display:inline-block; width:8px; height:8px; margin-right:7px; border-radius:50%; background:#a7abb4; }.runtime-status.is-ready i,.connection-dot.is-ready { background:#0d9f5b; box-shadow:0 0 0 3px #0d9f5b18; }
    .rail,.inspector { min-width:0; background:#f4f5f8; }.rail { position:relative; padding:18px 12px 82px; border-right:1px solid #dfe2e8; overflow:hidden; }.brand { display:flex; align-items:center; gap:10px; margin:0 8px 24px; font-size:13px; font-weight:650; }.mark { display:grid; width:28px; height:28px; place-items:center; border-radius:8px; color:white; background:linear-gradient(135deg,#5d54ef,#c269cf); font-size:10px; }
    .section-heading { display:flex; align-items:center; justify-content:space-between; }.section-label { margin:16px 8px 8px; color:#8a8f9b; font-size:9px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }.new-session { width:25px; height:25px; margin:10px 4px 0 0; border:0; border-radius:6px; color:#5f6470; background:transparent; }.new-session:hover { background:#e6e7ec; }
    .rail-item { display:grid; grid-template-columns:18px minmax(0,1fr) auto; align-items:center; width:100%; gap:8px; padding:10px 9px; border:0; border-radius:7px; color:#505562; background:transparent; text-align:left; font-size:11px; }.rail-item span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.rail-item.active { color:#252832; background:#e8e8ef; box-shadow:inset 3px 0 #6257d9; }.rail-item small { color:#9297a2; font-size:9px; }.workspace-item { background:#eef0f5; }.rail-icon { color:#747985; font-family:"SFMono-Regular",Consolas,monospace; }.session-list { max-height:calc(100vh - 280px); overflow:auto; }.rail-empty { margin:8px; color:#9a9eaa; font-size:10px; }
    .rail-footer { position:absolute; right:18px; bottom:18px; left:18px; display:flex; align-items:flex-start; color:#505562; font-size:10px; }.rail-footer strong,.rail-footer small { display:block; }.rail-footer small { margin-top:4px; color:#9297a2; }
    .workbench { display:grid; grid-template-rows:62px auto minmax(0,1fr) auto 30px; min-width:0; background:white; }.workspace-bar { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; padding:0 20px; border-bottom:1px solid #e2e4e9; }.workspace-bar>div:first-child strong,.workspace-bar>div:first-child small { display:block; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.workspace-bar strong { font-size:12px; }.workspace-bar small { margin-top:3px; color:#858a96; font-family:"SFMono-Regular",Consolas,monospace; font-size:9px; }.tabs { display:flex; align-self:stretch; gap:22px; }.tab { position:relative; border:0; color:#858a96; background:transparent; font-size:11px; }.tab[aria-selected="true"] { color:#252832; }.tab[aria-selected="true"]::after { position:absolute; right:0; bottom:0; left:0; height:2px; background:#6257d9; content:""; }.icon-button { justify-self:end; min-width:30px; height:30px; border:0; border-radius:7px; color:#747985; background:transparent; }.icon-button:hover { background:#eceef2; }
    .error-banner { display:flex; align-items:center; justify-content:space-between; padding:8px 16px; color:#9b2727; background:#fff1f1; border-bottom:1px solid #f1caca; font-size:10px; }.error-banner button { border:0; background:transparent; }.stage { min-height:0; overflow:auto; padding:32px clamp(24px,5vw,68px); }.state-card { max-width:620px; margin:9vh auto 0; text-align:center; }.state-card h1,.conversation-empty h1,.workflow-view h1,.editor h1 { margin:9px 0; font-size:23px; font-weight:620; letter-spacing:-.025em; }.state-card>p,.conversation-empty>p:last-child { margin:0 auto; max-width:560px; color:#6f7480; font-size:12px; line-height:1.6; }.eyebrow { margin:0; color:#858a96!important; font-size:9px!important; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.state-symbol { display:grid; width:38px; height:38px; margin:0 auto 20px; place-items:center; border:1px solid #d9dce3; border-radius:10px; color:#5d626e; background:#f5f6f8; }.spinner { display:block; width:28px; height:28px; margin:0 auto 24px; border:2px solid #e0e2e8; border-top-color:#6257d9; border-radius:50%; animation:spin 900ms linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
    .primary-button,.secondary-button { padding:8px 13px; border:1px solid #d5d8df; border-radius:7px; background:white; font-size:10px; }.primary-button { color:white; border-color:#6257d9; background:#6257d9; }.state-card .primary-button,.state-card .secondary-button { margin-top:20px; }
    .conversation { max-width:760px; margin:0 auto; }.conversation-empty { margin:12vh auto 0; text-align:center; }.message { display:grid; grid-template-columns:32px 1fr; gap:12px; margin:0 0 24px; }.avatar { display:grid; width:30px; height:30px; place-items:center; border-radius:9px; color:#4e475d; background:#eeeafa; font-size:9px; font-weight:700; }.message.user .avatar { color:#555b67; background:#eceef2; }.message strong { font-size:11px; }.message strong small { margin-left:6px; color:#7b70d2; font-size:8px; }.message p { margin:6px 0 0; color:#373b46; font-size:12px; line-height:1.65; }.message.user p { padding:11px 13px; border:1px solid #e1e3e9; border-radius:3px 10px 10px 10px; background:#fafbfc; }.interrupted { color:#b05e18; }.cursor { display:inline-block; width:6px; height:13px; margin-left:3px; vertical-align:-2px; background:#6257d9; animation:blink 800ms step-end infinite; } @keyframes blink { 50% { opacity:0; } }
    .workflow-view { max-width:680px; margin:0 auto; }.workflow-view ol { padding:0; list-style:none; }.workflow-view li { display:grid; grid-template-columns:28px 1fr; align-items:center; gap:12px; padding:14px 0; border-bottom:1px solid #e6e8ed; font-size:11px; }.workflow-view li span { display:grid; width:25px; height:25px; place-items:center; border-radius:50%; color:#6257d9; background:#eeecff; font:9px "SFMono-Regular",monospace; }.workflow-view li.is-empty { color:#858a96; }
    .editor { display:grid; grid-template-rows:auto minmax(0,1fr); height:100%; min-height:360px; }.editor header { display:flex; align-items:center; justify-content:space-between; padding-bottom:14px; }.editor h1 { max-width:540px; margin-bottom:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; }.editor-actions { display:flex; align-items:center; gap:10px; color:#858a96; font-size:9px; }.code-editor { width:100%; min-height:0; resize:none; padding:18px; border:1px solid #dfe2e8; border-radius:9px; outline:0; color:#252832; background:#fafbfc; font:11px/1.65 "SFMono-Regular",Consolas,monospace; tab-size:2; }
    .composer-wrap { padding:0 24px 16px; }.composer { min-height:86px; padding:14px 14px 11px 16px; border:1px solid #d8dbe2; border-radius:10px; background:white; box-shadow:0 14px 36px #18202c12; }.composer textarea { width:100%; min-height:38px; resize:none; border:0; outline:0; color:#252832; background:transparent; font-size:12px; line-height:1.45; }.composer-footer { display:flex; align-items:center; justify-content:space-between; color:#858a96; font-size:9px; }.send { width:28px; height:28px; border:0; border-radius:7px; color:white; background:#6257d9; }.statusbar { display:flex; align-items:center; justify-content:space-between; padding:0 18px; border-top:1px solid #e2e4e9; color:#858a96; font:9px "SFMono-Regular",Consolas,monospace; }
    .inspector { display:grid; grid-template-rows:48px minmax(0,1fr) auto; border-left:1px solid #dfe2e8; }.inspector-heading { display:flex; align-items:center; justify-content:space-between; padding:0 16px; border-bottom:1px solid #dfe2e8; font-size:9px; text-transform:uppercase; }.inspector-heading strong { color:#6257d9; }.file-list { overflow:auto; padding:8px; }.file-item { display:flex; width:100%; gap:8px; padding:8px; overflow:hidden; border:0; border-radius:6px; color:#5d626e; background:transparent; text-align:left; text-overflow:ellipsis; white-space:nowrap; font:9px "SFMono-Regular",Consolas,monospace; }.file-item span { color:#8d82dd; }.file-item:hover,.file-item.active { color:#292d36; background:#e9e9f0; }.inspector-empty { padding:12px; color:#8a8f9b; font-size:10px; }.inspector-note { padding:14px 16px; border-top:1px solid #dfe2e8; font-size:10px; }.inspector-note p { margin:4px 0 0; color:#8a8f9b; font-size:9px; }
    .dialog-backdrop { position:fixed; inset:0; display:grid; place-items:center; background:#30343d52; backdrop-filter:blur(3px); z-index:10; }.dialog { width:min(430px,calc(100vw - 48px)); padding:22px; border:1px solid #d7dae1; border-radius:12px; background:white; box-shadow:0 30px 80px #18202c2b; }.dialog-heading { display:flex; align-items:flex-start; justify-content:space-between; }.dialog h2 { margin:5px 0 18px; font-size:18px; }.dialog dl { margin:0; }.dialog dl div { display:flex; justify-content:space-between; padding:11px 0; border-top:1px solid #e2e4e9; font-size:10px; }.dialog dt { color:#7d828e; }.dialog dd { margin:0; }.dialog-note { margin:16px 0 0; color:#858a96; font-size:9px; }
    @media (prefers-reduced-motion:reduce) { .spinner,.cursor { animation:none; } } @media (max-width:1120px) { .app { grid-template-columns:205px minmax(440px,1fr) 260px; }.stage { padding-inline:24px; } }
  </style><script src="./renderer-entry.js" defer></script></head><body><div id="desktop-root">${renderDesktopWorkbench(model)}</div></body></html>`;
}
