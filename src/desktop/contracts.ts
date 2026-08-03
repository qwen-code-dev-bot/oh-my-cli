export const DESKTOP_CHANNELS = Object.freeze({
  getBootstrapState: "desktop:get-bootstrap-state",
  listSessions: "desktop:list-sessions",
  createSession: "desktop:create-session",
  loadSession: "desktop:load-session",
  renameSession: "desktop:rename-session",
  setSessionArchived: "desktop:set-session-archived",
  deleteSession: "desktop:delete-session",
  sendMessage: "desktop:send-message",
  getUiState: "desktop:get-ui-state",
  saveUiState: "desktop:save-ui-state",
  listWorkspaceFiles: "desktop:list-workspace-files",
  readWorkspaceFile: "desktop:read-workspace-file",
  writeWorkspaceFile: "desktop:write-workspace-file",
  agentEvent: "desktop:agent-event",
});

export type DesktopChannel =
  (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS];

export interface DesktopBootstrapState {
  platform: NodeJS.Platform;
  version: string;
  workspaceName: string;
}

export interface DesktopSessionSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  /** True until the first completed turn persists a stable title baseline. */
  draft: boolean;
  /** True while this session's agent turn is streaming right now. */
  streaming: boolean;
  /** True when the session's most recent turn failed. */
  failed: boolean;
  /** True when turns completed since the session was last read. */
  unread: boolean;
  /** True when the session is hidden from the default rail view. */
  archived: boolean;
}

export interface DesktopTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  interrupted?: boolean;
}

export interface DesktopSession {
  id: string;
  title: string;
  messages: DesktopTranscriptMessage[];
}

export interface DesktopRenameSessionRequest {
  sessionId: string;
  title: string;
}

export interface DesktopArchiveSessionRequest {
  sessionId: string;
  archived: boolean;
}

/**
 * Workspace-scoped Desktop UI state per session. Drafts, reading position, and
 * the read-watermark are renderer-owned and persist across switches and
 * reloads. `archived` and `lastTurnFailed` are service-owned: the renderer
 * reads them through summaries, and its writes to those keys are ignored.
 */
export interface DesktopSessionUiEntry {
  draft?: string;
  scrollTop?: number;
  lastSeenMessageCount?: number;
  archived?: boolean;
  lastTurnFailed?: boolean;
}

export interface DesktopUiState {
  activeSessionId: string | null;
  sessions: Record<string, DesktopSessionUiEntry>;
}

export interface DesktopSaveUiStateRequest {
  activeSessionId?: string | null;
  sessions?: Record<string, DesktopSessionUiEntry>;
}

export interface DesktopWorkspaceFile {
  path: string;
}

export interface DesktopFileDocument {
  path: string;
  content: string;
  bytes: number;
}

export type DesktopAgentEvent =
  | { type: "assistant-delta"; sessionId: string; delta: string }
  | { type: "tool-start"; sessionId: string; name: string }
  | { type: "tool-result"; sessionId: string; name: string; ok: boolean }
  | { type: "status"; sessionId: string; message: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "complete"; sessionId: string; ok: boolean };

export interface DesktopSendMessageRequest {
  sessionId: string;
  prompt: string;
}

export interface DesktopWriteFileRequest {
  path: string;
  content: string;
}

export interface DesktopBridge {
  getBootstrapState(): Promise<DesktopBootstrapState>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  createSession(): Promise<DesktopSession>;
  loadSession(sessionId: string): Promise<DesktopSession>;
  renameSession(
    request: DesktopRenameSessionRequest,
  ): Promise<DesktopSessionSummary>;
  setSessionArchived(
    request: DesktopArchiveSessionRequest,
  ): Promise<DesktopSessionSummary>;
  deleteSession(sessionId: string): Promise<{ ok: boolean }>;
  sendMessage(request: DesktopSendMessageRequest): Promise<{ ok: boolean }>;
  getUiState(): Promise<DesktopUiState>;
  saveUiState(request: DesktopSaveUiStateRequest): Promise<DesktopUiState>;
  listWorkspaceFiles(): Promise<DesktopWorkspaceFile[]>;
  readWorkspaceFile(path: string): Promise<DesktopFileDocument>;
  writeWorkspaceFile(
    request: DesktopWriteFileRequest,
  ): Promise<DesktopFileDocument>;
  onAgentEvent(listener: (event: DesktopAgentEvent) => void): () => void;
}

export type DesktopInvoker = (
  channel: DesktopChannel,
  ...args: unknown[]
) => Promise<unknown>;

export type DesktopSubscriber = (
  channel: typeof DESKTOP_CHANNELS.agentEvent,
  listener: (event: DesktopAgentEvent) => void,
) => () => void;

export function createDesktopBridge(
  invoke: DesktopInvoker,
  subscribe: DesktopSubscriber,
): DesktopBridge {
  return Object.freeze({
    getBootstrapState: () =>
      invoke(
        DESKTOP_CHANNELS.getBootstrapState,
      ) as Promise<DesktopBootstrapState>,
    listSessions: () =>
      invoke(DESKTOP_CHANNELS.listSessions) as Promise<DesktopSessionSummary[]>,
    createSession: () =>
      invoke(DESKTOP_CHANNELS.createSession) as Promise<DesktopSession>,
    loadSession: (sessionId: string) =>
      invoke(
        DESKTOP_CHANNELS.loadSession,
        sessionId,
      ) as Promise<DesktopSession>,
    renameSession: (request: DesktopRenameSessionRequest) =>
      invoke(
        DESKTOP_CHANNELS.renameSession,
        request,
      ) as Promise<DesktopSessionSummary>,
    setSessionArchived: (request: DesktopArchiveSessionRequest) =>
      invoke(
        DESKTOP_CHANNELS.setSessionArchived,
        request,
      ) as Promise<DesktopSessionSummary>,
    deleteSession: (sessionId: string) =>
      invoke(
        DESKTOP_CHANNELS.deleteSession,
        sessionId,
      ) as Promise<{ ok: boolean }>,
    sendMessage: (request: DesktopSendMessageRequest) =>
      invoke(DESKTOP_CHANNELS.sendMessage, request) as Promise<{ ok: boolean }>,
    getUiState: () => invoke(DESKTOP_CHANNELS.getUiState) as Promise<DesktopUiState>,
    saveUiState: (request: DesktopSaveUiStateRequest) =>
      invoke(
        DESKTOP_CHANNELS.saveUiState,
        request,
      ) as Promise<DesktopUiState>,
    listWorkspaceFiles: () =>
      invoke(DESKTOP_CHANNELS.listWorkspaceFiles) as Promise<
        DesktopWorkspaceFile[]
      >,
    readWorkspaceFile: (path: string) =>
      invoke(
        DESKTOP_CHANNELS.readWorkspaceFile,
        path,
      ) as Promise<DesktopFileDocument>,
    writeWorkspaceFile: (request: DesktopWriteFileRequest) =>
      invoke(
        DESKTOP_CHANNELS.writeWorkspaceFile,
        request,
      ) as Promise<DesktopFileDocument>,
    onAgentEvent: (listener: (event: DesktopAgentEvent) => void) =>
      subscribe(DESKTOP_CHANNELS.agentEvent, listener),
  });
}
