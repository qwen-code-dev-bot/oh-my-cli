export const DESKTOP_CHANNELS = Object.freeze({
  getBootstrapState: "desktop:get-bootstrap-state",
  getWorkspaceStatus: "desktop:get-workspace-status",
  listRecents: "desktop:list-recents",
  forgetWorkspace: "desktop:forget-workspace",
  openWorkspaceDialog: "desktop:open-workspace-dialog",
  switchWorkspace: "desktop:switch-workspace",
  listSessions: "desktop:list-sessions",
  createSession: "desktop:create-session",
  loadSession: "desktop:load-session",
  renameSession: "desktop:rename-session",
  setSessionArchived: "desktop:set-session-archived",
  deleteSession: "desktop:delete-session",
  sendMessage: "desktop:send-message",
  cancelTurn: "desktop:cancel-turn",
  retryTurn: "desktop:retry-turn",
  attachImages: "desktop:attach-images",
  attachImageFiles: "desktop:attach-image-files",
  getRuntimeInfo: "desktop:get-runtime-info",
  setSelectedProfile: "desktop:set-selected-profile",
  getUiState: "desktop:get-ui-state",
  saveUiState: "desktop:save-ui-state",
  listWorkspaceFiles: "desktop:list-workspace-files",
  listWorkspaceDirectory: "desktop:list-workspace-directory",
  searchWorkspaceFiles: "desktop:search-workspace-files",
  createWorkspaceFile: "desktop:create-workspace-file",
  renameWorkspaceFile: "desktop:rename-workspace-file",
  deleteWorkspaceFile: "desktop:delete-workspace-file",
  getWorkspaceDiff: "desktop:get-workspace-diff",
  getWorkspaceFileDiff: "desktop:get-workspace-file-diff",
  readWorkspaceFile: "desktop:read-workspace-file",
  writeWorkspaceFile: "desktop:write-workspace-file",
  agentEvent: "desktop:agent-event",
  workspaceSwitched: "desktop:workspace-switched",
});

export type DesktopChannel =
  (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS];

export interface DesktopBootstrapState {
  platform: NodeJS.Platform;
  version: string;
  workspaceName: string;
}

/** One recent workspace entry (#491). Paths are canonical (realpath). */
export interface DesktopRecentWorkspace {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface DesktopWorkspaceGitStatus {
  branch: string;
  head: string;
  dirtyCount: number;
}

/**
 * Active-workspace posture for the workbench (#491): canonical path, display
 * name, and honest Git state (null when the workspace is not a repository).
 */
export interface DesktopWorkspaceStatus {
  path: string;
  name: string;
  git: DesktopWorkspaceGitStatus | null;
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

/**
 * Persisted editor tab for reload recovery (#490). The baseline content lives
 * on disk and is re-read on restore; only bounded editor state survives here.
 */
export interface DesktopEditorTabState {
  path: string;
  scrollTop?: number;
  dirty?: boolean;
  /** Unsaved content for dirty tabs, bounded; absent tabs reload from disk. */
  draft?: string;
}

export interface DesktopUiState {
  activeSessionId: string | null;
  sessions: Record<string, DesktopSessionUiEntry>;
  editorTabs?: DesktopEditorTabState[];
  activeEditorTab?: string | null;
  /** Persisted primary view so reload restores the layout (#491). */
  activeView?: string | null;
}

export interface DesktopSaveUiStateRequest {
  activeSessionId?: string | null;
  sessions?: Record<string, DesktopSessionUiEntry>;
  editorTabs?: DesktopEditorTabState[];
  activeEditorTab?: string | null;
  activeView?: string | null;
}

export interface DesktopWorkspaceFile {
  path: string;
}

export interface DesktopFileDocument {
  path: string;
  content: string;
  bytes: number;
  /**
   * Content fingerprint at read time (#490). A save carrying the fingerprint
   * fails closed when the file changed on disk since, so external edits are
   * never silently overwritten.
   */
  revision: string;
}

/** One entry of the lazy workspace tree (#490). Symlinks are reported but never followed. */
export interface DesktopTreeEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface DesktopListDirectoryResult {
  base: string;
  entries: DesktopTreeEntry[];
  totalEntries: number;
  truncated: boolean;
}

export interface DesktopRenameFileRequest {
  from: string;
  to: string;
}

/** One changed file in the Git working tree (#490). */
export interface DesktopDiffFile {
  path: string;
  /** Porcelain status code (M, A, D, R, ?? ...), truthfully passed through. */
  status: string;
}

export interface DesktopWorkspaceDiff {
  git: boolean;
  files: DesktopDiffFile[];
  truncated: boolean;
}

export interface DesktopFileDiff {
  path: string;
  patch: string;
  truncated: boolean;
}

export type DesktopAgentEvent =
  | { type: "assistant-delta"; sessionId: string; delta: string }
  | { type: "tool-start"; sessionId: string; name: string }
  | { type: "tool-result"; sessionId: string; name: string; ok: boolean }
  | { type: "status"; sessionId: string; message: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "cancelled"; sessionId: string }
  | { type: "complete"; sessionId: string; ok: boolean }
  | { type: "workspace-switched"; path: string; name: string };

export interface DesktopSendMessageRequest {
  sessionId: string;
  prompt: string;
  /** Workspace-relative image paths, pre-validated and re-validated at send. */
  attachments?: string[];
}

/**
 * Validation outcome for one staged attachment (#489). Ok entries carry the
 * privacy-safe reference (name, media type, size); failed entries carry a
 * secret-safe reason so the composer can show validation state before submit.
 */
export interface DesktopAttachmentReport {
  path: string;
  ok: boolean;
  name?: string;
  mediaType?: string;
  bytes?: number;
  error?: string;
}

/**
 * Effective runtime configuration shown in the composer (#489). Carries no
 * credential values; the endpoint is reduced to its redacted host.
 */
export interface DesktopRuntimeInfo {
  model: string | null;
  profile: string | null;
  approvalMode: string;
  endpointHost: string | null;
  profiles: string[];
}

export interface DesktopWriteFileRequest {
  path: string;
  content: string;
  /** When present, the save fails closed if the on-disk content moved on. */
  expectedRevision?: string;
}

export interface DesktopBridge {
  getBootstrapState(): Promise<DesktopBootstrapState>;
  getWorkspaceStatus(): Promise<DesktopWorkspaceStatus>;
  listRecents(): Promise<DesktopRecentWorkspace[]>;
  forgetWorkspace(path: string): Promise<DesktopRecentWorkspace[]>;
  openWorkspaceDialog(): Promise<DesktopWorkspaceStatus | null>;
  switchWorkspace(path: string): Promise<DesktopWorkspaceStatus>;
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
  cancelTurn(sessionId: string): Promise<{ ok: boolean }>;
  retryTurn(sessionId: string): Promise<{ ok: boolean }>;
  attachImages(paths: string[]): Promise<DesktopAttachmentReport[]>;
  attachImageFiles(paths: string[]): Promise<DesktopAttachmentReport[]>;
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  setSelectedProfile(profile: string | null): Promise<DesktopRuntimeInfo>;
  getUiState(): Promise<DesktopUiState>;
  saveUiState(request: DesktopSaveUiStateRequest): Promise<DesktopUiState>;
  listWorkspaceFiles(): Promise<DesktopWorkspaceFile[]>;
  listWorkspaceDirectory(path: string): Promise<DesktopListDirectoryResult>;
  searchWorkspaceFiles(query: string): Promise<DesktopWorkspaceFile[]>;
  createWorkspaceFile(path: string): Promise<DesktopFileDocument>;
  renameWorkspaceFile(
    request: DesktopRenameFileRequest,
  ): Promise<DesktopFileDocument>;
  deleteWorkspaceFile(path: string): Promise<{ ok: boolean }>;
  getWorkspaceDiff(): Promise<DesktopWorkspaceDiff>;
  getWorkspaceFileDiff(path: string): Promise<DesktopFileDiff>;
  readWorkspaceFile(path: string): Promise<DesktopFileDocument>;
  writeWorkspaceFile(
    request: DesktopWriteFileRequest,
  ): Promise<DesktopFileDocument>;
  /** Resolve a dropped File to a filesystem path (Electron preload only). */
  getPathForFile(file: File): string;
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
  pathForFile?: (file: File) => string,
): DesktopBridge {
  return Object.freeze({
    getBootstrapState: () =>
      invoke(
        DESKTOP_CHANNELS.getBootstrapState,
      ) as Promise<DesktopBootstrapState>,
    getWorkspaceStatus: () =>
      invoke(
        DESKTOP_CHANNELS.getWorkspaceStatus,
      ) as Promise<DesktopWorkspaceStatus>,
    listRecents: () =>
      invoke(DESKTOP_CHANNELS.listRecents) as Promise<
        DesktopRecentWorkspace[]
      >,
    forgetWorkspace: (workspacePath: string) =>
      invoke(
        DESKTOP_CHANNELS.forgetWorkspace,
        workspacePath,
      ) as Promise<DesktopRecentWorkspace[]>,
    openWorkspaceDialog: () =>
      invoke(DESKTOP_CHANNELS.openWorkspaceDialog) as Promise<
        DesktopWorkspaceStatus | null
      >,
    switchWorkspace: (workspacePath: string) =>
      invoke(
        DESKTOP_CHANNELS.switchWorkspace,
        workspacePath,
      ) as Promise<DesktopWorkspaceStatus>,
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
    cancelTurn: (sessionId: string) =>
      invoke(DESKTOP_CHANNELS.cancelTurn, sessionId) as Promise<{ ok: boolean }>,
    retryTurn: (sessionId: string) =>
      invoke(DESKTOP_CHANNELS.retryTurn, sessionId) as Promise<{ ok: boolean }>,
    attachImages: (paths: string[]) =>
      invoke(
        DESKTOP_CHANNELS.attachImages,
        paths,
      ) as Promise<DesktopAttachmentReport[]>,
    attachImageFiles: (paths: string[]) =>
      invoke(
        DESKTOP_CHANNELS.attachImageFiles,
        paths,
      ) as Promise<DesktopAttachmentReport[]>,
    getRuntimeInfo: () =>
      invoke(DESKTOP_CHANNELS.getRuntimeInfo) as Promise<DesktopRuntimeInfo>,
    setSelectedProfile: (profile: string | null) =>
      invoke(
        DESKTOP_CHANNELS.setSelectedProfile,
        profile,
      ) as Promise<DesktopRuntimeInfo>,
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
    listWorkspaceDirectory: (dirPath: string) =>
      invoke(
        DESKTOP_CHANNELS.listWorkspaceDirectory,
        dirPath,
      ) as Promise<DesktopListDirectoryResult>,
    searchWorkspaceFiles: (query: string) =>
      invoke(
        DESKTOP_CHANNELS.searchWorkspaceFiles,
        query,
      ) as Promise<DesktopWorkspaceFile[]>,
    createWorkspaceFile: (filePath: string) =>
      invoke(
        DESKTOP_CHANNELS.createWorkspaceFile,
        filePath,
      ) as Promise<DesktopFileDocument>,
    renameWorkspaceFile: (request: DesktopRenameFileRequest) =>
      invoke(
        DESKTOP_CHANNELS.renameWorkspaceFile,
        request,
      ) as Promise<DesktopFileDocument>,
    deleteWorkspaceFile: (filePath: string) =>
      invoke(
        DESKTOP_CHANNELS.deleteWorkspaceFile,
        filePath,
      ) as Promise<{ ok: boolean }>,
    getWorkspaceDiff: () =>
      invoke(DESKTOP_CHANNELS.getWorkspaceDiff) as Promise<DesktopWorkspaceDiff>,
    getWorkspaceFileDiff: (filePath: string) =>
      invoke(
        DESKTOP_CHANNELS.getWorkspaceFileDiff,
        filePath,
      ) as Promise<DesktopFileDiff>,
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
    getPathForFile: (file: File) => {
      if (!pathForFile) throw new Error("File path resolution is unavailable");
      return pathForFile(file);
    },
    onAgentEvent: (listener: (event: DesktopAgentEvent) => void) =>
      subscribe(DESKTOP_CHANNELS.agentEvent, listener),
  });
}
