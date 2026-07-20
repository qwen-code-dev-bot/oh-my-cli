// Workspace-bound language-server readiness and diagnostics, exposed as an
// inspectable, deterministic runtime view (Issue #202).
//
// Symbol and diagnostic feedback is easier to trust when a language server's
// readiness is visible, but a hidden startup, a stale diagnostic, or a server
// from a previous run can mislead both users and agents. This module models the
// lifecycle of language servers that are bound to ONE trusted workspace and ONE
// owning session, and it attaches every diagnostic to the exact workspace, file,
// document version, and server instance that produced it.
//
// Nothing here performs I/O: discovery never installs a binary (it only asks an
// injected probe whether a command is present), and the state machine is pure so
// the same inputs always yield the same outputs. The safety invariants are the
// point: a diagnostic from another workspace, a superseded document version, or a
// previous server instance is rejected rather than presented as current; an
// unsupported language or a missing binary is explicit and quiet, never blocking;
// and every server-supplied string is secret-safe and length-bounded before it
// can reach a terminal, a headless dump, or a test receipt.
//
// The same engine backs the interactive `/lsp` overlay and the headless
// `--lsp-status` form, so a workspace's language-server state reads identically
// in both.

import { createHash } from "node:crypto";
import path from "node:path";
import { redactSecrets, redactHomePath } from "./permission-impact.js";

export const LSP_RUNTIME_SCHEMA = "oh-my-cli.lsp";
export const LSP_RUNTIME_VERSION = 1;

// Default startup timeout: a server still in "starting" past this is reported as
// an error rather than left indefinitely pending (criterion: timeouts).
export const DEFAULT_START_TIMEOUT_MS = 30_000;

// Bounds so a pathological or hostile server cannot inflate the view.
const MAX_MESSAGE_CHARS = 240;
const MAX_DETAIL_CHARS = 200;
const MAX_COMMAND_CHARS = 160;
const MAX_FILE_URI_CHARS = 320;
const MAX_DIAGNOSTICS_PER_SERVER = 50;
const MAX_LANGUAGE_CHARS = 40;

// Lifecycle status of a single workspace-bound language server.
export type LspStatus =
  | "starting" // launch requested, awaiting readiness
  | "ready" // initialized and serving
  | "indexing" // serving but building a project index (reduced responsiveness)
  | "degraded" // serving with reduced capability or partial errors
  | "stopped" // shut down; owns no current diagnostics
  | "error"; // failed to start, crashed, or timed out

// Outcome of discovering a configured server for a workspace. Every value is
// explicit and quiet: discovery reports the state, it never installs or throws.
export type LspAvailability =
  | "available" // binary present; may be started
  | "missing-binary" // configured but the binary was not found
  | "unsupported" // a present language with no registered server
  | "untrusted"; // workspace not trusted; servers are not started

export type LspSeverity = "error" | "warning" | "info" | "hint";

// A well-known language server: the binary that serves a language and the file
// extensions that mark a workspace as relevant to it. Discovery checks whether
// the binary is present WITHOUT installing it.
export interface LspServerSpec {
  language: string;
  command: string;
  args?: string[];
  extensions?: string[];
}

// Built-in registry of common servers. These are only candidates; discovery
// still probes for the binary, and a user may register more via settings. The
// CLI never installs any of them.
export const DEFAULT_LSP_SERVERS: readonly LspServerSpec[] = [
  {
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  { language: "python", command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  { language: "go", command: "gopls", extensions: [".go"] },
  { language: "rust", command: "rust-analyzer", extensions: [".rs"] },
];

// A normalized diagnostic range (zero-based, clamped to non-negative integers).
export interface LspRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

// A raw diagnostic item as a server would publish it (no file/version here; those
// come from the enclosing publish event, mirroring textDocument/publishDiagnostics).
export interface LspRawDiagnosticItem {
  severity: LspSeverity;
  message: string;
  range?: LspRange;
}

// A stored, output-safe diagnostic: bound to a file (by a non-leaky key plus a
// redacted display URI), the document version it describes, and produced by the
// server's current instance.
export interface LspDiagnostic {
  fileKey: string;
  displayUri: string;
  version: number;
  severity: LspSeverity;
  message: string;
  range?: LspRange;
}

// The runtime state of one language server, owned by one session and bound to
// one trusted workspace.
export interface LspServer {
  workspaceKey: string;
  workspaceRoot: string; // redacted for output
  sessionId: string;
  language: string;
  command: string;
  instanceId: number; // increments on restart; older instances are not current
  status: LspStatus;
  startedAt: number | null;
  lastEventAt: number | null;
  detail: string | null; // redacted explanation for degraded/error
  diagnostics: LspDiagnostic[];
  // Highest document version seen per file (keyed by non-leaky fileKey) so a
  // late-arriving older version is recognized as stale and rejected.
  fileVersions: Record<string, number>;
  // Count of rejected stale/foreign/previous-instance events, so the rejection
  // is observable rather than silent.
  rejectedStaleEvents: number;
}

// --- Discovery -------------------------------------------------------------

export interface LspDiscoveryInput {
  workspaceKey: string;
  workspaceRoot: string;
  trusted: boolean;
  specs: readonly LspServerSpec[];
  // Languages detected as present in the workspace (e.g. by file extension).
  presentLanguages?: readonly string[];
  // Whether a server binary is present. Injected so discovery never installs
  // and tests stay deterministic.
  binaryAvailable: (command: string) => boolean;
}

export interface LspServerPlan {
  language: string;
  command: string;
  availability: LspAvailability;
  detail: string;
}

export interface LspDiscoveryReport {
  schema: typeof LSP_RUNTIME_SCHEMA;
  v: typeof LSP_RUNTIME_VERSION;
  workspaceKey: string;
  workspaceRoot: string; // redacted
  trusted: boolean;
  plans: LspServerPlan[];
}

// Detect which registered languages are present given a list of file paths.
// Pure: the caller supplies the paths (bounded by the caller), this only maps
// extensions to languages.
export function detectLanguagesFromPaths(
  paths: readonly string[],
  registry: readonly LspServerSpec[] = DEFAULT_LSP_SERVERS,
): string[] {
  const extToLanguage = new Map<string, string>();
  for (const spec of registry) {
    for (const ext of spec.extensions ?? []) extToLanguage.set(ext.toLowerCase(), spec.language);
  }
  const languages = new Set<string>();
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    const language = extToLanguage.get(ext);
    if (language) languages.add(language);
  }
  return [...languages].sort();
}

// Discover configured language servers for a workspace WITHOUT installing
// anything. Untrusted workspaces surface no running servers (explicit, quiet).
// A configured server whose binary is absent is "missing-binary"; a present
// language with no registered server is "unsupported".
export function discoverLanguageServers(input: LspDiscoveryInput): LspDiscoveryReport {
  const root = redactHomePath(input.workspaceRoot);
  const plans: LspServerPlan[] = [];
  const seen = new Set<string>();

  if (!input.trusted) {
    for (const spec of input.specs) {
      if (seen.has(spec.language)) continue;
      seen.add(spec.language);
      plans.push({
        language: safeLanguage(spec.language),
        command: safeText(spec.command, MAX_COMMAND_CHARS),
        availability: "untrusted",
        detail: "workspace is not trusted; language server is not started",
      });
    }
    return finalizeReport(plans, input, root, false);
  }

  for (const spec of input.specs) {
    if (seen.has(spec.language)) continue;
    seen.add(spec.language);
    const available = input.binaryAvailable(spec.command);
    plans.push({
      language: safeLanguage(spec.language),
      command: safeText(spec.command, MAX_COMMAND_CHARS),
      availability: available ? "available" : "missing-binary",
      detail: available
        ? "binary present; server may be started"
        : "binary not found; not installed implicitly",
    });
  }

  for (const language of input.presentLanguages ?? []) {
    if (seen.has(language)) continue;
    seen.add(language);
    plans.push({
      language: safeLanguage(language),
      command: "",
      availability: "unsupported",
      detail: "no language server is registered for this language",
    });
  }

  return finalizeReport(plans, input, root, true);
}

function finalizeReport(
  plans: LspServerPlan[],
  input: LspDiscoveryInput,
  root: string,
  trusted: boolean,
): LspDiscoveryReport {
  plans.sort((a, b) => a.language.localeCompare(b.language));
  return {
    schema: LSP_RUNTIME_SCHEMA,
    v: LSP_RUNTIME_VERSION,
    workspaceKey: input.workspaceKey,
    workspaceRoot: root,
    trusted,
    plans,
  };
}

// --- Lifecycle -------------------------------------------------------------

export interface StartLspOptions {
  workspaceKey: string;
  workspaceRoot: string;
  sessionId: string;
  language: string;
  command: string;
  now: number;
}

// Begin a server instance in the "starting" state. Readiness, diagnostics, and
// shutdown all arrive as events against this instance.
export function startLspServer(opts: StartLspOptions): LspServer {
  return {
    workspaceKey: opts.workspaceKey,
    workspaceRoot: redactHomePath(opts.workspaceRoot),
    sessionId: opts.sessionId,
    language: safeLanguage(opts.language),
    command: safeText(opts.command, MAX_COMMAND_CHARS),
    instanceId: 1,
    status: "starting",
    startedAt: opts.now,
    lastEventAt: opts.now,
    detail: null,
    diagnostics: [],
    fileVersions: {},
    rejectedStaleEvents: 0,
  };
}

export type LspLifecycleEvent =
  | { type: "ready"; at: number }
  | { type: "indexing"; at: number }
  | { type: "degraded"; at: number; detail?: string }
  | { type: "error"; at: number; detail?: string }
  | { type: "stopped"; at: number };

export interface LspDiagnosticsEvent {
  type: "diagnostics";
  at: number;
  // The workspace and server instance that produced this publish; a mismatch is
  // rejected so foreign or previous-instance diagnostics are never current.
  workspaceKey: string;
  instanceId: number;
  fileUri: string;
  version: number;
  items: readonly LspRawDiagnosticItem[];
}

export type LspEvent = LspLifecycleEvent | LspDiagnosticsEvent;

export interface LspApplyResult {
  server: LspServer;
  accepted: boolean;
  reason?: string;
  // For diagnostics events: how many items were accepted vs rejected.
  acceptedDiagnostics?: number;
  rejectedDiagnostics?: number;
}

// Apply one event to a server, returning the new server and whether the event
// was accepted. Rejections are explicit (with a redacted reason) and never
// mutate the current diagnostic view.
export function applyLspEvent(server: LspServer, event: LspEvent): LspApplyResult {
  return event.type === "diagnostics"
    ? applyDiagnostics(server, event)
    : applyLifecycle(server, event);
}

function applyLifecycle(server: LspServer, event: LspLifecycleEvent): LspApplyResult {
  // A stopped server is terminal: ignore further lifecycle events (a restart is
  // a separate operation that creates a new instance).
  if (server.status === "stopped") {
    return { server, accepted: false, reason: "server is stopped" };
  }
  const at = event.at;
  switch (event.type) {
    case "ready":
      if (server.status === "error") {
        return { server, accepted: false, reason: "server is in error; restart required" };
      }
      return { server: { ...server, status: "ready", detail: null, lastEventAt: at }, accepted: true };
    case "indexing":
      if (server.status === "error") {
        return { server, accepted: false, reason: "server is in error; restart required" };
      }
      return { server: { ...server, status: "indexing", lastEventAt: at }, accepted: true };
    case "degraded":
      return {
        server: { ...server, status: "degraded", detail: safeDetail(event.detail), lastEventAt: at },
        accepted: true,
      };
    case "error":
      // A crashed/failed server no longer vouches for its diagnostics.
      return {
        server: {
          ...server,
          status: "error",
          detail: safeDetail(event.detail),
          lastEventAt: at,
          diagnostics: [],
          fileVersions: {},
        },
        accepted: true,
      };
    case "stopped":
      return { server: stopServer(server, at), accepted: true };
  }
}

function applyDiagnostics(server: LspServer, event: LspDiagnosticsEvent): LspApplyResult {
  // A stopped or errored server cannot vouch for current diagnostics.
  if (server.status === "stopped" || server.status === "error") {
    return {
      server: bumpRejected(server),
      accepted: false,
      reason: `diagnostics ignored for a ${server.status} server`,
      acceptedDiagnostics: 0,
      rejectedDiagnostics: event.items.length,
    };
  }
  // Diagnostics from another workspace are never current.
  if (event.workspaceKey !== server.workspaceKey) {
    return {
      server: bumpRejected(server),
      accepted: false,
      reason: "diagnostics from another workspace rejected",
      acceptedDiagnostics: 0,
      rejectedDiagnostics: event.items.length,
    };
  }
  // Diagnostics from a previous server instance (before a restart) are stale.
  if (event.instanceId !== server.instanceId) {
    return {
      server: bumpRejected(server),
      accepted: false,
      reason: "diagnostics from a previous server instance rejected",
      acceptedDiagnostics: 0,
      rejectedDiagnostics: event.items.length,
    };
  }
  const fileKey = hashFileKey(event.fileUri);
  const known = server.fileVersions[fileKey];
  // A publish for an older document version than one already seen is stale.
  if (known !== undefined && event.version < known) {
    return {
      server: bumpRejected(server),
      accepted: false,
      reason: "stale document version rejected",
      acceptedDiagnostics: 0,
      rejectedDiagnostics: event.items.length,
    };
  }

  const displayUri = safePath(event.fileUri);
  const acceptedItems: LspDiagnostic[] = event.items.map((item) => ({
    fileKey,
    displayUri,
    version: event.version,
    severity: normalizeSeverity(item.severity),
    message: safeText(item.message, MAX_MESSAGE_CHARS) || "(no message)",
    range: normalizeRange(item.range),
  }));

  // Replace this file's diagnostics wholesale (a publish supersedes the prior
  // set for the file at the prior version); an empty set clears the file.
  const others = server.diagnostics.filter((d) => d.fileKey !== fileKey);
  const diagnostics = [...others, ...acceptedItems]
    .sort(compareDiagnostics)
    .slice(0, MAX_DIAGNOSTICS_PER_SERVER);

  return {
    server: {
      ...server,
      diagnostics,
      fileVersions: { ...server.fileVersions, [fileKey]: event.version },
      lastEventAt: event.at,
    },
    accepted: true,
    acceptedDiagnostics: acceptedItems.length,
    rejectedDiagnostics: 0,
  };
}

// Advance a still-starting server past its timeout into an explicit error.
export function checkLspTimeout(
  server: LspServer,
  now: number,
  timeoutMs: number = DEFAULT_START_TIMEOUT_MS,
): { server: LspServer; timedOut: boolean } {
  if (server.status !== "starting" || server.startedAt === null) {
    return { server, timedOut: false };
  }
  if (now - server.startedAt <= timeoutMs) {
    return { server, timedOut: false };
  }
  return {
    server: {
      ...server,
      status: "error",
      detail: `startup timed out after ${timeoutMs} ms`,
      lastEventAt: now,
      diagnostics: [],
      fileVersions: {},
    },
    timedOut: true,
  };
}

// Restart a server: a fresh instance (incremented id) in "starting", with all
// prior diagnostics dropped because they belonged to the previous instance.
export function restartLspServer(server: LspServer, now: number): LspServer {
  return {
    ...server,
    instanceId: server.instanceId + 1,
    status: "starting",
    startedAt: now,
    lastEventAt: now,
    detail: null,
    diagnostics: [],
    fileVersions: {},
    rejectedStaleEvents: 0,
  };
}

// Cleanly stop a server: it owns no current diagnostics afterward.
export function stopLspServer(server: LspServer, now: number): LspServer {
  return {
    ...server,
    status: "stopped",
    detail: null,
    diagnostics: [],
    fileVersions: {},
    lastEventAt: now,
  };
}

// End a session: stop every server it owns (cleanup), leaving other sessions'
// servers untouched. Honors session ownership.
export function endLspSession(
  servers: readonly LspServer[],
  sessionId: string,
  now: number,
): LspServer[] {
  return servers.map((server) =>
    server.sessionId === sessionId && server.status !== "stopped"
      ? stopLspServer(server, now)
      : { ...server },
  );
}

// --- Summary + formatting --------------------------------------------------

export interface LspSummary {
  schema: typeof LSP_RUNTIME_SCHEMA;
  v: typeof LSP_RUNTIME_VERSION;
  serverCount: number;
  byStatus: Record<LspStatus, number>;
  totalDiagnostics: number;
  diagnosticsBySeverity: Record<LspSeverity, number>;
  rejectedStaleEvents: number;
}

// Aggregate counts across servers for the compact view.
export function summarizeLspRuntime(servers: readonly LspServer[]): LspSummary {
  const byStatus: Record<LspStatus, number> = {
    starting: 0,
    ready: 0,
    indexing: 0,
    degraded: 0,
    stopped: 0,
    error: 0,
  };
  const diagnosticsBySeverity: Record<LspSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
  };
  let totalDiagnostics = 0;
  let rejectedStaleEvents = 0;
  for (const server of servers) {
    byStatus[server.status] += 1;
    rejectedStaleEvents += server.rejectedStaleEvents;
    for (const diag of server.diagnostics) {
      totalDiagnostics += 1;
      diagnosticsBySeverity[diag.severity] += 1;
    }
  }
  return {
    schema: LSP_RUNTIME_SCHEMA,
    v: LSP_RUNTIME_VERSION,
    serverCount: servers.length,
    byStatus,
    totalDiagnostics,
    diagnosticsBySeverity,
    rejectedStaleEvents,
  };
}

// Compact, logical lines for the summary view (overlay or headless).
export function formatLspSummary(
  summary: LspSummary,
  opts: { workspaceRoot?: string; trusted?: boolean } = {},
): string[] {
  const lines: string[] = [];
  lines.push("Language servers (read-only · no edits performed)");
  lines.push("─".repeat(40));
  if (opts.workspaceRoot !== undefined) {
    lines.push(`Workspace: ${redactHomePath(opts.workspaceRoot)}`);
  }
  if (opts.trusted !== undefined) {
    lines.push(`Trust:     ${opts.trusted ? "trusted" : "untrusted (servers not started)"}`);
  }
  if (summary.serverCount === 0) {
    lines.push("Servers:   none configured or available");
    return lines;
  }
  const statusParts = (Object.keys(summary.byStatus) as LspStatus[])
    .filter((status) => summary.byStatus[status] > 0)
    .map((status) => `${status} ${summary.byStatus[status]}`);
  lines.push(`Servers:   ${summary.serverCount} (${statusParts.join(", ")})`);
  if (summary.totalDiagnostics === 0) {
    lines.push("Diagnostics: none");
  } else {
    const sevParts = (Object.keys(summary.diagnosticsBySeverity) as LspSeverity[])
      .filter((sev) => summary.diagnosticsBySeverity[sev] > 0)
      .map((sev) => `${sev} ${summary.diagnosticsBySeverity[sev]}`);
    lines.push(`Diagnostics: ${summary.totalDiagnostics} (${sevParts.join(", ")})`);
  }
  lines.push(`Stale/foreign events rejected: ${summary.rejectedStaleEvents}`);
  return lines;
}

// The configured-server discovery section of the view.
export function formatLspDiscovery(report: LspDiscoveryReport): string[] {
  const lines: string[] = [];
  lines.push(`Configured servers (${report.plans.length})`);
  if (report.plans.length === 0) {
    lines.push("  none registered");
    return lines;
  }
  for (const plan of report.plans) {
    const tail = plan.command ? plan.command : plan.detail;
    lines.push(`  ${plan.language}  ${plan.availability}  ${tail}`);
  }
  return lines;
}

// A combined view: a discovery report plus any live servers, rendered together.
export interface LspView {
  report: LspDiscoveryReport;
  servers: readonly LspServer[];
}

// An empty view (no configured servers, no live servers) for callers without LSP
// discovery wired in. Honest and quiet: it states no servers are configured.
export function emptyLspView(workspaceRoot: string, trusted: boolean): LspView {
  return {
    report: {
      schema: LSP_RUNTIME_SCHEMA,
      v: LSP_RUNTIME_VERSION,
      workspaceKey: "",
      workspaceRoot: redactHomePath(workspaceRoot),
      trusted,
      plans: [],
    },
    servers: [],
  };
}

// The full inspectable view: a compact summary, the configured-server
// discovery, and the per-server detail of any live servers. Backs both the
// interactive overlay and the headless `--lsp-status` text form (parity).
export function formatLspView(view: LspView): string[] {
  const summary = summarizeLspRuntime(view.servers);
  const lines = formatLspSummary(summary, {
    workspaceRoot: view.report.workspaceRoot,
    trusted: view.report.trusted,
  });
  lines.push("");
  lines.push(...formatLspDiscovery(view.report));
  if (view.servers.length > 0) {
    lines.push("");
    lines.push("Active servers");
    for (const server of view.servers) {
      lines.push("");
      lines.push(...formatLspServerDetail(server));
    }
  } else {
    lines.push("");
    lines.push("Active servers: none running");
  }
  return lines;
}

// Inspectable per-server detail lines, including its current diagnostics.
export function formatLspServerDetail(server: LspServer): string[] {
  const lines: string[] = [];
  const head = `${server.language}  ${server.status}  (instance ${server.instanceId})`;
  lines.push(head);
  lines.push(`workspace: ${server.workspaceRoot}`);
  if (server.command) lines.push(`command:   ${server.command}`);
  if (server.detail) lines.push(`detail:    ${server.detail}`);
  if (server.diagnostics.length === 0) {
    lines.push("diagnostics: none");
  } else {
    lines.push(`diagnostics: ${server.diagnostics.length}`);
    for (const diag of server.diagnostics) {
      const loc = diag.range ? `${diag.displayUri}:${diag.range.startLine + 1}:${diag.range.startChar + 1}` : diag.displayUri;
      lines.push(`  ${diag.severity}  v${diag.version}  ${loc}`);
      lines.push(`    ${diag.message}`);
    }
  }
  if (server.rejectedStaleEvents > 0) {
    lines.push(`rejected stale/foreign events: ${server.rejectedStaleEvents}`);
  }
  return lines;
}

// --- internal helpers ------------------------------------------------------

function stopServer(server: LspServer, at: number): LspServer {
  return {
    ...server,
    status: "stopped",
    detail: null,
    diagnostics: [],
    fileVersions: {},
    lastEventAt: at,
  };
}

function bumpRejected(server: LspServer): LspServer {
  return { ...server, rejectedStaleEvents: server.rejectedStaleEvents + 1 };
}

function hashFileKey(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 16);
}

function normalizeSeverity(severity: LspSeverity): LspSeverity {
  return severity === "error" || severity === "warning" || severity === "info" || severity === "hint"
    ? severity
    : "info";
}

function normalizeRange(range: LspRange | undefined): LspRange | undefined {
  if (!range) return undefined;
  const clamp = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  return {
    startLine: clamp(range.startLine),
    startChar: clamp(range.startChar),
    endLine: clamp(range.endLine),
    endChar: clamp(range.endChar),
  };
}

function compareDiagnostics(a: LspDiagnostic, b: LspDiagnostic): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.displayUri !== b.displayUri) return a.displayUri.localeCompare(b.displayUri);
  const al = a.range?.startLine ?? 0;
  const bl = b.range?.startLine ?? 0;
  if (al !== bl) return al - bl;
  return (a.range?.startChar ?? 0) - (b.range?.startChar ?? 0);
}

function severityRank(severity: LspSeverity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : severity === "info" ? 2 : 3;
}

function safeText(input: string | undefined, max: number): string {
  if (!input) return "";
  const { text } = redactSecrets(input);
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)) + "…";
}

function safeDetail(input: string | undefined): string | null {
  const text = safeText(input, MAX_DETAIL_CHARS);
  return text ? text : null;
}

function safeLanguage(input: string): string {
  return safeText(input, MAX_LANGUAGE_CHARS) || "unknown";
}

function safePath(uri: string): string {
  let display = uri;
  if (display.startsWith("file://")) {
    display = "file://" + redactHomePath(display.slice("file://".length));
  } else {
    display = redactHomePath(display);
  }
  return safeText(display, MAX_FILE_URI_CHARS) || "(unknown file)";
}
