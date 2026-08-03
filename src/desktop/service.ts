import fs from "node:fs";
import path from "node:path";
import { runAgent, type AgentResult, type AgentSink } from "../agent.js";
import type { Config } from "../config.js";
import { globPaths } from "../discovery.js";
import { resolveModelProfileConfig } from "../model-profiles.js";
import { redactSecrets } from "../permission-impact.js";
import { SessionStore, type SessionMessage } from "../session.js";
import { normalizeSessionName, sessionDisplayTitle } from "../session-name.js";
import { collectSessionSummaries } from "../session-summary.js";
import { Workspace } from "../workspace.js";
import type {
  DesktopAgentEvent,
  DesktopFileDocument,
  DesktopSendMessageRequest,
  DesktopSession,
  DesktopSessionSummary,
  DesktopWorkspaceFile,
  DesktopWriteFileRequest,
} from "./contracts.js";

const MAX_PROMPT_CHARS = 100_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_VISIBLE_FILES = 500;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AgentRunner = typeof runAgent;

export interface DesktopServiceOptions {
  workspaceRoot?: string;
  store?: SessionStore;
  run?: AgentRunner;
  resolveConfig?: () => Config;
}

export class DesktopService {
  readonly workspace: Workspace;
  private readonly store: SessionStore;
  private readonly run: AgentRunner;
  private readonly resolveConfig: () => Config;
  private busySessionId: string | null = null;

  constructor(opts: DesktopServiceOptions = {}) {
    this.workspace = new Workspace(opts.workspaceRoot ?? process.cwd());
    this.store = opts.store ?? new SessionStore();
    this.run = opts.run ?? runAgent;
    this.resolveConfig =
      opts.resolveConfig ?? (() => resolveModelProfileConfig().config);
  }

  listSessions(): DesktopSessionSummary[] {
    return collectSessionSummaries(this.store)
      .filter(
        (summary) =>
          summary.workspace === this.workspace.root && !summary.corrupt,
      )
      .map((summary) => ({
        id: summary.id,
        title: this.titleFor(summary.id),
        messageCount: summary.messageCount,
        updatedAt: summary.lastModified,
      }));
  }

  createSession(): DesktopSession {
    const id = this.store.newId();
    this.store.writeMeta(id, {
      workspace: this.workspace.root,
      createdAt: Date.now(),
    });
    this.store.writeName(id, "New session");
    return { id, title: "New session", messages: [] };
  }

  loadSession(sessionId: string): DesktopSession {
    this.assertOwnedSession(sessionId);
    const messages = this.store
      .load(sessionId)
      .filter(
        (
          message,
        ): message is SessionMessage & {
          role: "user" | "assistant";
          content: string;
        } =>
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string",
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.interrupted ? { interrupted: true } : {}),
      }));
    return { id: sessionId, title: this.titleFor(sessionId), messages };
  }

  async sendMessage(
    request: DesktopSendMessageRequest,
    emit: (event: DesktopAgentEvent) => void,
  ): Promise<{ ok: boolean }> {
    if (
      !request ||
      typeof request.sessionId !== "string" ||
      typeof request.prompt !== "string"
    ) {
      throw new Error("Invalid Desktop message request");
    }
    this.assertOwnedSession(request.sessionId);
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Message cannot be empty");
    if (prompt.length > MAX_PROMPT_CHARS)
      throw new Error("Message is too large");
    if (this.busySessionId)
      throw new Error("Another Desktop turn is already running");

    const existing = this.store.load(request.sessionId);
    const firstUserTurn = !existing.some((message) => message.role === "user");
    this.busySessionId = request.sessionId;
    emit({
      type: "status",
      sessionId: request.sessionId,
      message: "Connecting to Qwen",
    });

    const sink: AgentSink = {
      assistantDelta: (delta) =>
        emit({ type: "assistant-delta", sessionId: request.sessionId, delta }),
      assistantTurn: () => {},
      toolStart: ({ name }) =>
        emit({ type: "tool-start", sessionId: request.sessionId, name }),
      toolResult: ({ name, result }) =>
        emit({
          type: "tool-result",
          sessionId: request.sessionId,
          name,
          ok: !result.isError,
        }),
      providerError: (message) =>
        emit({
          type: "error",
          sessionId: request.sessionId,
          message: redactSecrets(message).text,
        }),
      usage: () => {},
      retry: ({ attempt, maxAttempts }) =>
        emit({
          type: "status",
          sessionId: request.sessionId,
          message: `Retrying provider ${attempt}/${maxAttempts}`,
        }),
      compaction: ({ summarizedMessages }) =>
        emit({
          type: "status",
          sessionId: request.sessionId,
          message: `Compacted ${summarizedMessages} messages`,
        }),
      requestApproval: async () => false,
    };

    let result: AgentResult;
    try {
      result = await this.run(prompt, existing, {
        config: this.resolveConfig(),
        workspace: this.workspace,
        approvalMode: "auto-edit",
        sessionId: request.sessionId,
        onMessage: (message) => this.store.append(request.sessionId, message),
        sink,
      });
      if (firstUserTurn) this.nameFromPrompt(request.sessionId, prompt);
      emit({ type: "complete", sessionId: request.sessionId, ok: result.ok });
      return { ok: result.ok };
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.message : "Desktop agent turn failed",
      ).text;
      emit({ type: "error", sessionId: request.sessionId, message });
      emit({ type: "complete", sessionId: request.sessionId, ok: false });
      throw new Error(message);
    } finally {
      this.busySessionId = null;
    }
  }

  listWorkspaceFiles(): DesktopWorkspaceFile[] {
    const result = globPaths(this.workspace, { pattern: "**/*", ignore: true });
    const files: DesktopWorkspaceFile[] = [];
    for (const relativePath of result.matches) {
      if (files.length >= MAX_VISIBLE_FILES) break;
      try {
        const absolutePath = this.workspace.resolveSafe(relativePath);
        if (fs.lstatSync(absolutePath).isFile())
          files.push({ path: relativePath });
      } catch {
        // A file can disappear during discovery; omit it rather than failing the list.
      }
    }
    return files;
  }

  readWorkspaceFile(relativePath: string): DesktopFileDocument {
    const absolutePath = this.regularFile(relativePath);
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.byteLength > MAX_FILE_BYTES)
      throw new Error("File exceeds the 1 MiB Desktop editor limit");
    if (buffer.includes(0))
      throw new Error("Binary files cannot be edited in Desktop");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("File is not valid UTF-8 text");
    }
    return { path: relativePath, content, bytes: buffer.byteLength };
  }

  writeWorkspaceFile(request: DesktopWriteFileRequest): DesktopFileDocument {
    if (
      !request ||
      typeof request.path !== "string" ||
      typeof request.content !== "string"
    ) {
      throw new Error("Invalid Desktop file request");
    }
    const absolutePath = this.regularFile(request.path);
    const bytes = Buffer.byteLength(request.content, "utf-8");
    if (bytes > MAX_FILE_BYTES)
      throw new Error("File exceeds the 1 MiB Desktop editor limit");
    const temporaryPath = `${absolutePath}.oh-my-cli-desktop-${process.pid}.tmp`;
    const mode = fs.statSync(absolutePath).mode;
    try {
      fs.writeFileSync(temporaryPath, request.content, {
        encoding: "utf-8",
        mode,
      });
      fs.renameSync(temporaryPath, absolutePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    return { path: request.path, content: request.content, bytes };
  }

  private regularFile(relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("A workspace-relative file path is required");
    }
    const absolutePath = this.workspace.resolveSafe(relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      throw new Error(`File does not exist: ${relativePath}`);
    }
    if (!stat.isFile()) throw new Error(`Not a regular file: ${relativePath}`);
    return absolutePath;
  }

  private assertOwnedSession(sessionId: string): void {
    if (
      !SESSION_ID.test(sessionId) ||
      !this.store.listIds().includes(sessionId)
    ) {
      throw new Error("Unknown Desktop session");
    }
    const meta = this.store.readMeta(sessionId);
    if (meta?.workspace !== this.workspace.root) {
      throw new Error("Session belongs to a different workspace");
    }
  }

  private titleFor(sessionId: string): string {
    return sessionDisplayTitle({
      name: this.store.readName(sessionId),
      shortId: sessionId.slice(0, 8),
    });
  }

  private nameFromPrompt(sessionId: string, prompt: string): void {
    const candidate = prompt.replace(/\s+/g, " ").slice(0, 56);
    const normalized = normalizeSessionName(candidate);
    if (normalized.ok && normalized.name)
      this.store.writeName(sessionId, normalized.name);
  }
}
