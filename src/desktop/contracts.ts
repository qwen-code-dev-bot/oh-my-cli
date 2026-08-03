export const DESKTOP_CHANNELS = Object.freeze({
  getBootstrapState: "desktop:get-bootstrap-state",
  listSessions: "desktop:list-sessions",
  createSession: "desktop:create-session",
  loadSession: "desktop:load-session",
  sendMessage: "desktop:send-message",
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
  sendMessage(request: DesktopSendMessageRequest): Promise<{ ok: boolean }>;
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
    sendMessage: (request: DesktopSendMessageRequest) =>
      invoke(DESKTOP_CHANNELS.sendMessage, request) as Promise<{ ok: boolean }>,
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
