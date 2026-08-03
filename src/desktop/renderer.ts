import type {
  DesktopAgentEvent,
  DesktopAttachmentReport,
  DesktopBootstrapState,
  DesktopFileDocument,
  DesktopRuntimeInfo,
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
  sessionSearch: string;
  showArchived: boolean;
  renaming: boolean;
  confirmDeleteId?: string;
  cancelling: boolean;
  turnOutcome: DesktopTurnOutcome;
  attachments: DesktopAttachmentReport[];
  attachPickerOpen: boolean;
  runtime: DesktopRuntimeInfo | null;
}

export type DesktopTurnOutcome = "idle" | "ok" | "failed" | "cancelled";

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
  | { type: "select-session"; session: DesktopSession; preserveNotice?: boolean }
  | { type: "clear-session" }
  | { type: "set-session-search"; value: string }
  | { type: "set-show-archived"; show: boolean }
  | { type: "set-renaming"; renaming: boolean }
  | { type: "confirm-delete"; sessionId?: string }
  | { type: "set-cancelling"; cancelling: boolean }
  | { type: "set-attachments"; attachments: DesktopAttachmentReport[] }
  | { type: "attach-picker"; open: boolean }
  | { type: "set-runtime"; runtime: DesktopRuntimeInfo | null }
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
    sessionSearch: "",
    showArchived: false,
    renaming: false,
    cancelling: false,
    turnOutcome: "idle",
    attachments: [],
    attachPickerOpen: false,
    runtime: null,
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
        // A turn-adoption reload keeps the just-set outcome notice ("Turn
        // cancelled", "Turn complete"); a user-initiated switch clears it.
        notice: action.preserveNotice ? state.notice : undefined,
        error: undefined,
        renaming: false,
        confirmDeleteId: undefined,
        cancelling: false,
        turnOutcome: action.preserveNotice ? state.turnOutcome : "idle",
        attachments: [],
        attachPickerOpen: false,
      };
    case "clear-session":
      return {
        ...state,
        activeSession: undefined,
        streamingText: "",
        activity: [],
        notice: undefined,
        renaming: false,
        confirmDeleteId: undefined,
        cancelling: false,
        turnOutcome: "idle",
        attachments: [],
        attachPickerOpen: false,
      };
    case "set-session-search":
      return { ...state, sessionSearch: action.value };
    case "set-show-archived":
      return { ...state, showArchived: action.show };
    case "set-renaming":
      return state.activeSession
        ? { ...state, renaming: action.renaming }
        : state;
    case "confirm-delete":
      return { ...state, confirmDeleteId: action.sessionId };
    case "set-cancelling":
      return { ...state, cancelling: action.cancelling };
    case "set-attachments":
      return { ...state, attachments: action.attachments };
    case "attach-picker":
      return { ...state, attachPickerOpen: action.open };
    case "set-runtime":
      return { ...state, runtime: action.runtime };
    case "optimistic-user":
      if (!state.activeSession) return state;
      return {
        ...state,
        turnOutcome: "idle",
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
      return action.busy
        ? { ...state, busy: true, turnOutcome: "idle", cancelling: false }
        : { ...state, busy: false };
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
      if (action.event.type === "cancelled") {
        return {
          ...state,
          busy: false,
          cancelling: false,
          notice: "Turn cancelled",
          turnOutcome: "cancelled",
        };
      }
      // A complete(ok:false) that follows a cancelled event must not rewrite
      // the cancellation as a generic failure.
      const cancelledNow = state.turnOutcome === "cancelled" && !action.event.ok;
      return {
        ...state,
        busy: false,
        cancelling: false,
        notice: cancelledNow
          ? "Turn cancelled"
          : action.event.ok
            ? "Turn complete"
            : "Turn failed",
        turnOutcome: action.event.ok
          ? "ok"
          : cancelledNow
            ? "cancelled"
            : "failed",
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

export function filterSessions(
  sessions: DesktopSessionSummary[],
  opts: { search: string; archived: boolean },
): DesktopSessionSummary[] {
  const query = opts.search.trim().toLowerCase();
  return sessions.filter((session) => {
    if (session.archived !== opts.archived) return false;
    if (!query) return true;
    return session.title.toLowerCase().includes(query);
  });
}

type DesktopSessionStatus =
  | "streaming"
  | "failed"
  | "draft"
  | "unread"
  | "idle";

function sessionStatus(session: DesktopSessionSummary): DesktopSessionStatus {
  if (session.streaming) return "streaming";
  if (session.failed) return "failed";
  if (session.draft) return "draft";
  if (session.unread) return "unread";
  return "idle";
}

const STATUS_BADGE: Record<DesktopSessionStatus, string> = {
  streaming:
    '<span class="session-badge badge-streaming" aria-label="Streaming">●</span>',
  failed:
    '<span class="session-badge badge-failed" aria-label="Failed">!</span>',
  draft: '<span class="session-badge badge-draft" aria-label="Draft">✎</span>',
  unread:
    '<span class="session-badge badge-unread" aria-label="Unread">•</span>',
  idle: "",
};

export function renderSessionRail(model: DesktopViewModel): string {
  const visible = filterSessions(model.sessions, {
    search: model.sessionSearch,
    archived: model.showArchived,
  });
  if (visible.length === 0) {
    if (model.sessions.length === 0)
      return `<p class="rail-empty">No sessions yet</p>`;
    return `<p class="rail-empty">${model.showArchived ? "No archived sessions match" : "No sessions match"}</p>`;
  }
  return visible
    .map((session) => {
      const active = session.id === model.activeSession?.id;
      const status = sessionStatus(session);
      return `<button class="rail-item session-item ${active ? "active" : ""}" type="button" data-session-id="${escapeHtml(session.id)}" data-status="${status}"${session.archived ? ' data-archived="true"' : ""}${active ? ' aria-current="true"' : ""}><span class="rail-icon">›_</span><span>${escapeHtml(session.title)}</span><span class="session-meta">${STATUS_BADGE[status]}<small>${session.messageCount}</small></span></button>`;
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

function renderDeleteConfirm(model: DesktopViewModel): string {
  if (!model.confirmDeleteId) return "";
  const target = model.sessions.find(
    (session) => session.id === model.confirmDeleteId,
  );
  const title = target?.title ?? model.activeSession?.title ?? "this session";
  return `<div class="dialog-backdrop" data-dialog-backdrop="true"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-session-title"><div class="dialog-heading"><div><p class="eyebrow">Destructive action</p><h2 id="delete-session-title">Delete “${escapeHtml(title)}”?</h2></div></div><p class="dialog-note">The transcript, draft, and reading position are removed from this device. This cannot be undone.</p><div class="dialog-actions"><button class="secondary-button" type="button" data-action="cancel-delete">Cancel</button><button class="danger-button" type="button" data-action="confirm-delete-session">Delete session</button></div></section></div>`;
}

function activeSummary(model: DesktopViewModel): DesktopSessionSummary | undefined {
  return model.sessions.find(
    (session) => session.id === model.activeSession?.id,
  );
}

// A finishing turn may only pull the workbench back to its own session when
// the user is still there. Otherwise the completion is background truth
// (summary refresh, unread badge) and must never steal focus from the session
// the user moved to while the turn was running.
export function shouldAdoptCompletedSession(
  state: Pick<DesktopRuntimeState, "activeSession">,
  completedSessionId: string,
): boolean {
  return state.activeSession?.id === completedSessionId;
}

function sessionStatusLine(model: DesktopViewModel): string {
  if (model.busy) return "Qwen is working";
  // Fresh notices (saved file, completed turn) outrank the static lifecycle
  // state; the lifecycle truth returns once the notice is cleared.
  if (model.notice) return model.notice;
  const summary = activeSummary(model);
  if (summary?.streaming) return "Streaming";
  if (summary?.failed) return "Last turn failed";
  if (summary?.draft) return "Draft · send the first message";
  return "Issue #488 · session lifecycle";
}

function renderAttachmentChip(attachment: DesktopAttachmentReport): string {
  const label = attachment.ok
    ? `${attachment.name ?? attachment.path} · ${attachment.mediaType ?? "unknown"} · ${attachment.bytes ?? 0} B · workspace`
    : `${attachment.name || attachment.path} — ${attachment.error ?? "rejected"}`;
  return `<span class="attachment-chip ${attachment.ok ? "" : "is-error"}" data-attachment-path="${escapeHtml(attachment.path)}" title="${escapeHtml(label)}">${escapeHtml(label)}<button class="chip-remove" type="button" data-action="remove-attachment" aria-label="Remove attachment ${escapeHtml(attachment.name || attachment.path)}">×</button></span>`;
}

function renderRuntimeControls(model: DesktopViewModel): string {
  const runtime = model.runtime;
  if (!runtime) {
    return `<span class="runtime-chip" data-runtime-chip="unavailable">Runtime unavailable</span>`;
  }
  const profilePart = runtime.profile ? ` · profile ${runtime.profile}` : "";
  const hostPart = runtime.endpointHost ? ` · ${runtime.endpointHost}` : "";
  const detail = `${runtime.model ?? "Model unavailable"}${profilePart} · approvals: ${runtime.approvalMode}${hostPart}`;
  const chip = `<span class="runtime-chip" data-runtime-chip="${runtime.model ? "ready" : "degraded"}" title="${escapeHtml(detail)}">${escapeHtml(runtime.model ?? "Model unavailable")} · ${escapeHtml(runtime.approvalMode)}</span>`;
  if (runtime.profiles.length < 2) return chip;
  const options = runtime.profiles
    .map(
      (profile) =>
        `<option value="${escapeHtml(profile)}"${profile === runtime.profile ? " selected" : ""}>${escapeHtml(profile)}</option>`,
    )
    .join("");
  return `${chip}<select class="profile-select" aria-label="Model profile"><option value=""${runtime.profile ? "" : " selected"}>Default profile</option>${options}</select>`;
}

function renderAttachPicker(model: DesktopViewModel): string {
  if (!model.attachPickerOpen) return "";
  const candidates = model.files.filter((file) =>
    /\.(png|jpe?g|gif|webp)$/i.test(file.path),
  );
  const list = candidates.length
    ? candidates
        .map(
          (file) =>
            `<button class="attach-option" type="button" data-attach-file-path="${escapeHtml(file.path)}">${escapeHtml(file.path)}</button>`,
        )
        .join("")
    : `<p class="rail-empty">No image files in this workspace</p>`;
  return `<div class="dialog-backdrop" data-dialog-backdrop="true"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="attach-picker-title"><div class="dialog-heading"><div><p class="eyebrow">Workspace images</p><h2 id="attach-picker-title">Attach an image</h2></div><button class="icon-button" type="button" aria-label="Close attachment picker" data-action="close-attach-picker">×</button></div><div class="attach-list">${list}</div><p class="dialog-note">Only files from this workspace are listed. Content is verified by magic bytes (PNG, JPEG, GIF, WebP, up to 20 MiB), never by extension; invalid picks are rejected with a reason before submission.</p></section></div>`;
}

export function renderDesktopWorkbench(model: DesktopViewModel): string {
  const platform = platformLabel(model.bootstrap?.platform);
  const version = model.bootstrap?.version ?? "—";
  const canSend =
    Boolean(model.activeSession) && !model.busy && model.phase === "ready";
  const summary = activeSummary(model);
  const archivedCount = model.sessions.filter((s) => s.archived).length;
  const archivedToggle =
    archivedCount > 0 || model.showArchived
      ? `<button class="archived-toggle" type="button" data-action="toggle-archived" aria-pressed="${model.showArchived}">${model.showArchived ? "Hide archived" : `Archived (${archivedCount})`}</button>`
      : "";
  const titleBlock =
    model.renaming && model.activeSession
      ? `<div class="title-edit"><input class="rename-input" type="text" aria-label="Rename session" value="${escapeHtml(model.activeSession.title)}" data-session-id="${escapeHtml(model.activeSession.id)}" spellcheck="false"><small>Enter saves · Esc cancels</small></div>`
      : `<div><strong>${escapeHtml(model.activeSession?.title ?? "Local agent workbench")}</strong><small>${escapeHtml(sessionStatusLine(model))}</small></div>`;
  const sessionActions = model.activeSession
    ? `<div class="session-actions"><button class="ghost-button" type="button" data-action="rename-session">Rename</button><button class="ghost-button" type="button" data-action="${summary?.archived ? "restore-session" : "archive-session"}">${summary?.archived ? "Restore" : "Archive"}</button><button class="ghost-button is-danger" type="button" aria-label="Delete session" data-action="request-delete-session">Delete</button></div>`
    : "";
  const attachmentTray = model.attachments.length
    ? `<div class="attachment-tray" aria-label="Staged attachments">${model.attachments.map(renderAttachmentChip).join("")}</div>`
    : "";
  const canAttach =
    Boolean(model.activeSession) && !model.busy && model.phase === "ready";
  const cancelControl =
    model.activeSession && model.busy
      ? `<button class="ghost-button is-danger" type="button" data-action="cancel-turn" aria-label="Cancel turn"${model.cancelling ? " disabled" : ""}>${model.cancelling ? "Cancelling…" : "Cancel"}</button>`
      : "";
  const retryControl =
    model.activeSession &&
    !model.busy &&
    (model.turnOutcome === "failed" || model.turnOutcome === "cancelled")
      ? `<button class="ghost-button" type="button" data-action="retry-turn" aria-label="Retry last turn">Retry</button>`
      : "";
  return `<div class="app" data-workbench-state="${model.phase}" data-agent-busy="${model.busy}">
    <header class="titlebar"><span></span><strong>Oh My CLI</strong><span class="runtime-status ${model.phase === "ready" ? "is-ready" : ""}"><i></i>${escapeHtml(platform)}</span></header>
    <nav class="rail" aria-label="Projects and sessions">
      <div class="brand"><span class="mark">OM</span><span>Oh My CLI</span></div>
      <div class="section-heading"><p class="section-label">Workspace</p></div>
      <button class="rail-item workspace-item" type="button"><span class="rail-icon">□</span><span>${escapeHtml(model.bootstrap?.workspaceName ?? "Local workspace")}</span><small>local</small></button>
      <div class="section-heading"><p class="section-label">Sessions</p><button class="new-session" type="button" aria-label="New session" data-action="new-session">＋</button></div>
      <input class="session-search" type="search" aria-label="Search sessions" placeholder="Search sessions" value="${escapeHtml(model.sessionSearch)}"${model.sessions.length > 0 ? "" : " disabled"}>
      <div class="session-list">${renderSessionRail(model)}</div>
      ${archivedToggle}
      <div class="rail-footer"><span class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></span><div><strong>${model.phase === "ready" ? "Desktop connected" : "Desktop starting"}</strong><small>${model.sessions.length} persisted session${model.sessions.length === 1 ? "" : "s"}</small></div></div>
    </nav>
    <main class="workbench" aria-label="Agent workbench">
      <div class="workspace-bar">${titleBlock}<div class="tabs" role="tablist" aria-label="Primary workbench views">${tab("chat", "Chat", model.activeView)}${tab("workflow", "Activity", model.activeView)}${tab("changes", "Files", model.activeView)}</div><div class="workspace-bar-actions">${sessionActions}<button class="icon-button" type="button" aria-label="Open diagnostics" data-action="open-diagnostics">•••</button></div></div>
      ${model.error ? `<div class="error-banner" role="alert">${escapeHtml(model.error)}<button type="button" data-action="dismiss-error">×</button></div>` : ""}
      <section class="stage" role="tabpanel" aria-live="polite">${renderStage(model)}</section>
      <div class="composer-wrap" data-fixed-composer="true"><form class="composer" aria-label="Message composer">${attachmentTray}<textarea rows="2" aria-label="Message" placeholder="${model.activeSession ? "Ask Qwen to inspect, explain, or change this workspace" : "Create or select a session to start"}" ${canSend ? "" : "disabled"}></textarea><div class="composer-footer"><span class="composer-side"><button class="ghost-button" type="button" data-action="open-attach-picker" aria-label="Attach image" ${canAttach ? "" : "disabled"}>Attach image</button><span class="composer-hint">⌘K focus · Enter send · Shift+Enter newline</span></span><span class="composer-side">${renderRuntimeControls(model)}${retryControl}${cancelControl}<button class="send" type="submit" aria-label="Send message" ${canSend ? "" : "disabled"}>↵</button></span></div></form></div>
      <footer class="statusbar"><span><i class="connection-dot ${model.phase === "ready" ? "is-ready" : ""}"></i>${model.busy ? "Agent turn running" : "Secure bridge ready"}</span><span>${escapeHtml(platform)} · ${escapeHtml(version)}</span></footer>
    </main>
    <aside class="inspector" aria-label="Context inspector"><div class="inspector-heading"><span>Workspace files</span><strong>${model.files.length}</strong></div><div class="file-list">${renderFiles(model)}</div><div class="inspector-note"><strong>Safe local editor</strong><p>UTF-8 text only · 1 MiB max · path confined</p></div></aside>
    ${renderDiagnostics(model)}
    ${renderDeleteConfirm(model)}
    ${renderAttachPicker(model)}
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
    .rail-item { display:grid; grid-template-columns:18px minmax(0,1fr) auto; align-items:center; width:100%; gap:8px; padding:10px 9px; border:0; border-radius:7px; color:#505562; background:transparent; text-align:left; font-size:11px; }.rail-item span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.rail-item.active { color:#252832; background:#e8e8ef; box-shadow:inset 3px 0 #6257d9; }.rail-item small { color:#9297a2; font-size:9px; }.workspace-item { background:#eef0f5; }.rail-icon { color:#747985; font-family:"SFMono-Regular",Consolas,monospace; }.session-list { max-height:calc(100vh - 320px); overflow:auto; }.rail-empty { margin:8px; color:#9a9eaa; font-size:10px; }
    .session-search { width:calc(100% - 8px); margin:4px 4px 6px; padding:6px 9px; border:1px solid #dfe2e8; border-radius:6px; color:#252832; background:white; font-size:10px; outline:0; }.session-search:focus-visible { outline:2px solid #6257d9; outline-offset:2px; }
    .session-meta { display:inline-flex; align-items:center; gap:4px; }.session-badge { font-size:9px; line-height:1; }.badge-streaming { color:#0d9f5b; }.badge-failed { color:#c0392b; font-weight:700; }.badge-draft { color:#8a8f9b; }.badge-unread { color:#6257d9; font-weight:700; }.session-item[data-archived="true"] { opacity:.72; }
    .archived-toggle { width:calc(100% - 8px); margin:6px 4px; padding:6px 9px; border:0; border-radius:6px; color:#747985; background:transparent; text-align:left; font-size:9px; letter-spacing:.08em; text-transform:uppercase; }.archived-toggle:hover { background:#e6e7ec; }
    .workspace-bar-actions { display:flex; align-items:center; gap:6px; justify-self:end; }.session-actions { display:flex; gap:4px; }.ghost-button { padding:5px 8px; border:1px solid #d5d8df; border-radius:6px; color:#5f6470; background:white; font-size:9px; }.ghost-button:hover { background:#f1f2f6; }.ghost-button.is-danger { color:#9b2727; border-color:#e5b8b8; }.ghost-button.is-danger:hover { background:#fff1f1; }
    .title-edit { min-width:0; }.rename-input { width:240px; padding:5px 8px; border:1px solid #6257d9; border-radius:6px; font-size:12px; outline:0; }.title-edit small { display:block; margin-top:3px; color:#858a96; font-family:"SFMono-Regular",Consolas,monospace; font-size:9px; }
    .dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }.danger-button { padding:8px 13px; border:1px solid #c0392b; border-radius:7px; color:white; background:#c0392b; font-size:10px; }.danger-button:hover { background:#a93226; }
    .composer-side { display:flex; align-items:center; gap:8px; }.composer-hint { color:#858a96; font-size:9px; }.runtime-chip { padding:3px 7px; border:1px solid #e2e4e9; border-radius:6px; color:#5f6470; background:#f5f6f8; font:9px "SFMono-Regular",Consolas,monospace; }.runtime-chip[data-runtime-chip="degraded"] { color:#9b2727; border-color:#e5b8b8; }.profile-select { max-width:130px; padding:3px 5px; border:1px solid #d8dbe2; border-radius:6px; color:#5f6470; background:white; font-size:9px; }
    .attachment-tray { display:flex; flex-wrap:wrap; gap:6px; padding:0 0 8px; }.attachment-chip { display:inline-flex; align-items:center; gap:6px; max-width:340px; padding:4px 8px; border:1px solid #d5d8df; border-radius:6px; color:#505562; background:#f5f6f8; font-size:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.attachment-chip.is-error { color:#9b2727; border-color:#e5b8b8; background:#fff1f1; }.chip-remove { border:0; color:inherit; background:transparent; font-size:10px; padding:0 2px; }
    .attach-list { max-height:260px; overflow:auto; display:flex; flex-direction:column; gap:4px; }.attach-option { padding:8px 10px; border:1px solid #e2e4e9; border-radius:6px; color:#505562; background:white; text-align:left; font:9px "SFMono-Regular",Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.attach-option:hover { background:#f1f2f6; }
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
