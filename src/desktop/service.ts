import fs from "node:fs";
import path from "node:path";
import { runAgent, type AgentResult, type AgentSink } from "../agent.js";
import type { Config } from "../config.js";
import { globPaths } from "../discovery.js";
import {
  loadImageAttachment,
  loadImageAttachments,
  MAX_IMAGES_PER_MESSAGE,
} from "../image-input.js";
import { collectProfileList, resolveModelProfileConfig } from "../model-profiles.js";
import { redactEndpointHost, redactSecrets } from "../permission-impact.js";
import { SessionStore, type SessionMessage } from "../session.js";
import { normalizeSessionName, sessionDisplayTitle } from "../session-name.js";
import { collectSessionSummaries } from "../session-summary.js";
import { Workspace } from "../workspace.js";
import type {
  DesktopAgentEvent,
  DesktopArchiveSessionRequest,
  DesktopAttachmentReport,
  DesktopFileDocument,
  DesktopRenameSessionRequest,
  DesktopRuntimeInfo,
  DesktopSaveUiStateRequest,
  DesktopSendMessageRequest,
  DesktopSession,
  DesktopSessionSummary,
  DesktopSessionUiEntry,
  DesktopUiState,
  DesktopWorkspaceFile,
  DesktopWriteFileRequest,
} from "./contracts.js";

const MAX_PROMPT_CHARS = 100_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_VISIBLE_FILES = 500;
const MAX_DRAFT_CHARS = 10_000;
const MAX_UI_SESSIONS = 500;
const MAX_SCROLL_TOP = 1_000_000;
// Desktop turns run with file edits pre-approved and shell tools denied until
// the Desktop grows a native approval surface; it is shown in the composer so
// the effective boundary is never implicit.
const DESKTOP_APPROVAL_MODE = "auto-edit" as const;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AgentRunner = typeof runAgent;

// On-disk shape of the Desktop UI-state file. The file is shared by every
// workspace but each entry is keyed by the workspace root, so a session's
// draft, reading position, archive flag, and last-turn outcome can never leak
// into another workspace's rail.
interface DesktopUiFile {
  version: 1;
  workspaces: Record<string, DesktopUiState>;
  // Desktop-selected model profile (#489). Null/absent means the canonical
  // default resolution (settings.defaultProfile, then the legacy model section).
  selectedProfile?: string | null;
}

export interface DesktopServiceOptions {
  workspaceRoot?: string;
  store?: SessionStore;
  run?: AgentRunner;
  resolveConfig?: () => Config;
  uiStatePath?: string;
  settingsPath?: string;
}

export class DesktopService {
  readonly workspace: Workspace;
  private readonly store: SessionStore;
  private readonly run: AgentRunner;
  private readonly resolveConfig: () => Config;
  private readonly uiStatePath: string;
  private readonly settingsPath?: string;
  private busySessionId: string | null = null;
  private turnCancelRequested = false;

  constructor(opts: DesktopServiceOptions = {}) {
    this.workspace = new Workspace(opts.workspaceRoot ?? process.cwd());
    this.store = opts.store ?? new SessionStore();
    this.run = opts.run ?? runAgent;
    this.resolveConfig =
      opts.resolveConfig ?? (() => resolveModelProfileConfig().config);
    this.settingsPath = opts.settingsPath;
    this.uiStatePath =
      opts.uiStatePath ??
      path.join(
        process.env.HOME ?? "/root",
        ".oh-my-cli",
        "desktop-ui.json",
      );
  }

  listSessions(): DesktopSessionSummary[] {
    const ui = this.readWorkspaceUi();
    return collectSessionSummaries(this.store)
      .filter(
        (summary) =>
          summary.workspace === this.workspace.root && !summary.corrupt,
      )
      .map((summary) => {
        const entry = ui.sessions[summary.id] ?? {};
        return {
          id: summary.id,
          title: this.titleFor(summary.id, summary.assistantTurns),
          messageCount: summary.messageCount,
          updatedAt: summary.lastModified,
          draft: summary.assistantTurns === 0,
          streaming: this.busySessionId === summary.id,
          failed: entry.lastTurnFailed === true,
          unread: summary.messageCount > (entry.lastSeenMessageCount ?? 0),
          archived: entry.archived === true,
        };
      });
  }

  createSession(): DesktopSession {
    const id = this.store.newId();
    this.store.writeMeta(id, {
      workspace: this.workspace.root,
      createdAt: Date.now(),
    });
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
    const assistantTurns = messages.filter(
      (message) => message.role === "assistant",
    ).length;
    return {
      id: sessionId,
      title: this.titleFor(sessionId, assistantTurns),
      messages,
    };
  }

  renameSession(request: DesktopRenameSessionRequest): DesktopSessionSummary {
    if (
      !request ||
      typeof request.sessionId !== "string" ||
      typeof request.title !== "string"
    ) {
      throw new Error("Invalid Desktop rename request");
    }
    this.assertOwnedSession(request.sessionId);
    const normalized = normalizeSessionName(request.title);
    if (!normalized.ok) throw new Error(normalized.reason);
    if (!normalized.name) throw new Error("Session title cannot be empty");
    this.store.writeName(request.sessionId, normalized.name);
    return this.summaryFor(request.sessionId);
  }

  setSessionArchived(
    request: DesktopArchiveSessionRequest,
  ): DesktopSessionSummary {
    if (
      !request ||
      typeof request.sessionId !== "string" ||
      typeof request.archived !== "boolean"
    ) {
      throw new Error("Invalid Desktop archive request");
    }
    this.assertOwnedSession(request.sessionId);
    this.mutateWorkspaceUi((ui) => {
      const entry = this.uiEntry(ui, request.sessionId);
      if (request.archived) entry.archived = true;
      else delete entry.archived;
    });
    return this.summaryFor(request.sessionId);
  }

  deleteSession(sessionId: string): { ok: boolean } {
    if (typeof sessionId !== "string") {
      throw new Error("Invalid Desktop delete request");
    }
    this.assertOwnedSession(sessionId);
    if (this.busySessionId === sessionId) {
      throw new Error("Session has a running turn");
    }
    this.store.deleteSession(sessionId);
    this.mutateWorkspaceUi((ui) => {
      delete ui.sessions[sessionId];
      if (ui.activeSessionId === sessionId) ui.activeSessionId = null;
    });
    return { ok: true };
  }

  getUiState(): DesktopUiState {
    return this.sanitizeWorkspaceUi(this.readWorkspaceUi());
  }

  saveUiState(request: DesktopSaveUiStateRequest): DesktopUiState {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid Desktop UI state request");
    }
    this.mutateWorkspaceUi((ui) => {
      if ("activeSessionId" in request) {
        const candidate = request.activeSessionId;
        ui.activeSessionId =
          typeof candidate === "string" && this.ownsSession(candidate)
            ? candidate
            : null;
      }
      if (request.sessions && typeof request.sessions === "object") {
        for (const [sessionId, entry] of Object.entries(request.sessions)) {
          if (!this.ownsSession(sessionId)) continue;
          const sanitized = this.sanitizeUiEntry(entry);
          if (Object.keys(sanitized).length === 0) continue;
          // Merge per key so saving a draft never drops the stored reading
          // position, and vice versa; service-owned keys never come from the
          // renderer, so they survive the merge untouched.
          ui.sessions[sessionId] = {
            ...(ui.sessions[sessionId] ?? {}),
            ...sanitized,
          };
        }
        const ids = Object.keys(ui.sessions);
        if (ids.length > MAX_UI_SESSIONS) {
          for (const id of ids.slice(0, ids.length - MAX_UI_SESSIONS)) {
            delete ui.sessions[id];
          }
        }
      }
    });
    return this.getUiState();
  }

  // Validate workspace-relative attachment paths before submission (#489).
  // Each path is confined and sniffed by magic bytes; failures are reported
  // per path so the composer can show honest validation state.
  attachImages(paths: string[]): DesktopAttachmentReport[] {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("No attachments provided");
    }
    if (paths.length > MAX_IMAGES_PER_MESSAGE) {
      throw new Error(
        `Too many images: ${paths.length} provided, limit is ${MAX_IMAGES_PER_MESSAGE}`,
      );
    }
    return paths.map((p) =>
      typeof p === "string"
        ? this.attachOne(p)
        : { path: "", ok: false, error: "Invalid attachment path" },
    );
  }

  // Validate files dropped into the composer (#489). Dropped paths are
  // absolute; only files inside this workspace are accepted (provenance),
  // anything outside is rejected per file without touching the rest.
  attachImageFiles(paths: string[]): DesktopAttachmentReport[] {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("No attachments provided");
    }
    if (paths.length > MAX_IMAGES_PER_MESSAGE) {
      throw new Error(
        `Too many images: ${paths.length} provided, limit is ${MAX_IMAGES_PER_MESSAGE}`,
      );
    }
    return paths.map((p) => {
      if (typeof p !== "string" || !path.isAbsolute(p)) {
        return { path: "", ok: false, error: "Dropped file path is unavailable" };
      }
      const relative = path.relative(this.workspace.root, p);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return {
          path: path.basename(p),
          ok: false,
          error: "File is outside this workspace",
        };
      }
      return this.attachOne(relative);
    });
  }

  // Effective runtime configuration for the composer (#489): the resolved
  // model/profile (never a credential), the redacted endpoint host, the
  // Desktop approval mode, and the selectable profile names.
  getRuntimeInfo(): DesktopRuntimeInfo {
    const profiles = this.availableProfiles();
    const selected = this.readSelectedProfile();
    try {
      const resolved = resolveModelProfileConfig({
        settingsPath: this.settingsPath,
        ...(selected ? { profile: selected } : {}),
      });
      return {
        model: resolved.config.model,
        profile: resolved.profile ?? null,
        approvalMode: DESKTOP_APPROVAL_MODE,
        endpointHost: redactEndpointHost(resolved.config.baseUrl),
        profiles,
      };
    } catch {
      // Truthful degradation: configuration is unavailable, say so, and never
      // leak the failing detail (it may contain endpoint or credential hints).
      return {
        model: null,
        profile: selected,
        approvalMode: DESKTOP_APPROVAL_MODE,
        endpointHost: null,
        profiles,
      };
    }
  }

  // Select the model profile used by the next turn (#489). The choice goes
  // through the canonical profile resolution on the following turn; unknown or
  // malformed selections fail closed before anything is persisted.
  setSelectedProfile(profile: string | null): DesktopRuntimeInfo {
    if (profile !== null) {
      if (typeof profile !== "string" || !profile.trim()) {
        throw new Error("Invalid profile selection");
      }
      if (!this.availableProfiles().includes(profile)) {
        throw new Error("Unknown model profile");
      }
    }
    const file = this.readUiFile();
    file.selectedProfile = profile;
    this.writeUiFile(file);
    return this.getRuntimeInfo();
  }

  private attachOne(relativePath: string): DesktopAttachmentReport {
    try {
      const image = loadImageAttachment(relativePath, this.workspace);
      return {
        path: relativePath,
        ok: true,
        name: image.name,
        mediaType: image.mediaType,
        bytes: image.bytes,
      };
    } catch (error) {
      return {
        path: relativePath,
        ok: false,
        error: redactSecrets(
          error instanceof Error ? error.message : "Attachment rejected",
        ).text,
      };
    }
  }

  private availableProfiles(): string[] {
    try {
      return collectProfileList({ settingsPath: this.settingsPath })
        .profiles.filter((entry) => !entry.disabled)
        .map((entry) => entry.profile);
    } catch {
      return [];
    }
  }

  private readSelectedProfile(): string | null {
    const file = this.readUiFile();
    return typeof file.selectedProfile === "string" && file.selectedProfile
      ? file.selectedProfile
      : null;
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
    // Attachments are validated fail-closed before the turn starts; invalid
    // input never consumes the single turn slot.
    const images =
      request.attachments && request.attachments.length > 0
        ? loadImageAttachments(request.attachments, this.workspace)
        : undefined;

    const existing = this.store.load(request.sessionId);
    const firstUserTurn = !existing.some((message) => message.role === "user");
    return this.runTurn({
      sessionId: request.sessionId,
      prompt,
      existing,
      firstUserTurn,
      images,
      appendUserMessage: true,
      emit,
    });
  }

  // Cancel the running turn of a session (#489). Cooperative: the agent loop
  // observes the flag at the next boundary, persists any streamed text as one
  // interrupted turn, and ends as cancelled. Idempotent while busy.
  cancelTurn(sessionId: string): { ok: boolean } {
    if (typeof sessionId !== "string") {
      throw new Error("Invalid Desktop cancel request");
    }
    this.assertOwnedSession(sessionId);
    if (this.busySessionId !== sessionId) {
      throw new Error("No turn is running for this session");
    }
    this.turnCancelRequested = true;
    return { ok: true };
  }

  // Retry the session's most recent turn (#489). Reuses one request identity:
  // the persisted user message stays singular because the retry run does not
  // append another one.
  async retryTurn(
    sessionId: string,
    emit: (event: DesktopAgentEvent) => void,
  ): Promise<{ ok: boolean }> {
    if (typeof sessionId !== "string") {
      throw new Error("Invalid Desktop retry request");
    }
    this.assertOwnedSession(sessionId);
    if (this.busySessionId)
      throw new Error("Another Desktop turn is already running");
    const existing = this.store.load(sessionId);
    const lastUser = [...existing]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUser || typeof lastUser.content !== "string") {
      throw new Error("Nothing to retry in this session");
    }
    return this.runTurn({
      sessionId,
      prompt: lastUser.content,
      existing,
      firstUserTurn: false,
      images: undefined,
      appendUserMessage: false,
      emit,
    });
  }

  private async runTurn(opts: {
    sessionId: string;
    prompt: string;
    existing: SessionMessage[];
    firstUserTurn: boolean;
    images?: ReturnType<typeof loadImageAttachments>;
    appendUserMessage: boolean;
    emit: (event: DesktopAgentEvent) => void;
  }): Promise<{ ok: boolean }> {
    const { sessionId, prompt, existing, firstUserTurn, images, emit } = opts;
    this.busySessionId = sessionId;
    this.turnCancelRequested = false;
    emit({
      type: "status",
      sessionId,
      message: "Connecting to Qwen",
    });

    const sink: AgentSink = {
      assistantDelta: (delta) =>
        emit({ type: "assistant-delta", sessionId, delta }),
      assistantTurn: () => {},
      toolStart: ({ name }) => emit({ type: "tool-start", sessionId, name }),
      toolResult: ({ name, result }) =>
        emit({ type: "tool-result", sessionId, name, ok: !result.isError }),
      providerError: (message) =>
        emit({ type: "error", sessionId, message: redactSecrets(message).text }),
      usage: () => {},
      retry: ({ attempt, maxAttempts }) =>
        emit({
          type: "status",
          sessionId,
          message: `Retrying provider ${attempt}/${maxAttempts}`,
        }),
      compaction: ({ summarizedMessages }) =>
        emit({
          type: "status",
          sessionId,
          message: `Compacted ${summarizedMessages} messages`,
        }),
      requestApproval: async () => false,
    };

    let result: AgentResult;
    try {
      result = await this.run(prompt, existing, {
        config: this.resolveConfig(),
        workspace: this.workspace,
        approvalMode: DESKTOP_APPROVAL_MODE,
        sessionId,
        onMessage: (message) => this.store.append(sessionId, message),
        sink,
        ...(images ? { images } : {}),
        appendUserMessage: opts.appendUserMessage,
        cancelRequested: () =>
          this.turnCancelRequested && this.busySessionId === sessionId,
      });
      if (result.reason === "cancelled") {
        // A cancelled turn keeps its partial transcript but is neither a
        // completed nor a failed turn: no title, no failed badge.
        emit({ type: "cancelled", sessionId });
        emit({ type: "complete", sessionId, ok: false });
        return { ok: false };
      }
      // A stable title is earned by the first *completed* turn only; a failed
      // or interrupted first turn leaves the session in its draft state.
      if (firstUserTurn && result.ok) this.nameFromPrompt(sessionId, prompt);
      this.recordTurnOutcome(sessionId, result.ok);
      emit({ type: "complete", sessionId, ok: result.ok });
      return { ok: result.ok };
    } catch (error) {
      this.recordTurnOutcome(sessionId, false);
      const message = redactSecrets(
        error instanceof Error ? error.message : "Desktop agent turn failed",
      ).text;
      emit({ type: "error", sessionId, message });
      emit({ type: "complete", sessionId, ok: false });
      throw new Error(message);
    } finally {
      this.busySessionId = null;
      this.turnCancelRequested = false;
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
    if (!this.ownsSession(sessionId)) {
      throw new Error("Unknown Desktop session");
    }
    const meta = this.store.readMeta(sessionId);
    if (meta?.workspace !== this.workspace.root) {
      throw new Error("Session belongs to a different workspace");
    }
  }

  private ownsSession(sessionId: string): boolean {
    return (
      typeof sessionId === "string" &&
      SESSION_ID.test(sessionId) &&
      this.store.listIds().includes(sessionId) &&
      this.store.readMeta(sessionId)?.workspace === this.workspace.root
    );
  }

  private titleFor(sessionId: string, assistantTurns: number): string {
    const name = this.store.readName(sessionId);
    if (name) {
      return sessionDisplayTitle({ name, shortId: sessionId.slice(0, 8) });
    }
    // Drafts have no user-owned name yet; show the neutral draft title until
    // the first completed turn (or an explicit rename) provides one.
    if (assistantTurns === 0) return "New session";
    return sessionDisplayTitle({ name: null, shortId: sessionId.slice(0, 8) });
  }

  private summaryFor(sessionId: string): DesktopSessionSummary {
    const summary = this.listSessions().find((item) => item.id === sessionId);
    if (!summary) throw new Error("Unknown Desktop session");
    return summary;
  }

  private nameFromPrompt(sessionId: string, prompt: string): void {
    // Never overwrite a name the user already chose explicitly.
    if (this.store.readName(sessionId)) return;
    const candidate = prompt.replace(/\s+/g, " ").slice(0, 56);
    const normalized = normalizeSessionName(candidate);
    if (normalized.ok && normalized.name)
      this.store.writeName(sessionId, normalized.name);
  }

  private recordTurnOutcome(sessionId: string, ok: boolean): void {
    try {
      this.mutateWorkspaceUi((ui) => {
        const entry = this.uiEntry(ui, sessionId);
        if (ok) delete entry.lastTurnFailed;
        else entry.lastTurnFailed = true;
      });
    } catch {
      // Turn-outcome bookkeeping is advisory; a failure here must never mask
      // the turn's real result or break the streaming path.
    }
  }

  private uiEntry(
    ui: DesktopUiState,
    sessionId: string,
  ): DesktopSessionUiEntry {
    const entry = ui.sessions[sessionId] ?? {};
    ui.sessions[sessionId] = entry;
    return entry;
  }

  // Read the shared UI-state file fail-soft: a missing, unreadable, or
  // malformed file degrades to an empty state rather than breaking the rail.
  private readUiFile(): DesktopUiFile {
    const empty: DesktopUiFile = { version: 1, workspaces: {} };
    let raw: string;
    try {
      raw = fs.readFileSync(this.uiStatePath, "utf-8");
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DesktopUiFile>;
      if (
        parsed.version !== 1 ||
        !parsed.workspaces ||
        typeof parsed.workspaces !== "object"
      ) {
        return empty;
      }
      return {
        version: 1,
        workspaces: parsed.workspaces as DesktopUiFile["workspaces"],
        ...(parsed.selectedProfile === null ||
        typeof parsed.selectedProfile === "string"
          ? { selectedProfile: parsed.selectedProfile }
          : {}),
      };
    } catch {
      return empty;
    }
  }

  private writeUiFile(file: DesktopUiFile): void {
    fs.mkdirSync(path.dirname(this.uiStatePath), { recursive: true });
    const temporaryPath = `${this.uiStatePath}.oh-my-cli-desktop-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(file)}\n`, "utf-8");
      fs.renameSync(temporaryPath, this.uiStatePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  private readWorkspaceUi(): DesktopUiState {
    const file = this.readUiFile();
    const workspace = file.workspaces[this.workspace.root];
    if (
      !workspace ||
      typeof workspace !== "object" ||
      !workspace.sessions ||
      typeof workspace.sessions !== "object"
    ) {
      return { activeSessionId: null, sessions: {} };
    }
    return {
      activeSessionId:
        typeof workspace.activeSessionId === "string"
          ? workspace.activeSessionId
          : null,
      sessions: workspace.sessions,
    };
  }

  private mutateWorkspaceUi(
    mutate: (ui: DesktopUiState) => void,
  ): DesktopUiState {
    const file = this.readUiFile();
    const ui = this.readWorkspaceUi();
    mutate(ui);
    file.workspaces[this.workspace.root] = ui;
    this.writeUiFile(file);
    return ui;
  }

  // Return the workspace UI state with stale references removed: an active
  // session that no longer exists (or belongs elsewhere) reads as none.
  private sanitizeWorkspaceUi(ui: DesktopUiState): DesktopUiState {
    return {
      activeSessionId:
        ui.activeSessionId && this.ownsSession(ui.activeSessionId)
          ? ui.activeSessionId
          : null,
      sessions: ui.sessions,
    };
  }

  // Keep only renderer-owned keys with bounded, well-typed values. Service-owned
  // fields (archived, lastTurnFailed) are dropped so the renderer can never
  // forge lifecycle truth.
  private sanitizeUiEntry(entry: unknown): DesktopSessionUiEntry {
    if (!entry || typeof entry !== "object") return {};
    const candidate = entry as Record<string, unknown>;
    const sanitized: DesktopSessionUiEntry = {};
    if (typeof candidate.draft === "string") {
      sanitized.draft = candidate.draft.slice(0, MAX_DRAFT_CHARS);
    }
    if (
      typeof candidate.scrollTop === "number" &&
      Number.isFinite(candidate.scrollTop) &&
      candidate.scrollTop >= 0
    ) {
      sanitized.scrollTop = Math.min(candidate.scrollTop, MAX_SCROLL_TOP);
    }
    if (
      typeof candidate.lastSeenMessageCount === "number" &&
      Number.isInteger(candidate.lastSeenMessageCount) &&
      candidate.lastSeenMessageCount >= 0
    ) {
      sanitized.lastSeenMessageCount = candidate.lastSeenMessageCount;
    }
    return sanitized;
  }
}
