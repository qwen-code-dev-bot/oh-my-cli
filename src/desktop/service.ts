import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { runAgent, type AgentResult, type AgentSink } from "../agent.js";
import type { Config } from "../config.js";
import { globPaths, listDirectory } from "../discovery.js";
import {
  loadImageAttachment,
  loadImageAttachments,
  MAX_IMAGES_PER_MESSAGE,
} from "../image-input.js";
import { collectProfileList, resolveModelProfileConfig } from "../model-profiles.js";
import { loadWorkspaceEnv } from "../workspace-env.js";
import { redactEndpointHost, redactSecrets } from "../permission-impact.js";
import { SessionStore, type SessionMessage } from "../session.js";
import { normalizeSessionName, sessionDisplayTitle } from "../session-name.js";
import { collectSessionSummaries } from "../session-summary.js";
import { Workspace } from "../workspace.js";
import type {
  DesktopAgentEvent,
  DesktopArchiveSessionRequest,
  DesktopAttachmentReport,
  DesktopDiffFile,
  DesktopEditorTabState,
  DesktopFileDiff,
  DesktopFileDocument,
  DesktopListDirectoryResult,
  DesktopRecentWorkspace,
  DesktopRenameFileRequest,
  DesktopRenameSessionRequest,
  DesktopRuntimeInfo,
  DesktopSaveUiStateRequest,
  DesktopSendMessageRequest,
  DesktopSession,
  DesktopSessionSummary,
  DesktopSessionUiEntry,
  DesktopUiState,
  DesktopWorkspaceDiff,
  DesktopWorkspaceFile,
  DesktopWorkspaceStatus,
  DesktopWriteFileRequest,
} from "./contracts.js";

const MAX_PROMPT_CHARS = 100_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_VISIBLE_FILES = 500;
const MAX_DRAFT_CHARS = 10_000;
const MAX_UI_SESSIONS = 500;
const MAX_SCROLL_TOP = 1_000_000;
// Bounded coding-workflow surfaces (#490): search results, diff file list,
// per-file patch size, untracked preview, and persisted editor tabs.
const MAX_SEARCH_RESULTS = 50;
const MAX_DIFF_FILES = 100;
const MAX_DIFF_PATCH_BYTES = 100_000;
const MAX_DIFF_UNTRACKED_LINES = 1000;
const MAX_EDITOR_TABS = 20;
const MAX_TAB_DRAFT_CHARS = 100_000;
const MAX_TREE_PATH_CHARS = 512;
const MAX_RECENT_WORKSPACES = 8;
const MAX_DIRTY_COUNT = 500;
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

// Recent-workspace registry file (#491): global to the Desktop app, shared by
// every workspace. Paths are canonical so a moved or symlinked folder never
// opens twice.
interface DesktopRecentsFile {
  version: 1;
  workspaces: DesktopRecentWorkspace[];
  lastWorkspacePath: string | null;
}

// Resolve a workspace root through symlinks so session ownership, recents,
// and switched services all agree on one canonical identity (#491). Falls
// back to the raw path when it cannot be resolved.
function canonicalWorkspaceRoot(requested: string): string {
  try {
    return fs.realpathSync(requested);
  } catch {
    return requested;
  }
}

export interface DesktopServiceOptions {
  workspaceRoot?: string;
  store?: SessionStore;
  run?: AgentRunner;
  resolveConfig?: () => Config;
  uiStatePath?: string;
  settingsPath?: string;
  recentsPath?: string;
}

export class DesktopService {
  readonly workspace: Workspace;
  private readonly store: SessionStore;
  private readonly run: AgentRunner;
  private readonly resolveConfig: () => Config;
  private readonly uiStatePath: string;
  private readonly settingsPath?: string;
  private readonly recentsPath: string;
  private busySessionId: string | null = null;
  private turnCancelRequested = false;

  constructor(opts: DesktopServiceOptions = {}) {
    this.workspace = new Workspace(
      canonicalWorkspaceRoot(opts.workspaceRoot ?? process.cwd()),
    );
    this.store = opts.store ?? new SessionStore();
    this.run = opts.run ?? runAgent;
    this.resolveConfig =
      opts.resolveConfig ??
      (() =>
        resolveModelProfileConfig({
          // Issue #509: a trusted workspace's `.env` feeds model-config
          // resolution as the layer under the real environment.
          workspaceEnv: loadWorkspaceEnv({ workspacePath: this.workspace.root }),
        }).config);
    this.settingsPath = opts.settingsPath;
    this.uiStatePath =
      opts.uiStatePath ??
      path.join(
        process.env.HOME ?? "/root",
        ".oh-my-cli",
        "desktop-ui.json",
      );
    this.recentsPath =
      opts.recentsPath ??
      path.join(
        process.env.HOME ?? "/root",
        ".oh-my-cli",
        "desktop-recents.json",
      );
  }

  // --- Workspace entry and recovery (#491) ----------------------------------

  // Resolve a requested workspace folder to its canonical path, fail-closed:
  // the target must exist, resolve through symlinks, and be a directory.
  canonicalWorkspacePath(requested: string): string {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new Error("A workspace path is required");
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(requested);
    } catch {
      throw new Error(`Workspace not found: ${requested}`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`Not a directory: ${requested}`);
    }
    return canonical;
  }

  // Startup selection: the last valid workspace wins; a stale or missing path
  // falls back to the default rather than failing the app.
  static startupWorkspaceRoot(opts: { recentsPath?: string } = {}): string {
    const recentsPath =
      opts.recentsPath ??
      path.join(
        process.env.HOME ?? "/root",
        ".oh-my-cli",
        "desktop-recents.json",
      );
    const file = DesktopService.readRecentsFile(recentsPath);
    const last = file.lastWorkspacePath;
    if (last) {
      try {
        const canonical = fs.realpathSync(last);
        if (fs.statSync(canonical).isDirectory()) return canonical;
      } catch {
        // Stale entry: fall through to the default.
      }
    }
    return process.cwd();
  }

  getWorkspaceStatus(): DesktopWorkspaceStatus {
    const name =
      this.workspace.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
    const status: DesktopWorkspaceStatus = {
      path: this.workspace.root,
      name,
      git: null,
    };
    if (!this.isGitWorkTree()) return status;
    const branch = this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], 4096);
    const head = this.runGit(["rev-parse", "--short", "HEAD"], 4096);
    const porcelain = this.runGit(
      ["status", "--porcelain"],
      MAX_DIRTY_COUNT * 512,
    );
    const dirtyCount = porcelain.ok
      ? Math.min(
          porcelain.stdout.split("\n").filter((l) => l.trim().length >= 4)
            .length,
          MAX_DIRTY_COUNT,
        )
      : 0;
    status.git = {
      branch: branch.ok ? branch.stdout.trim() || "HEAD" : "HEAD",
      head: head.ok ? head.stdout.trim() : "",
      dirtyCount,
    };
    return status;
  }

  listRecents(): DesktopRecentWorkspace[] {
    return this.readRecents().workspaces;
  }

  // Record a successful open/switch so restarts can recover it. The recorded
  // path is canonical so symlinked folders never appear twice in recents.
  markWorkspaceOpened(): void {
    let canonical = this.workspace.root;
    try {
      canonical = fs.realpathSync(canonical);
    } catch {
      // Keep the raw root if it cannot be resolved.
    }
    const name =
      canonical.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
    const file = this.readRecents();
    const remaining = file.workspaces.filter((w) => w.path !== canonical);
    file.workspaces = [
      { path: canonical, name, lastOpenedAt: Date.now() },
      ...remaining,
    ].slice(0, MAX_RECENT_WORKSPACES);
    file.lastWorkspacePath = canonical;
    this.writeRecents(file);
  }

  // Remove an entry from recents; forgetting the last workspace clears the
  // restart target so the app never resurrects an unwanted folder.
  forgetWorkspace(requested: string): DesktopRecentWorkspace[] {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new Error("A workspace path is required");
    }
    let canonical = requested;
    try {
      canonical = fs.realpathSync(requested);
    } catch {
      // Already deleted: match the raw recorded path instead.
    }
    const file = this.readRecents();
    file.workspaces = file.workspaces.filter(
      (w) => w.path !== canonical && w.path !== requested,
    );
    if (file.lastWorkspacePath === canonical) {
      file.lastWorkspacePath = file.workspaces[0]?.path ?? null;
    }
    this.writeRecents(file);
    return file.workspaces;
  }

  private readRecents(): DesktopRecentsFile {
    return DesktopService.readRecentsFile(this.recentsPath);
  }

  private static readRecentsFile(recentsPath: string): DesktopRecentsFile {
    const empty: DesktopRecentsFile = {
      version: 1,
      workspaces: [],
      lastWorkspacePath: null,
    };
    let raw: string;
    try {
      raw = fs.readFileSync(recentsPath, "utf-8");
    } catch {
      return empty;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DesktopRecentsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
        return empty;
      }
      const workspaces = parsed.workspaces
        .filter(
          (w): w is DesktopRecentWorkspace =>
            Boolean(w) &&
            typeof w === "object" &&
            typeof (w as DesktopRecentWorkspace).path === "string" &&
            typeof (w as DesktopRecentWorkspace).name === "string" &&
            typeof (w as DesktopRecentWorkspace).lastOpenedAt === "number",
        )
        .slice(0, MAX_RECENT_WORKSPACES);
      return {
        version: 1,
        workspaces,
        lastWorkspacePath:
          typeof parsed.lastWorkspacePath === "string"
            ? parsed.lastWorkspacePath
            : null,
      };
    } catch {
      return empty;
    }
  }

  private writeRecents(file: DesktopRecentsFile): void {
    fs.mkdirSync(path.dirname(this.recentsPath), { recursive: true });
    const temporaryPath = `${this.recentsPath}.oh-my-cli-desktop-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(file)}\n`, "utf-8");
      fs.renameSync(temporaryPath, this.recentsPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
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
      if (Array.isArray(request.editorTabs)) {
        ui.editorTabs = request.editorTabs
          .slice(0, MAX_EDITOR_TABS)
          .map((tab) => this.sanitizeEditorTab(tab))
          .filter((tab): tab is DesktopEditorTabState => tab !== null);
      }
      if ("activeEditorTab" in request) {
        const candidate = request.activeEditorTab;
        ui.activeEditorTab =
          typeof candidate === "string" &&
          candidate.length <= MAX_TREE_PATH_CHARS
            ? candidate
            : null;
      }
      if ("activeView" in request) {
        const candidate = request.activeView;
        ui.activeView =
          candidate === "chat" ||
          candidate === "workflow" ||
          candidate === "changes"
            ? candidate
            : null;
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
  // anything outside is rejected per file without touching the rest. Both
  // sides are canonical so symlinked roots compare honestly.
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
      let incoming = p;
      try {
        incoming = fs.realpathSync(p);
      } catch {
        // Missing files keep their raw path; the read below reports them.
      }
      const relative = path.relative(this.workspace.root, incoming);
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
        // Issue #509: a trusted workspace's `.env` participates in resolution.
        workspaceEnv: loadWorkspaceEnv({ workspacePath: this.workspace.root }),
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

  // True while any turn is streaming; workspace switching refuses to run
  // underneath an in-flight mutation (#491).
  busyTurnRunning(): boolean {
    return this.busySessionId !== null;
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

  // One directory level of the lazy workspace tree (#490). Ignore rules apply;
  // symlinks are reported but never followed or expanded.
  listWorkspaceDirectory(relativePath: string): DesktopListDirectoryResult {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      relativePath = ".";
    }
    const result = listDirectory(this.workspace, {
      path: relativePath,
      ignore: true,
    });
    return {
      base: result.base,
      entries: result.entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
      })),
      totalEntries: result.totalEntries,
      truncated: result.truncated,
    };
  }

  // Bounded substring search across the visible workspace files (#490).
  searchWorkspaceFiles(query: string): DesktopWorkspaceFile[] {
    if (typeof query !== "string") return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.listWorkspaceFiles()
      .filter((file) => file.path.toLowerCase().includes(needle))
      .slice(0, MAX_SEARCH_RESULTS);
  }

  // Create a new empty UTF-8 file (#490). Fails closed when the target exists
  // or its parent directory does not — nothing is created optimistically.
  createWorkspaceFile(relativePath: string): DesktopFileDocument {
    this.assertValidNewPath(relativePath);
    const absolutePath = this.workspace.resolveSafe(relativePath);
    const parent = path.dirname(absolutePath);
    let parentStat: fs.Stats;
    try {
      parentStat = fs.statSync(parent);
    } catch {
      throw new Error(
        `Parent directory does not exist: ${path.dirname(relativePath)}`,
      );
    }
    if (!parentStat.isDirectory()) {
      throw new Error(
        `Parent is not a directory: ${path.dirname(relativePath)}`,
      );
    }
    try {
      fs.writeFileSync(absolutePath, "", { encoding: "utf-8", flag: "wx" });
    } catch {
      throw new Error(`File already exists: ${relativePath}`);
    }
    return this.readWorkspaceFile(relativePath);
  }

  // Rename/move a file inside the workspace (#490). The target must not exist
  // and its parent must exist; symlinks are never renamed through.
  renameWorkspaceFile(request: DesktopRenameFileRequest): DesktopFileDocument {
    if (
      !request ||
      typeof request.from !== "string" ||
      typeof request.to !== "string" ||
      !request.to.trim()
    ) {
      throw new Error("Invalid Desktop rename request");
    }
    const fromAbsolute = this.regularFile(request.from);
    this.assertValidNewPath(request.to);
    const toAbsolute = this.workspace.resolveSafe(request.to);
    try {
      fs.lstatSync(toAbsolute);
      throw new Error(`File already exists: ${request.to}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(toAbsolute);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error(
        `Parent directory does not exist: ${path.dirname(request.to)}`,
      );
    }
    fs.renameSync(fromAbsolute, toAbsolute);
    return this.readWorkspaceFile(request.to);
  }

  // Delete one regular file with an explicit, confined target (#490).
  deleteWorkspaceFile(relativePath: string): { ok: boolean } {
    const absolutePath = this.regularFile(relativePath);
    fs.unlinkSync(absolutePath);
    return { ok: true };
  }

  // Real Git working-tree change list for the diff view (#490). Honest about
  // non-Git workspaces; bounded; confined to this workspace when it is nested
  // inside a larger repository.
  getWorkspaceDiff(): DesktopWorkspaceDiff {
    if (!this.isGitWorkTree()) return { git: false, files: [], truncated: false };
    const status = this.runGit(
      ["status", "--porcelain"],
      MAX_DIFF_FILES * 512,
    );
    if (!status.ok) return { git: false, files: [], truncated: false };
    const toplevel = this.gitToplevel();
    const files: DesktopDiffFile[] = [];
    let truncated = false;
    for (const line of status.stdout.split("\n")) {
      if (line.trim().length < 4) continue;
      const code = line.slice(0, 2).trim() || "?";
      let repoPath = line.slice(3);
      const arrow = repoPath.indexOf(" -> ");
      if (arrow >= 0) repoPath = repoPath.slice(arrow + 4);
      if (repoPath.startsWith('"') && repoPath.endsWith('"')) {
        repoPath = JSON.parse(repoPath) as string;
      }
      const workspacePath = this.repoPathToWorkspace(repoPath, toplevel);
      if (!workspacePath) continue;
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
      files.push({ path: workspacePath, status: code });
    }
    return { git: true, files, truncated };
  }

  // The patch for one file (#490): `git diff HEAD` for tracked changes
  // (staged and unstaged together — the real working-tree patch), a bounded
  // all-added preview for untracked files, and a truthful cap.
  getWorkspaceFileDiff(relativePath: string): DesktopFileDiff {
    if (!this.isGitWorkTree()) throw new Error("Not a Git repository");
    const workspacePath = this.regularOrMissingFile(relativePath);
    const porcelain = this.runGit(
      ["status", "--porcelain", "--", this.workspacePathToRepo(workspacePath)],
      4096,
    );
    const line = porcelain.ok
      ? porcelain.stdout.split("\n").find((l) => l.trim().length >= 4)
      : undefined;
    const untracked = line !== undefined && line.slice(0, 2) === "??";
    if (untracked) {
      return this.untrackedPreview(workspacePath);
    }
    const diff = this.runGit(
      ["diff", "HEAD", "--no-color", "--", this.workspacePathToRepo(workspacePath)],
      MAX_DIFF_PATCH_BYTES * 2,
    );
    if (!diff.ok) throw new Error("Unable to read the Git diff");
    const patch = diff.stdout.slice(0, MAX_DIFF_PATCH_BYTES);
    return {
      path: workspacePath,
      patch,
      truncated: diff.stdout.length > MAX_DIFF_PATCH_BYTES,
    };
  }

  private untrackedPreview(workspacePath: string): DesktopFileDiff {
    const absolutePath = this.regularFile(workspacePath);
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.byteLength > MAX_FILE_BYTES || buffer.includes(0)) {
      return {
        path: workspacePath,
        patch: `(binary or oversized file — ${buffer.byteLength} bytes, not previewed)`,
        truncated: false,
      };
    }
    const lines = buffer.toString("utf-8").split("\n");
    const shown = lines.slice(0, MAX_DIFF_UNTRACKED_LINES);
    const header = `--- /dev/null\n+++ b/${workspacePath}\n@@ -0,0 +1,${shown.length} @@\n`;
    return {
      path: workspacePath,
      patch: header + shown.map((l) => `+${l}`).join("\n"),
      truncated: lines.length > MAX_DIFF_UNTRACKED_LINES,
    };
  }

  private assertValidNewPath(relativePath: string): void {
    if (
      typeof relativePath !== "string" ||
      !relativePath.trim() ||
      relativePath.length > MAX_TREE_PATH_CHARS
    ) {
      throw new Error("A workspace-relative file path is required");
    }
    // resolveSafe throws on escapes; the existence check happens at the
    // operation site so error messages stay exact.
    this.workspace.resolveSafe(relativePath);
  }

  private regularOrMissingFile(relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("A workspace-relative file path is required");
    }
    const absolutePath = this.workspace.resolveSafe(relativePath);
    if (
      !fs.existsSync(absolutePath) &&
      !this.regularFileKnownToGit(relativePath)
    ) {
      throw new Error(`File does not exist: ${relativePath}`);
    }
    return relativePath;
  }

  // A deleted file is absent on disk but still diffable through Git.
  private regularFileKnownToGit(relativePath: string): boolean {
    if (!this.isGitWorkTree()) return false;
    const status = this.runGit(
      ["status", "--porcelain", "--", this.workspacePathToRepo(relativePath)],
      4096,
    );
    return status.ok && status.stdout.trim().length >= 4;
  }

  private isGitWorkTree(): boolean {
    const result = this.runGit(["rev-parse", "--is-inside-work-tree"], 4096);
    return result.ok && result.stdout.trim() === "true";
  }

  private gitToplevel(): string {
    const result = this.runGit(["rev-parse", "--show-toplevel"], 4096);
    return result.ok ? result.stdout.trim() : this.workspace.root;
  }

  // Confine Git output to this workspace: repo-relative paths are resolved
  // against the repository toplevel, then required to land inside the
  // workspace root. Realpath both sides so symlinked temp roots (macOS /var)
  // compare honestly. Returns a workspace-relative path or null.
  private repoPathToWorkspace(
    repoPath: string,
    toplevel: string,
  ): string | null {
    const absolute = path.resolve(toplevel, repoPath);
    let workspaceReal: string;
    try {
      workspaceReal = fs.realpathSync(this.workspace.root);
    } catch {
      workspaceReal = this.workspace.root;
    }
    const relative = path.relative(workspaceReal, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative || path.basename(absolute);
  }

  private workspacePathToRepo(workspacePath: string): string {
    const toplevel = this.gitToplevel();
    let workspaceReal: string;
    try {
      workspaceReal = fs.realpathSync(this.workspace.root);
    } catch {
      workspaceReal = this.workspace.root;
    }
    if (toplevel === workspaceReal) return workspacePath;
    return path.relative(toplevel, path.resolve(workspaceReal, workspacePath));
  }

  private runGit(
    args: string[],
    maxBytes: number,
  ): { ok: boolean; stdout: string } {
    try {
      const result = spawnSync("git", args, {
        cwd: this.workspace.root,
        encoding: "utf-8",
        maxBuffer: maxBytes,
        timeout: 10_000,
      });
      if (result.error || result.status !== 0) return { ok: false, stdout: "" };
      return { ok: true, stdout: result.stdout ?? "" };
    } catch {
      return { ok: false, stdout: "" };
    }
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
    return {
      path: relativePath,
      content,
      bytes: buffer.byteLength,
      revision: this.contentRevision(buffer),
    };
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
    // External-change guard (#490): when the editor supplies the revision it
    // loaded, the save fails closed if the on-disk content moved on, so an
    // outside edit is never silently overwritten.
    if (typeof request.expectedRevision === "string") {
      const current = fs.readFileSync(absolutePath);
      if (this.contentRevision(current) !== request.expectedRevision) {
        throw new Error(
          "File changed outside Desktop — reload it before saving",
        );
      }
    }
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
    return {
      path: request.path,
      content: request.content,
      bytes,
      revision: this.contentRevision(Buffer.from(request.content, "utf-8")),
    };
  }

  private contentRevision(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
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
      ...(Array.isArray(workspace.editorTabs)
        ? { editorTabs: workspace.editorTabs }
        : {}),
      ...(typeof workspace.activeEditorTab === "string"
        ? { activeEditorTab: workspace.activeEditorTab }
        : {}),
      ...(workspace.activeView === "chat" ||
      workspace.activeView === "workflow" ||
      workspace.activeView === "changes"
        ? { activeView: workspace.activeView }
        : {}),
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
  // session that no longer exists (or belongs elsewhere) reads as none, and
  // the active editor tab must be one of the persisted tabs.
  private sanitizeWorkspaceUi(ui: DesktopUiState): DesktopUiState {
    const editorTabs = ui.editorTabs;
    return {
      activeSessionId:
        ui.activeSessionId && this.ownsSession(ui.activeSessionId)
          ? ui.activeSessionId
          : null,
      sessions: ui.sessions,
      ...(editorTabs ? { editorTabs } : {}),
      activeEditorTab:
        ui.activeEditorTab &&
        editorTabs?.some((tab) => tab.path === ui.activeEditorTab)
          ? ui.activeEditorTab
          : null,
      ...(ui.activeView ? { activeView: ui.activeView } : {}),
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

  // Bounded, well-typed editor-tab persistence (#490). Invalid tabs are
  // dropped rather than partially trusted.
  private sanitizeEditorTab(tab: unknown): DesktopEditorTabState | null {
    if (!tab || typeof tab !== "object") return null;
    const candidate = tab as Record<string, unknown>;
    if (
      typeof candidate.path !== "string" ||
      !candidate.path.trim() ||
      candidate.path.length > MAX_TREE_PATH_CHARS
    ) {
      return null;
    }
    const sanitized: DesktopEditorTabState = { path: candidate.path };
    if (
      typeof candidate.scrollTop === "number" &&
      Number.isFinite(candidate.scrollTop) &&
      candidate.scrollTop >= 0
    ) {
      sanitized.scrollTop = Math.min(candidate.scrollTop, MAX_SCROLL_TOP);
    }
    if (typeof candidate.dirty === "boolean") sanitized.dirty = candidate.dirty;
    if (typeof candidate.draft === "string") {
      sanitized.draft = candidate.draft.slice(0, MAX_TAB_DRAFT_CHARS);
    }
    return sanitized;
  }
}
