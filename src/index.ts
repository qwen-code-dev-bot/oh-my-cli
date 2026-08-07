#!/usr/bin/env node

import { Command } from "commander";
import { resolveSettingsPath, describeResolvedConfig } from "./settings.js";
import {
  RUNTIME_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMAND_DESCRIPTORS,
  formatRuntimeSlashCommand,
  formatSlashCommandHelp,
  resolveSlashCommand,
  isStreamingSafeSlashCommand,
} from "./slash-command.js";
import { resolveEffectiveSettings, formatEffectiveSettings } from "./effective-settings.js";
import { collectWorkflowList, formatWorkflowList } from "./workflow-contract.js";
import {
  collectHookList,
  formatHookList,
  resolvePreToolUseHooks,
  type PreToolUseHook,
} from "./hook-contract.js";
import {
  runWorkflow,
  formatWorkflowStart,
  formatWorkflowStepStart,
  formatWorkflowStepLine,
  formatWorkflowOutcome,
  workflowConsoleStyle,
} from "./workflow-runner.js";
import {
  collectProfileList,
  formatProfileList,
  resolveModelProfileConfig,
} from "./model-profiles.js";
import { loadWorkspaceEnv } from "./workspace-env.js";
import { Workspace } from "./workspace.js";
import { SessionStore } from "./session.js";
import {
  goalExecutionRequest,
  runGoalCommand,
  settleGoalExecution,
} from "./session-goal.js";
import { runAgent, createConsoleSink } from "./agent.js";
import type { AgentResult } from "./agent.js";
import type { ApprovalMode } from "./approval.js";
import type { SessionMessage } from "./session.js";
import type { SessionLock, SessionLockInfo } from "./session-lock.js";
import {
  defaultCommands,
  formatPalettePickerLines,
  parsePaletteSelection,
} from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { runPreflight, formatPreflight, validateFallbackModel } from "./preflight.js";
import { collectSandboxDiagnostic, formatDiagnostic } from "./sandbox-diag.js";
import { collectHealthInventory, formatHealthInventory, healthInventoryRecord, healthInventoryStrictExit } from "./health-inventory.js";
import {
  collectSessionSummaries,
  filterSessionSummaries,
  formatSessionList,
  pickContinueSession,
  sessionListRecord,
  scopeSessionSummariesByWorkspace,
  orderSummariesPinnedFirst,
} from "./session-summary.js";
import type { SessionScopeInfo } from "./session-summary.js";
import { salvageSession, resolveSalvageTarget } from "./session-salvage.js";
import { archiveSession, unarchiveSession, resolveArchiveTarget } from "./session-archive.js";
import { BUNDLE_VERIFY_SCHEMA, BUNDLE_VERIFY_VERSION, bundleSession, bundleStore, formatBundleVerify, isSessionBundle, isStoreBundle, restoreSessionBundle, restoreStoreBundle, SESSION_BUNDLE_SCHEMA, SESSION_BUNDLE_VERSION, STORE_BUNDLE_SCHEMA, STORE_BUNDLE_VERSION, verifySessionBundle, verifyStoreBundle } from "./session-bundle.js";
import { pinSession, unpinSession } from "./session-pin.js";
import { buildSessionInspectRecord, formatSessionInspect } from "./session-inspect.js";
import {
  appendSessionNote,
  buildSessionNotesRecord,
  formatSessionNotes,
  SESSION_NOTES_MAX,
} from "./session-notes.js";
import { buildSessionsOverviewRecord, formatSessionsOverview } from "./sessions-overview.js";
import {
  buildStaleSessionsReport,
  formatStaleSessions,
  staleSessionsStrictExit,
  STALE_DEFAULT_DAYS,
} from "./stale-sessions.js";
import { executeArchiveStale, formatArchiveStale, ARCHIVE_STALE_DRY_RUN_NOTE } from "./archive-stale.js";
import { buildSessionStorageReport, formatSessionStorageReport, parseStorageBudget, storageBudgetStrictExit } from "./session-storage.js";
import { buildSessionHealthReport, formatSessionHealthReport, healthReportStrictExit } from "./session-health.js";
import { buildStoreDoctorReport, formatStoreDoctorReport, storeDoctorStrictExit } from "./store-doctor.js";
import { renderReportLines } from "./ascii-output.js";
import {
  buildWorkspaceJournal,
  buildWorkspaceJournalByDay,
  buildWorkspaceJournalByHour,
  buildWorkspaceJournalByMonth,
  buildWorkspaceJournalBySession,
  buildWorkspaceJournalBySessionDay,
  buildWorkspaceJournalByWeek,
  buildWorkspaceJournalCount,
  buildWorkspaceJournalSummary,
  diffNewEntries,
  formatWorkspaceJournal,
  formatWorkspaceJournalByDay,
  formatWorkspaceJournalByHour,
  formatWorkspaceJournalByMonth,
  formatWorkspaceJournalBySession,
  formatWorkspaceJournalBySessionDay,
  formatWorkspaceJournalByWeek,
  formatWorkspaceJournalCount,
  formatWorkspaceJournalSummary,
  journalEntryIdentity,
  workspaceJournalEntryJsonLine,
  workspaceJournalEntryLine,
} from "./workspace-journal.js";
import type { WorkspaceJournalEntry, WorkspaceJournalRecord } from "./workspace-journal.js";
import {
  buildSessionJournal,
  buildSessionJournalByDay,
  buildSessionJournalByHour,
  buildSessionJournalByMonth,
  buildSessionJournalByWeek,
  buildSessionJournalCount,
  buildSessionJournalSummary,
  formatSessionJournal,
  formatSessionJournalByDay,
  formatSessionJournalByHour,
  formatSessionJournalByMonth,
  formatSessionJournalByWeek,
  formatSessionJournalCount,
  formatSessionJournalSummary,
} from "./session-journal.js";
import {
  JOURNAL_FOLLOW_DEFAULT_POLL_MS,
  JOURNAL_KINDS,
  formatRelativeAge,
  parseJournalLimit,
  parseJournalPollMs,
  parseJournalSkip,
  parseJournalTimestamp,
  sessionDiffNewEntries,
  sessionJournalEntryIdentity,
  sessionJournalEntryJsonLine,
  sessionJournalEntryLine,
} from "./session-journal.js";
import type { JournalTimeWindow, SessionJournalKind, SessionJournalRecord } from "./session-journal.js";
import { buildSessionDiff, formatSessionDiff } from "./session-diff.js";
import { searchSessionNotes, formatSessionNotesSearch } from "./session-notes-search.js";
import type { SessionNotesSearchScope } from "./session-notes-search.js";
import { searchSessions, formatSessionSearch } from "./session-search.js";
import type { SessionSearchScope } from "./session-search.js";
import { forkSession, resolveForkTarget, SESSION_FORK_SCHEMA, SESSION_FORK_VERSION } from "./session-fork.js";
import type { SessionForkRecord } from "./session-fork.js";
import {
  runSessionPicker,
  resolveResumeTarget,
  resolveSessionTarget,
  checkResumeWorkspaceBinding,
  resumeWorkspaceMismatchMessage,
  resumeWorkspaceLegacyMessage,
  shortSessionId,
} from "./session-picker.js";
import { openComposerDraftStore, clearDurableDraft } from "./composer-draft.js";
import { isMultilinePasteChunk, flattenPastedChunk } from "./readline-paste.js";
import {
  CLEAR_SCREEN_SEQUENCE,
  repairControlCharInsertion,
  wordKillBefore,
  lineKillBefore,
  isSweptControlByte,
  stripInsertedPaletteByte,
} from "./readline-screen.js";
import { resolveHeadlessPromptSource, normalizeStdinPrompt } from "./headless-prompt.js";
import {
  openPromptHistoryStore,
  readlineHistorySeed,
  PROMPT_HISTORY_MAX_ENTRIES,
} from "./prompt-history.js";
import { readlineOrientationLine } from "./readline-orientation.js";
import { corruptStoreWarning } from "./readline-store-warnings.js";
import {
  approvalModeCommandDecision,
  decisionAppliesMode,
  nextPendingEscalation,
  formatApprovalModeNotice,
} from "./approval-mode-switch.js";
import { buildAttention, attentionRecord, formatAttention, attentionStrictExit } from "./attention-summary.js";
import type { AttentionItem } from "./attention-summary.js";
import { normalizeSessionName } from "./session-name.js";
import {
  compactMessages,
  saveCompaction,
  formatCompaction,
  loadCompaction,
  loadSessionMessages,
} from "./compaction.js";
import type { CompactionSummary } from "./compaction.js";
import { compactCurrentSession, rejectCompactArgs } from "./compact-command.js";
import { collectDoctorReport, doctorRecord, formatDoctorReport } from "./doctor.js";
import { collectRepoReadiness, formatRepoReadiness } from "./repo-readiness.js";
import { collectRepoContext, formatRepoContext } from "./repo-context.js";
import { collectRepoMap, formatRepoMap, tokensToBudgetChars } from "./repo-map.js";
import { collectInstructionContext, formatInstructionContext } from "./instruction-context.js";
import { planTask, formatTaskPlan } from "./task-plan.js";
import { verifyTask, formatVerifyReport } from "./task-verify.js";
import { reviewChange, formatChangeReviewReport } from "./change-review.js";
import { collectCiHandoff, formatCiHandoffReport } from "./ci-handoff.js";
import {
  collectDeliveryBrief,
  formatDeliveryBrief,
  parseCiResult,
} from "./delivery-brief.js";
import { collectProviderContract, formatProviderContract } from "./provider-contract.js";
import { collectMcpContract, formatMcpContract } from "./mcp-contract.js";
import { collectToolContract, formatToolContract } from "./tool-contract.js";
import {
  invokeTool,
  formatToolInvocation,
  invocationExitCode,
} from "./tool-invocation.js";
import {
  invokeMcpServer,
  formatMcpInvocation,
  mcpInvocationExitCode,
} from "./mcp-invocation.js";
import {
  invokeProvider,
  formatProviderInvocation,
  providerInvocationExitCode,
} from "./provider-invocation.js";
import { collectExtensionDiscovery, formatExtensionDiscovery } from "./extension-discovery.js";
import { collectExtensionCompat, formatExtensionCompat } from "./extension-compat.js";
import { collectConceptCapabilities, formatConceptCapabilities } from "./concept-contract.js";
import { collectContinuity, formatContinuity, assertHeadCurrent } from "./session-continuity.js";
import { collectActivityModel, formatActivityModel } from "./event-presentation.js";
import { collectFailureModel, formatFailureModel } from "./failure-presentation.js";
import {
  collectLifecycleModel,
  formatLifecycleModel,
  emptyLifecycleModel,
} from "./lifecycle-projection.js";
import { formatLifecycleView } from "./lifecycle-render.js";
import { formatActivityView, initialActivityViewState } from "./activity-render.js";
import {
  collectMissionStatusDescriptor,
  formatMissionStatusDescriptor,
} from "./mission-status.js";
import {
  collectInterventionDescriptor,
  formatInterventionDescriptor,
} from "./mission-intervention.js";
import { collectReconnectDescriptor, formatReconnectDescriptor } from "./mission-reconnect.js";
import { collectTrustPosture, formatTrustPosture } from "./trust-posture.js";
import { predictMergeConflict, formatConflictPrediction } from "./conflict-prediction.js";
import { integrateBranch, formatIntegrationResult } from "./selective-integration.js";
import {
  readRecoveryCheckpoint,
  readEvidenceFile,
  currentRepoHead,
  evaluateRecovery,
  formatRecoveryPlan,
} from "./run-recovery.js";
import type { RecoveryContext } from "./run-recovery.js";
import {
  buildEvidenceBundle,
  writeEvidenceBundle,
  readEvidenceBundle,
  readCommandOutcomes,
  verifyEvidenceBundle,
  formatEvidenceExport,
  formatEvidenceVerification,
  EvidenceArchiveError,
} from "./evidence-archive.js";
import type { EvidenceInput } from "./evidence-archive.js";
import { exportSession, formatSessionExport } from "./session-export.js";
import {
  SIDE_QUESTION_SCHEMA,
  SIDE_QUESTION_VERSION,
  buildSideContext,
  formatSideContextSummary,
  runSideQuestion,
} from "./side-question.js";
import {
  buildSessionStats,
  formatSessionStats,
} from "./session-stats.js";
import {
  buildTurnHistory,
  formatTurnHistory,
} from "./turn-history.js";
import {
  MEMORY_DISABLED_ENV,
  addWorkspaceMemory,
  forgetWorkspaceMemory,
  buildMemoryListRecord,
  formatMemoryList,
} from "./workspace-memory.js";
import {
  collectPerfReport,
  formatPerfReport,
} from "./perf-report.js";
import {
  appendFailureReceipt,
  buildFailureRecord,
  formatFailures,
} from "./failure-receipts.js";
import { isOfflineRequested } from "./offline-guard.js";
import { buildGoalStatusRecord, formatGoalStatus, resumeGoalSummaryLine } from "./goal-status.js";
import { runGoalControl } from "./goal-control.js";
import {
  DEFAULT_LSP_SERVERS,
  detectLanguagesFromPaths,
  discoverLanguageServers,
  formatLspView,
  summarizeLspRuntime,
} from "./lsp-runtime.js";
import type { LspView } from "./lsp-runtime.js";
import {
  emptyTaskView,
  formatTaskView,
  reconcileTasks,
  summarizeTasks,
} from "./task-runtime.js";
import type { TaskView } from "./task-runtime.js";
import {
  TurnImageCollector,
  buildTurnCheckpoint,
  loadTurnLog,
  appendCheckpoint,
  planUndo,
  planRedo,
  applyUndo,
  applyRedo,
  formatTurnPlan,
} from "./turn-checkpoint.js";
import {
  createWorktreeLease,
  cleanWorktreeLease,
  cancelWorktreeLease,
  collectWorktreeGraph,
  collectWorktreeHandoff,
  formatWorktreeLeaseResult,
  formatWorktreeCancelResult,
  formatWorktreeGraph,
  formatWorktreeHandoff,
} from "./worktree-lease.js";
import { evaluateCommandPolicy, formatCommandPolicyDecision } from "./command-policy.js";
import {
  resolveFolderTrust,
  formatFolderTrust,
  loadTrustStore,
  addTrusted,
  saveTrustStore,
  defaultTrustStorePath,
  workspaceTrustKey,
} from "./folder-trust.js";
import { HeadlessWriter, createHeadlessSink, startEvent } from "./headless-protocol.js";
import { installSigintCancel, SIGINT_EXIT_CODE } from "./sigint-cancel.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { buildRunSummary, formatRunSummary, writeRunSummaryFile } from "./run-summary.js";
import { createBottleneckCollector, formatBottleneckReport } from "./run-bottleneck.js";
import { createFailureTaxonomyCollector, formatFailureTaxonomyReport } from "./run-failure-taxonomy.js";
import { readTaskFixtureFile, fixtureStreamProvider, type TaskFixture } from "./task-fixture.js";
import { loadImageAttachments, imageRef } from "./image-input.js";
import type { LoadedImage } from "./image-input.js";
import { createTools } from "./tools.js";
import { parseBudgetUsd } from "./cost.js";
import { parseMaxTurns, parseWallTimeMs, parseMaxToolCalls } from "./run-limits.js";
import {
  readRunSummaryFile,
  compareRunSummaries,
  formatScorecard,
  parseScorecardThresholds,
} from "./run-scorecard.js";
import type { RegressionThresholds } from "./run-scorecard.js";
import type { RunSummary } from "./run-summary.js";
import { colorEnabled, createColorPalette } from "./color.js";
import { detectColorDepth, formatProductBanner, VERSION } from "./product-banner.js";
import { runConversationShell, isFullScreenCapable } from "./tui-shell.js";
import type { ShellContextFacts } from "./tui-shell.js";
import { formatContextView } from "./context-view.js";
import {
  parseDeliveryWebPort,
  startDeliveryWebServer,
} from "./delivery-web.js";
import {
  installFatalBoundary,
  FATAL_EXIT_CODE,
  FATAL_REASON,
  TERMINAL_RESTORE_SEQUENCE,
} from "./fatal-boundary.js";
import path from "node:path";
import fs from "node:fs";

// Handle Ctrl-C gracefully — session is already persisted incrementally. Named
// so non-interactive runs can replace it with the cooperative cancel (#552) for
// their lifetime and restore it afterwards.
function defaultSigintHandler(): void {
  process.stderr.write("\nInterrupted. Session saved.\n");
  process.exit(130);
}

// Parse the repeatable --kind <kind...> journal filter (Issue #632).
// Undefined means "no filter"; unknown kinds throw listing the valid
// taxonomy so the call site can fail closed before any output.
function parseJournalKinds(raw: unknown): ReadonlySet<SessionJournalKind> | undefined {
  if (raw === undefined) return undefined;
  const requested = (raw as unknown[]).map(String);
  if (requested.length === 0) return undefined;
  const invalid = requested.filter((k) => !(JOURNAL_KINDS as readonly string[]).includes(k));
  if (invalid.length > 0) {
    throw new Error(
      `Error: unknown journal kind(s): ${invalid.join(", ")} (valid: ${JOURNAL_KINDS.join(", ")})`,
    );
  }
  return new Set(requested as SessionJournalKind[]);
}

// Parse the --since/--until journal time window (Issue #634, relative specs
// #652). Undefined when neither bound is given; blank, unparseable, or
// inverted bounds throw so the call site can fail closed before any output.
// Both bounds resolve relative specs against the same captured read-time
// reference so the window is internally consistent.
function parseJournalWindow(sinceRaw: unknown, untilRaw: unknown): JournalTimeWindow | undefined {
  if (sinceRaw === undefined && untilRaw === undefined) return undefined;
  const reference = Date.now();
  const since =
    sinceRaw === undefined ? undefined : parseJournalTimestamp(String(sinceRaw), "since", reference);
  const until =
    untilRaw === undefined ? undefined : parseJournalTimestamp(String(untilRaw), "until", reference);
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error(
      `Error: --since must not be after --until (${new Date(since).toISOString()} > ${new Date(until).toISOString()})`,
    );
  }
  return { since, until };
}
process.on("SIGINT", defaultSigintHandler);

// Resolve the one-shot fallback model override (Issue #590): the CLI flag
// wins over OMC_FALLBACK_MODEL; a flag given but blank is a usage error
// rather than a silent disable, while a blank env var stays unset. The value
// must differ from the primary model. Throws with an actionable message on an
// invalid configuration.
function resolveFallbackModelOverride(
  flag: string | undefined,
  env: string | undefined,
  primaryModel: string,
): string | undefined {
  if (flag !== undefined && flag.trim() === "") {
    throw new Error("Error: --fallback-model requires a non-empty model name");
  }
  const raw = flag ?? env;
  if (raw === undefined) return undefined;
  const fallback = raw.trim();
  if (fallback === "") return undefined;
  if (fallback === primaryModel) {
    throw new Error(
      `Error: fallback model "${fallback}" must differ from the primary model`,
    );
  }
  return fallback;
}

// One bounded top-level fatal-failure boundary (#246) for uncaught exceptions and
// unhandled rejections during an active run. It restores a usable terminal when
// attached to a TTY, emits exactly one headless terminal record when the protocol
// has started, and exits non-zero. The headless writer reference is set when a
// headless run begins so the boundary can emit its terminal record.
let activeHeadlessWriter: HeadlessWriter | null = null;
installFatalBoundary({
  cleanup: () => {
    // Restore the terminal only when attached to a TTY; in headless mode stdout
    // carries the protocol stream and must not receive control codes.
    if (process.stdout.isTTY) {
      try {
        process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
      } catch {
        /* best-effort terminal restore */
      }
    }
  },
  emitTerminalRecord: () => {
    if (activeHeadlessWriter) {
      activeHeadlessWriter.emit({
        type: "complete",
        ok: false,
        exitCode: FATAL_EXIT_CODE,
        rounds: 0,
        reason: FATAL_REASON,
      });
    }
  },
});

// Test-only deterministic fault injection (#246): trigger a real unhandled
// rejection or uncaught exception so the fatal boundary's end-to-end contract can
// be exercised by child-process integration tests. Inert unless OMC_FAULT_INJECT
// is set; never active in ordinary runs.
function maybeInjectFault(): void {
  const fault = process.env.OMC_FAULT_INJECT;
  if (fault === "unhandled-rejection") {
    void Promise.reject(new Error("injected unhandled rejection (fault injection)"));
  } else if (fault === "uncaught-exception") {
    setTimeout(() => {
      throw new Error("injected uncaught exception (fault injection)");
    }, 0);
  }
}

// Whether a command is present on PATH (or, on Windows, with a PATHEXT suffix).
// Read-only: it never installs anything — the Issue #202 discovery invariant.
function commandOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, command + ext)).isFile()) return true;
      } catch {
        /* not in this directory */
      }
    }
  }
  return false;
}

// A bounded, non-recursive scan of a workspace's top-level files, used only to
// detect which registered languages are present so an unsupported language can
// be surfaced explicitly. Bounded so a large tree never blocks a read.
const LSP_SCAN_MAX_FILES = 512;
function scanWorkspaceLanguages(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) paths.push(entry.name);
    if (paths.length >= LSP_SCAN_MAX_FILES) break;
  }
  return detectLanguagesFromPaths(paths);
}

// Build the read-only language-server view for a workspace: a trust-gated
// discovery report (no implicit install) plus any live servers. The CLI does not
// itself spawn language servers, so the live list is empty in normal use; the
// engine that produces live, workspace-bound state is exercised by the tests and
// the E2E receipt. Discovery is read-only and never performs an edit.
function buildLspView(workspaceRoot: string): LspView {
  const trust = resolveFolderTrust({ workspacePath: workspaceRoot });
  const trusted = trust.decision.mutatingAllowed;
  const presentLanguages = trusted ? scanWorkspaceLanguages(workspaceRoot) : [];
  const report = discoverLanguageServers({
    workspaceKey: workspaceTrustKey(workspaceRoot),
    workspaceRoot,
    trusted,
    specs: DEFAULT_LSP_SERVERS,
    presentLanguages,
    binaryAvailable: (command) => commandOnPath(command),
  });
  return { report, servers: [] };
}

// Existence check for a process id: signal 0 sends no signal but reports whether
// the process is alive. Used by restart reconciliation to consult REAL process
// state rather than trusting a persisted "running" label.
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Background-task center (Issue #203): a read-only, session-owned view of runtime
// background work and its durable receipts. The CLI does not itself spawn tracked
// background tasks yet, so the live list is empty in normal use; the engine, the
// durable-receipt sidecar, and restart reconciliation are exercised by the tests
// and the E2E receipt. Reading is honest: a missing sidecar yields a quiet empty
// view, a malformed/stale one is refused (fail closed), and a present one is
// reconciled against real process state so a dead task is never presented as
// running. Read-only; it never spawns, cancels, or edits.
function buildTaskView(store: SessionStore, sessionId: string, workspaceRoot: string): TaskView {
  const snapshot = store.readTasks(sessionId);
  if (!snapshot) return emptyTaskView(workspaceRoot);
  const reconciled = reconcileTasks(snapshot, { isAlive: processAlive }, Date.now());
  return { summary: summarizeTasks(reconciled.snapshot), workspaceRoot };
}

const program = new Command();

program
  .name("oh-my-cli")
  .description("A small code-agent CLI with file and shell tools")
  .version("0.1.0")
  .option(
    "-p, --prompt [prompt]",
    "Run a single non-interactive request (prompt argument, or piped stdin when the value is omitted)",
  )
  .option(
    "--image <paths...>",
    "Attach image file(s) by path for vision-capable analysis (PNG, JPEG, GIF, or WebP)",
  )
  .option(
    "--resume <id-or-name>",
    "Resume a persisted session by exact id or by its user-owned name (fails closed when the value is empty or the session is missing, corrupt, ambiguous, or unreadable)",
  )
  .option(
    "--continue",
    "Continue the most recent healthy session declared for this workspace (fails closed when none matches)",
  )
  .option(
    "--approval-mode <mode>",
    "Approval mode: default, auto-edit, or yolo (yolo is unsafe - allows all tools)",
    "default",
  )
  .option("--workspace <dir>", "Workspace directory", process.cwd())
  .option(
    "--delivery-web",
    "Start the browser-native Remote Control and Dynamic Workflow delivery board",
  )
  .option(
    "--web-port <port>",
    "Loopback port for --delivery-web (default 4317)",
    "4317",
  )
  .option("--preflight", "Run a provider connectivity preflight and exit")
  .option("--sandbox-info", "Show effective sandbox isolation diagnostic and exit")
  .option("--trust-info", "Show the folder-trust decision for the workspace (read-only) and exit")
  .option("--trust", "Trust this workspace for this run only (not persisted)")
  .option("--trust-workspace", "Persist trust for this workspace in the user trust store and exit")
  .option("--enforce-folder-trust", "Deny mutating tools when the workspace is untrusted (env: OMC_ENFORCE_FOLDER_TRUST=1)")
  .option("--trust-posture", "Show the effective, redacted workspace trust, sandbox, approval, and extension posture (read-only) and exit")
  .option(
    "--predict-conflict <source>",
    "Predict read-only whether merging <source> into the target would conflict (fail-closed) and exit",
  )
  .option("--conflict-target <target>", "Target revision for --predict-conflict (default HEAD)")
  .option(
    "--integrate <source>",
    "Reviewably integrate <source> into the current branch (fail-closed, commit-identity-preserving merge) and exit",
  )
  .option("--integrate-dry-run", "With --integrate, show the preview without performing the merge")
  .option("--health", "Show MCP server and extension health inventory and exit")
  .option("--settings <path>", "Unified settings file for model config and --health (default ~/.oh-my-cli/settings.json)")
  .option("--effective-settings", "Show the effective, redacted, hierarchical settings snapshot (user + trusted project, validated; read-only) and exit")
  .option("--list-workflows", "List declared workflows from user settings (read-only, redacted) and exit")
  .option("--list-hooks", "List declared PreToolUse hooks from user settings (read-only, redacted) and exit")
  .option("--run-workflow <name>", "Run a named workflow from user settings non-interactively (sequential headless steps) and exit")
  .option("--list-profiles", "List declared model profiles from user settings (read-only, redacted) and exit")
  .option("--profile <name>", "Select a named model profile from user settings (overrides settings.defaultProfile)")
  .option("--list-sessions", "List resumable sessions with a redacted usage summary and exit (add --output json for a versioned record)")
  .option(
    "--sessions-overview",
    "Show a read-only aggregate health census of the whole session store (integrity, sidecar presence, workspace breakdown, newest activity; add --output json for a versioned record) and exit",
  )
  .option(
    "--stale-sessions [days]",
    "Show a read-only, advisory retention report: sessions older than the threshold (default 30 days) that are neither pinned nor archived are archive candidates (add --output json for a versioned record) and exit",
  )
  .option(
    "--archive-stale [days]",
    "Archive sessions older than the threshold (default 30 days) that carry no keep signal — a strict dry run by default, showing exactly what --stale-sessions reports; add --apply to write the archived markers (nothing is ever deleted; restore any session with --unarchive-session)",
  )
  .option(
    "--apply",
    "With --archive-stale: actually write the archived markers; without it the run is a strict dry run",
  )
  .option(
    "--storage-report",
    "Show a read-only per-session on-disk storage footprint report ranked largest-first — transcript and sidecar bytes, totals, and the largest session (add --output json for a versioned record) and exit",
  )
  .option(
    "--health-report",
    "Show a read-only session transcript health report — every session's integrity (ok/partial/corrupt) worst-first with per-status rollups; diagnostic only, never heals (add --output json for a versioned record) and exit",
  )
  .option(
    "--store-doctor",
    "Run a read-only consolidated store checkup composing health, sidecar, storage, and stale-session diagnostics into one summary with an overall verdict; diagnostic only, never heals (add --output json for a versioned record) and exit",
  )
  .option(
    "--storage-budget <bytes>",
    "With --storage-report --strict: gate the exit code on the store's total footprint against this non-negative integer byte budget (exit 1 when exceeded); only valid together with --strict",
  )
  .option(
    "--strict",
    "With --store-doctor, --health-report, --stale-sessions, --attention, --health, or --storage-report --budget: exit 1 when the checkup verdict is attention-needed, the health report finds a corrupt transcript or damaged sidecar, stale archive candidates exist, the workspace attention summary lists any item, any enabled integration in the health inventory is unhealthy, or the store's total footprint exceeds the byte budget (0 otherwise — healthy, partial-only, no candidates, a quiet workspace, only disabled/healthy integrations, or footprint at/under budget) so automation can gate on store and integration health; output is unchanged",
  )
  .option(
    "--ascii",
    "With the read-only report/journal/session surfaces: render text output ASCII-safe (decorative and semantic glyphs mapped to ASCII equivalents); JSON output is unchanged",
  )
  .option(
    "--workspace-journal",
    "Show a read-only merged chronology of every session declared for the --workspace (default cwd) identity (add --output json for a versioned record) and exit",
  )
  .option(
    "--kind <kind...>",
    "With --session-journal/--workspace-journal: only show entries of these kinds (created, goal, note, pinned, archived, last-activity)",
  )
  .option(
    "--since <when>",
    "With --session-journal/--workspace-journal: only show entries at or after this time — an ISO-8601 timestamp, a bare date YYYY-MM-DD (start of day UTC), a relative offset that long ago (30s/45m/6h/2d/1w, or now), or a calendar word (today/yesterday)",
  )
  .option(
    "--until <when>",
    "With --session-journal/--workspace-journal: only show entries at or before this time — an ISO-8601 timestamp, a bare date YYYY-MM-DD (end of day UTC), a relative offset that long ago (30s/45m/6h/2d/1w, or now), or a calendar word (today/yesterday)",
  )
  .option(
    "--limit <n>",
    "With --session-journal/--workspace-journal: keep only the newest <n> entries (a positive integer; older entries are elided with a truthful count)",
  )
  .option(
    "--skip <n>",
    "With --session-journal/--workspace-journal: set aside the newest <n> entries and show the ones before them (a positive integer; compose with --limit to page backward)",
  )
  .option(
    "--newest-first",
    "With --session-journal/--workspace-journal: render the kept entries newest-first instead of the default oldest-first (filters and bounds apply unchanged)",
  )
  .option(
    "--count",
    "With --session-journal/--workspace-journal: print only how many entries the filters and bounds keep — counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-kind",
    "With --session-journal/--workspace-journal: print a per-kind tally of the entries the filters and bounds keep — tallies only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-day",
    "With --session-journal/--workspace-journal: group the entries the filters and bounds keep by UTC day — day buckets and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-hour",
    "With --session-journal/--workspace-journal: group the entries the filters and bounds keep by UTC hour — hour buckets and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-week",
    "With --session-journal/--workspace-journal: group the entries the filters and bounds keep by ISO week — week buckets and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-month",
    "With --session-journal/--workspace-journal: group the entries the filters and bounds keep by calendar month — month buckets and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-session",
    "With --workspace-journal: group the entries the filters and bounds keep by contributing session — session ids and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--by-session-day",
    "With --workspace-journal: cross-tab the entries the filters and bounds keep by day and contributing session — day/session ids and counts only, never entry contents (add --output json for a versioned record)",
  )
  .option(
    "--relative",
    "With --session-journal/--workspace-journal: render entry timestamps as ages relative to read time in text output (JSON stays epoch-based)",
  )
  .option(
    "--follow",
    "With --workspace-journal: after printing the current chronology (text only), keep watching the store and emit newly appearing entries live until SIGINT/SIGTERM, which exit 0; read-only throughout",
  )
  .option(
    "--poll-ms <n>",
    "With --workspace-journal --follow: poll the store every <n> milliseconds (an integer of at least 50; default 1000)",
  )
  .option(
    "--filter <text>",
    "With --list-sessions: keep only sessions whose id, name, model, or workspace contains the text (case-insensitive substring)",
  )
  .option(
    "--search-sessions <text>",
    "Search every loadable session's transcript content for the text (case-insensitive substring; read-only; add --output json for a versioned record) and exit",
  )
  .option(
    "--workspace-scoped",
    "With --list-sessions / --search-sessions: scope results to the canonical identity of --workspace (sessions whose workspace cannot be verified are excluded and counted)",
  )
  .option("--attention", "Show a read-only, workspace-scoped attention summary of what needs action and exit (add --output json for a versioned record)")
  .option("--session-stats <id-or-name>", "Show a read-only, deterministic activity/efficiency stats view for a session by exact id or user-owned name (add --output json for automation) and exit")
  .option(
    "--inspect-session <id-or-name>",
    "Show a read-only health card for a session (integrity verdict, sidecar inventory, meta provenance, next-step hints), by exact id or user-owned name (add --output json for automation) and exit",
  )
  .option(
    "--annotate-session <id-or-name>",
    "Append a durable note (requires --note <text>; secrets redacted before persistence) to a session's bounded notes sidecar, by exact id or user-owned name, and exit",
  )
  .option("--note <text>", "The note text for --annotate-session")
  .option(
    "--session-notes <id-or-name>",
    "Show a session's read-only durable notes (newest first; add --output json for automation), by exact id or user-owned name, and exit",
  )
  .option(
    "--search-notes <text>",
    "Search every session's durable notes for the text (case-insensitive substring; read-only; corrupt sessions included, archived skipped; add --output json for a versioned record) and exit",
  )
  .option(
    "--session-journal <id-or-name>",
    "Show a session's read-only durable event journal (creation, goal transitions, notes, pin/archive markers, last activity; chronological; add --output json for a versioned record), by exact id or user-owned name, and exit",
  )
  .option(
    "--diff-sessions <ids...>",
    "Compare two sessions by exact id or user-owned name (read-only; shared prefix, divergence, fork provenance; add --output json for a versioned record) and exit",
  )
  .option("--turn-history <id-or-name>", "Show a read-only, per-turn change provenance view for a session from its durable turn checkpoints, by exact id or user-owned name (add --output json for automation) and exit")
  .option("--memory-add <text>", "Record a durable workspace memory (manual; secrets redacted before persistence) and exit")
  .option("--memory-list", "List this workspace's active memories with provenance (read-only; add --output json for automation) and exit")
  .option("--memory-forget <id>", "Forget a workspace memory by id (soft delete; the tombstone stays auditable) and exit")
  .option("--perf-report", "Show a read-only, redacted performance diagnostics report with declared budgets for the workspace (add --output json for automation) and exit")
  .option("--failures <id-or-name>", "Show a session's read-only bounded, redacted shell failure receipts, by exact id or user-owned name (add --output json for automation) and exit")
  .option("--offline", "Offline mode: block provider routes to non-loopback endpoints fail-closed before any network I/O (also env OMC_OFFLINE=1)")
  .option(
    "--fallback-model <model>",
    "Degrade at most once to this model for the rest of the run when the primary model fails with a retryable provider error; validated fail-closed before any work starts (env: OMC_FALLBACK_MODEL)",
  )
  .option("--goal-status <id-or-name>", "Show a session's read-only durable Goal checkpoint (status, objective, timestamps, revision), by exact id or user-owned name (add --output json for automation) and exit")
  .option("--goal <args>", "Control a session's durable Goal headlessly against --session: an objective sets it; pause / resume / achieve / clear / status behave like the TUI /goal command (add --output json for automation) and exit")
  .option("--lsp-status", "Show the read-only, workspace-bound language-server discovery and readiness view for the current workspace (add --output json for automation) and exit")
  .option("--tasks <id-or-name>", "Show a session's read-only background-task center with durable receipts, reconciled against real process state, by exact id or user-owned name (add --output json for automation) and exit")
  .option("--browse-sessions", "Interactively browse, search, and resume a previous session (requires a terminal)")
  .option("--export-session <id-or-name>", "Export a session locally as redacted Markdown + a deterministic JSON manifest, by exact id or user-owned name, and exit")
  .option("--out <dir>", "Output directory for --export-session (default: current directory)")
  .option("--force", "Overwrite existing output files (--export-session, --summary-out)")
  .option(
    "--bundle-session <id-or-name>",
    "Bundle a session losslessly (raw transcript + every present sidecar, unredacted — for backup or moving between your own stores; use --export-session for redacted sharing) to stdout or --bundle-file, and exit",
  )
  .option("--bundle-file <path>", "With --bundle-session/--bundle-store: write the bundle to this file instead of stdout")
  .option(
    "--bundle-store",
    "Bundle every session in the store losslessly (each session exactly as --bundle-session, in deterministic session-id order — for whole-store backup or migration; unredacted) to stdout or --bundle-file, and exit",
  )
  .option(
    "--restore-store <file>",
    "Restore a --bundle-store bundle: every contained session is materialized as a NEW session id (never overwrites), and exit",
  )
  .option(
    "--verify-bundle <file>",
    "Verify a --bundle-session/--bundle-store bundle read-only: report damaged content (torn transcript lines/sidecars) with exit 0 healthy, 1 damaged, 2 unreadable/invalid/unknown",
  )
  .option(
    "--restore-session <file>",
    "Restore a --bundle-session bundle as a NEW session id (never overwrites; turn-log entries are rewritten to the new id), and exit",
  )
  .option("--rename-session <id-or-name>", "Set, replace, or clear a user-owned name for an exact session, targeted by exact id or its current user-owned name (with --session-name), and exit")
  .option(
    "--salvage-session <id-or-name>",
    "Salvage the recoverable prefix of a corrupt session into a new resumable session (original untouched) and exit",
  )
  .option(
    "--archive-session <id-or-name>",
    "Archive a session out of discovery (listing, search, --continue, picker) into a durable marker; it stays resumable by exact id/name (original untouched) and exit",
  )
  .option(
    "--unarchive-session <id-or-name>",
    "Restore an archived session to normal discovery, by exact id or user-owned name, and exit",
  )
  .option(
    "--pin-session <id-or-name>",
    "Pin a session to the top of session listing regardless of recency (durable marker; original untouched), by exact id or user-owned name, and exit",
  )
  .option(
    "--unpin-session <id-or-name>",
    "Remove a session's pin marker (recency order restored), by exact id or user-owned name, and exit",
  )
  .option(
    "--include-archived",
    "With --list-sessions: include archived sessions (flagged) instead of hiding them with a count",
  )
  .option(
    "--fork-session <id-or-name>",
    "Fork a healthy session into a new resumable session (transcript + goal copied with forkedFrom provenance; original untouched; add --output json for a versioned record) and exit",
  )
  .option("--session-name <name>", "The name for --rename-session (empty/whitespace clears the override) or the fork created by --fork-session")
  .option("--compact <id-or-name>", "Compact a session into a bounded summary sidecar (original preserved), targeted by exact id or user-owned name, and exit")
  .option("--compact-threshold <tokens>", "Auto-compact the in-memory transcript when the latest prompt size reaches this (env: OMC_COMPACT_THRESHOLD)")
  .option("--undo-turn <id-or-name>", "Safely undo the most recent completed agent turn of a session (restores its files + transcript), targeted by exact id or user-owned name, and exit")
  .option("--redo-turn <id-or-name>", "Redo the most recent undone agent turn of a session, targeted by exact id or user-owned name, and exit")
  .option("--dry-run", "Preview an --undo-turn/--redo-turn plan without changing the workspace or transcript")
  .option("--side-question <text>", "Ask a side question against a session's bounded, read-only context (no tools, no mutation, nothing persisted) and exit")
  .option("--session <id-or-name>", "Target session for --side-question and --goal, by exact id or user-owned name")
  .option("--doctor", "Run read-only installation and platform readiness checks and exit")
  .option("--readiness", "Inspect repository readiness for a blocked task (read-only) and exit")
  .option("--expected-branch <name>", "Expected branch for the --readiness branch check")
  .option("--remote <name>", "Git remote to probe for --readiness (default origin)", "origin")
  .option("--repo-context", "Inspect a bounded, redacted repository context snapshot (read-only) and exit")
  .option("--repo-map", "Inspect a bounded, ranked repository map of key files and top-level symbols (read-only) and exit")
  .option("--map-tokens <n>", "Token budget for --repo-map (default 1024; ~4 chars per token)")
  .option("--instruction-context", "Inspect the effective, redacted repository instruction context (read-only) and exit")
  .option("--plan <task>", "Produce a bounded, deterministic execution plan for a task (read-only) and exit")
  .option("--verify-task", "Run the repository's canonical verify commands and report a bounded, head-bound pass/fail verdict and exit")
  .option("--review-change", "Review the current change against a base ref and emit a bounded, redacted, head-bound review brief and exit")
  .option("--base <ref>", "Base ref for --review-change, --ci-handoff, and --delivery-brief (default origin/main, then HEAD)")
  .option("--ci-handoff", "Compose verify and review into a bounded, redacted, head-bound CI handoff brief and exit")
  .option("--delivery-brief", "Compose plan, verify, review, and CI handoff into a bounded, redacted, head-bound completion verdict and exit")
  .option("--ci-result <state>", "CI outcome for --delivery-brief: pass, fail, or pending (default pending)")
  .option("--provider-contract", "Inspect the resolved provider extension contract from settings (read-only, redacted) and exit")
  .option("--provider <id>", "Provider id to select for --provider-contract / --invoke-provider (defaults to settings.providers.default or the sole entry)")
  .option("--invoke-provider", "Issue one bounded model request to the resolved-ready provider from settings once, gated by approval mode, bounded and redacted, and exit")
  .option("--provider-prompt <text>", "Prompt to send for --invoke-provider (defaults to a minimal safe ping)")
  .option("--mcp-contract", "Inspect the resolved MCP server extension contract from settings (read-only, redacted) and exit")
  .option("--server <id>", "MCP server id to select for --mcp-contract / --invoke-mcp (defaults to settings.mcp.default or the sole entry)")
  .option("--invoke-mcp", "Connect to the resolved-ready MCP server from settings once and call one of its tools, gated by approval mode and command policy, confined and redacted, and exit")
  .option("--mcp-tool <name>", "Tool name to call for --invoke-mcp (defaults to the sole exposed tool)")
  .option(
    "--mcp-arg <key=value>",
    "Argument for the MCP tool call (repeatable), parsed as key=value with string values",
    (value: string, previous: string[]) => previous.concat([value]),
    [] as string[],
  )
  .option("--tool-contract", "Inspect the resolved tool extension contract from settings (read-only, redacted) and exit")
  .option("--tool <id>", "Tool id to select for --tool-contract / --invoke-tool (defaults to settings.tools.default or the sole entry)")
  .option("--invoke-tool", "Invoke the resolved-ready tool extension from settings once, gated by approval mode and command policy, confined and redacted, and exit")
  .option("--invoke-timeout <ms>", "Hard timeout in milliseconds for --invoke-tool / --invoke-mcp / --invoke-provider (default 30000, max 300000)")
  .option("--discover-extensions", "Discover the declared provider, MCP, and tool extension contracts and readiness from settings (read-only, redacted) and exit")
  .option("--extension-compat", "Report the supported provider, tool, MCP, and workflow contract versions and a redacted settings-file compatibility verdict (read-only) and exit")
  .option("--capabilities", "Report the shared workbench concept contract and the per-surface (TUI/Desktop) capability matrix with explicit parity gaps (read-only) and exit")
  .option("--continuity", "Report the real session-continuity state (bound head, branch, pending approvals, surface of origin) rendered from the shared concept contract (read-only) and exit")
  .option("--assert-head <sha>", "With --continuity, refuse (exit 1) when the workspace head has moved away from the given bound head sha; exits 0 when current")
  .option("--activity-model", "Report the canonical activity event presentation model (event kinds, statuses, and the real runtime condition each status maps to) (read-only) and exit")
  .option("--failure-model", "Report the canonical failure/waiting presentation guidance (categories, outcome class, retryable, and actionable next step) (read-only) and exit")
  .option("--lifecycle-model", "Report the canonical Goal/Workflow lifecycle projection model (node kinds, node states, terminal states, and event types) (read-only) and exit")
  .option("--mission-status", "Report the mission-status surfacing contract (the gate/retry/budget/waiting/failed categories surfaced from the lifecycle projection and what each means) (read-only) and exit")
  .option("--intervention-model", "Report the mission-intervention contract (the inspect/pause/resume/approve/reject/cancel/open-receipt operations, whether each mutates, and the lifecycle state each maps to) (read-only) and exit")
  .option("--reconnect-model", "Report the mission-reconnect contract (the deterministic-replay / no-history-rewrite / incremental-continuation guarantees and the durable event types replayed) (read-only) and exit")
  .option("--no-probe", "Skip the bounded lifecycle probe for --mcp-contract / --tool-contract / --discover-extensions / --trust-posture and report the declared state")
  .option("--recover", "Resume an interrupted task from a recovery checkpoint (read-only) and exit")
  .option("--checkpoint <file>", "Recovery checkpoint file for --recover")
  .option("--task-identity <id>", "Stable task identity (used by --recover and worktree leases)")
  .option("--evidence <file>", "Current evidence file (JSON stepId -> digest) for --recover")
  .option("--export-evidence <file>", "Export a portable, signed evidence bundle to <file> and exit")
  .option("--verify-evidence <file>", "Verify a portable evidence bundle offline and exit")
  .option("--summary-file <file>", "Run-summary file to include in --export-evidence")
  .option("--outcomes-file <file>", "Command-outcomes file (JSON array) to include in --export-evidence")
  .option("--create-worktree", "Create a leased git worktree for a mutating delegated agent and exit")
  .option("--clean-worktree", "Clean a leased git worktree after verified completion and exit")
  .option("--cancel-worktree", "Cancel a leased git worktree, preserving committed work and failing closed on uncommitted work, and exit")
  .option("--cancel-force", "With --cancel-worktree, discard uncommitted work instead of refusing")
  .option("--list-workspaces", "List the leased parallel workspaces (worktrees) with branch and state (read-only, redacted) and exit")
  .option("--handoff", "Emit a handoff brief for a leased workspace (by --task-identity/--agent-identity): branch, commits, changed paths, state (read-only, redacted) and exit")
  .option("--agent-identity <id>", "Stable agent identity for a leased worktree (with --create-worktree/--clean-worktree)")
  .option("--worktree-root <dir>", "Directory where leased worktrees live (default <workspace>/.oh-my-cli/worktrees)")
  .option("--command-policy <command>", "Evaluate one shell command against the offline command policy and exit")
  .option(
    "--provenance <source>",
    "Command provenance for --command-policy: builtin, repository, or issue",
    "repository",
  )
  .option(
    "--output <format>",
    "Output format for -p mode: text (default) or json (versioned NDJSON event stream); report surfaces accept text|json, and --workspace-journal --follow also accepts jsonl (one JSON object per entry)",
    "text",
  )
  .option(
    "--include-partial-messages",
    "With --output json, emit per-chunk assistant_delta records for real-time monitoring (the default stays turn-aggregated)",
  )
  .option("--no-color", "Disable ANSI color output (also honors the NO_COLOR env var)")
  .option("--summary", "Print a privacy-safe execution summary for the run (unattended use)")
  .option(
    "--summary-out <file>",
    "Persist the run's privacy-safe summary JSON (schema oh-my-cli.summary) to <file>; atomic write, refuses to overwrite an existing file without --force",
  )
  .option(
    "--bottleneck",
    "Print a privacy-safe tool/approval wall-time bottleneck report for the run (unattended use)",
  )
  .option(
    "--failure-taxonomy",
    "Print a privacy-safe failure-cause taxonomy report for the run (unattended use)",
  )
  .option(
    "--read-only",
    "Restrict the run to read-only tools (list, glob, grep, read); refuse any mutating tool fail-closed (for safe parallel investigation)",
  )
  .option(
    "--replay-fixture <file>",
    "Replay a deterministic task fixture (bounded prompt + scripted responses) for a reproducible unattended run",
  )
  .option(
    "--budget <usd>",
    "Spend budget in USD; stop before further provider calls once the estimated cost reaches it (also honors OMC_SPEND_BUDGET_USD)",
  )
  .option(
    "--max-turns <n>",
    "Stop the run before the (n+1)th round at a round boundary; positive integer (also honors OMC_MAX_TURNS)",
  )
  .option(
    "--max-wall-time <duration>",
    "Wall-time budget for the run, e.g. 90, 30s, 5m, 1h, 1.5h; the run stops at the first round boundary after it elapses (also honors OMC_MAX_WALL_TIME)",
  )
  .option(
    "--max-tool-calls <n>",
    "Cumulative tool-call budget; the run stops at the first round boundary after the processed tool-call count reaches it (also honors OMC_MAX_TOOL_CALLS)",
  )
  .option("--baseline <file>", "Baseline run-summary file to compare in scorecard mode")
  .option("--candidate <file>", "Candidate run-summary file to compare in scorecard mode")
  .option(
    "--max-elapsed-ratio <n>",
    "Scorecard regression threshold: fractional elapsed-time increase tolerated (default 0.25)",
    "0.25",
  )
  .option(
    "--max-failure-delta <n>",
    "Scorecard regression threshold: tool-failure increase tolerated (default 0)",
    "0",
  )
  .action(async (opts) => {
    try {
      // A --note without --annotate-session is a usage error, checked before
      // every surface so no mode silently ignores a stray note (Issue #602).
      if (opts.note !== undefined && opts.annotateSession === undefined) {
        process.stderr.write("Error: --note requires --annotate-session <id-or-name>\n");
        process.exit(2);
      }

      if (opts.deliveryWeb) {
        const port = parseDeliveryWebPort(opts.webPort);
        const deliveryWeb = await startDeliveryWebServer({ port });
        process.stdout.write(
          `Oh My CLI delivery board: ${deliveryWeb.url}\nPress Ctrl-C to stop.\n`,
        );
        return;
      }

      // Scorecard mode: compare two saved run summaries offline (no provider
      // config needed). Exits 0 when no documented regression threshold is
      // crossed, 1 on a regression, and 2 on a usage/input error.
      if (opts.baseline !== undefined || opts.candidate !== undefined) {
        if (!opts.baseline || !opts.candidate) {
          process.stderr.write(
            "Error: comparing run summaries requires both --baseline <file> and --candidate <file>\n",
          );
          process.exit(2);
        }
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let thresholds: RegressionThresholds;
        let baseline: RunSummary;
        let candidate: RunSummary;
        try {
          thresholds = parseScorecardThresholds(opts.maxElapsedRatio, opts.maxFailureDelta);
          baseline = readRunSummaryFile(opts.baseline, "baseline");
          candidate = readRunSummaryFile(opts.candidate, "candidate");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        const scorecard = compareRunSummaries(baseline, candidate, thresholds);
        if (format === "json") {
          process.stdout.write(JSON.stringify(scorecard) + "\n");
        } else {
          process.stdout.write(formatScorecard(scorecard) + "\n");
        }
        process.exit(scorecard.regression ? 1 : 0);
      }

      if (opts.listSessions) {
        // Machine-readable form follows the sibling listings (Issue #542):
        // a versioned record for automation, text for humans.
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        let summaries = collectSessionSummaries(store);
        // Archive retirement (Issue #598): archived sessions are hidden from
        // discovery by default with a truthful count; --include-archived shows
        // them flagged. Hidden before scoping/filtering so those counts apply
        // to the visible set only.
        let archivedHidden = 0;
        if (!opts.includeArchived) {
          const visible = summaries.filter((s) => !s.archived);
          archivedHidden = summaries.length - visible.length;
          summaries = visible;
        }
        // --workspace-scoped (Issue #596): scope to the canonical identity of
        // --workspace before any other narrowing; an uncanonicalizable target
        // fails closed before any output. Sessions whose workspace cannot be
        // verified are excluded and counted, never silently dropped.
        let scopeInfo: SessionScopeInfo | undefined;
        if (opts.workspaceScoped) {
          let targetKey: string;
          try {
            targetKey = workspaceTrustKey(String(opts.workspace));
          } catch {
            process.stderr.write(
              `Error: cannot scope to workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          const scoped = scopeSessionSummariesByWorkspace(summaries, targetKey);
          summaries = scoped.kept;
          scopeInfo = {
            workspace: String(opts.workspace),
            excludedUnverifiable: scoped.excludedUnverifiable,
          };
        }
        // --filter (Issue #548): case-insensitive substring match over id,
        // name, model, and workspace; totals reflect the filtered set in
        // both modes.
        summaries = filterSessionSummaries(summaries, String(opts.filter ?? ""));
        // Pin-first ordering (Issue #610): pinned visible sessions lead,
        // recency order preserved within each block. Archive visibility was
        // already applied above, so pinned archived sessions follow archive
        // semantics (hidden unless --include-archived).
        summaries = orderSummariesPinnedFirst(summaries);
        if (format === "json") {
          process.stdout.write(
            JSON.stringify(sessionListRecord(summaries, scopeInfo, archivedHidden)) + "\n",
          );
        } else {
          process.stdout.write(formatSessionList(summaries, scopeInfo, archivedHidden) + "\n");
        }
        process.exit(0);
      }

      // Sessions-overview mode (Issue #604): one read-only, zero-mutation
      // aggregate health census of the whole store — integrity verdicts
      // (exact, never healed), sidecar-presence counts, a bounded workspace
      // breakdown, and a recency pointer. Exits 0 on a successful read (an
      // empty store is an honest zero state), 2 on a bad format.
      if (opts.sessionsOverview) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const record = buildSessionsOverviewRecord(store);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionsOverview(record), opts.ascii));
        }
        process.exit(0);
      }

      // Stale-sessions mode (Issue #626): a read-only, strictly advisory
      // retention report — sessions older than the threshold that carry
      // neither keep signal (pin/archive) are archive candidates, ordered
      // oldest first; pinned/archived older sessions count as protected.
      // Nothing is ever archived by this surface; the store is never mutated.
      // Exits 0 on a successful report (empty is honest), 2 on a bad
      // threshold or a bad format. With --strict (Issue #680) the exit code
      // signals the findings for retention automation: 1 when at least one
      // archive candidate exists, 0 otherwise — protected pinned/archived
      // sessions and fresh or empty stores never fail.
      if (opts.staleSessions !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let thresholdDays = STALE_DEFAULT_DAYS;
        if (typeof opts.staleSessions === "string") {
          const parsed = Number(opts.staleSessions);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            process.stderr.write(
              `Error: --stale-sessions days must be a positive integer (got "${opts.staleSessions}")\n`,
            );
            process.exit(2);
          }
          thresholdDays = parsed;
        }
        const store = new SessionStore();
        const record = buildStaleSessionsReport(store, { thresholdDays });
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatStaleSessions(record), opts.ascii));
        }
        process.exit(opts.strict === true ? staleSessionsStrictExit(record) : 0);
      }

      if (opts.apply === true && opts.archiveStale === undefined) {
        process.stderr.write(
          "Error: --apply is only used with --archive-stale\n",
        );
        process.exit(2);
      }

      // Archive-stale mode (Issue #702): the retention story's action half —
      // acts on exactly the candidates the stale-sessions report resolves.
      // Dry run by default: prints the stale report plus a trailing note
      // and mutates nothing. With --apply, archives exactly those
      // candidates via the shared archiveSession primitive — the existing
      // archived marker, nothing more: no transcript or other sidecar is
      // ever touched, nothing is ever deleted, and every archive is
      // reversible with --unarchive-session. Pinned and already-archived
      // sessions are protected by the builder and never become candidates.
      if (opts.archiveStale !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let thresholdDays = STALE_DEFAULT_DAYS;
        if (typeof opts.archiveStale === "string") {
          const parsed = Number(opts.archiveStale);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            process.stderr.write(
              `Error: --archive-stale days must be a positive integer (got "${opts.archiveStale}")\n`,
            );
            process.exit(2);
          }
          thresholdDays = parsed;
        }
        const store = new SessionStore();
        const outcome = executeArchiveStale(store, {
          thresholdDays,
          apply: opts.apply === true,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(outcome.record) + "\n");
        } else if (opts.apply === true) {
          process.stdout.write(
            renderReportLines(formatArchiveStale(outcome.record), opts.ascii),
          );
        } else {
          const lines = formatStaleSessions(outcome.report);
          lines.push("", ARCHIVE_STALE_DRY_RUN_NOTE);
          process.stdout.write(renderReportLines(lines, opts.ascii));
        }
        process.exit(0);
      }

      // Storage-report mode (Issue #664): a strictly read-only per-session
      // on-disk footprint report — transcript + sidecar bytes ranked
      // largest-first, totals, and the largest session. Missing files count
      // 0 bytes honestly; archived sessions are included and marked; nothing
      // is created, healed, or mutated. Exits 0 on a successful report
      // (empty is honest), 2 on a bad format. With --strict --budget
      // (Issue #692) the exit code gates the total footprint against the
      // declared byte budget for automation: 1 when exceeded, 0 at or
      // under. The budget is only meaningful as a gate, so --strict without
      // --budget and --budget without --strict both exit 2 before any
      // output.
      if (opts.storageReport === true) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (opts.strict === true && opts.storageBudget === undefined) {
          process.stderr.write(
            "Error: --strict on --storage-report requires --storage-budget <bytes> (a footprint gate needs a budget)\n",
          );
          process.exit(2);
        }
        if (opts.storageBudget !== undefined && opts.strict !== true) {
          process.stderr.write(
            "Error: --storage-budget is only used with --strict on --storage-report\n",
          );
          process.exit(2);
        }
        let budgetBytes: number | undefined;
        if (opts.storageBudget !== undefined) {
          try {
            budgetBytes = parseStorageBudget(String(opts.storageBudget));
          } catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(2);
          }
        }
        const store = new SessionStore();
        const record = buildSessionStorageReport(store);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionStorageReport(record), opts.ascii));
        }
        process.exit(
          opts.strict === true && budgetBytes !== undefined
            ? storageBudgetStrictExit(record.totalBytes, budgetBytes)
            : 0,
        );
      }

      // Health-report mode (Issue #666): a strictly read-only, diagnostic
      // transcript-integrity report — every discovered session classified
      // ok/partial/corrupt by the store's existing machinery, worst-first
      // with per-status rollups. Never heals, never mutates. Exit 0 on a
      // successful report regardless of health state (the report is
      // diagnostic output, not a failure signal), 2 on a bad format. With
      // --strict (Issue #678) the exit code signals the damage findings
      // for automation: 1 when any transcript is corrupt or any session
      // carries a damaged sidecar, 0 otherwise (partial transcripts alone
      // are recoverable trailing tears and never fail).
      if (opts.healthReport === true) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const record = buildSessionHealthReport(store);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionHealthReport(record), opts.ascii));
        }
        process.exit(opts.strict === true ? healthReportStrictExit(record) : 0);
      }

      // Store-doctor mode (Issue #670): a strictly read-only, diagnostic
      // consolidated store checkup composing the existing health, sidecar,
      // storage, and stale-session machineries into one sectioned summary
      // with an honestly derived verdict. Never heals, never mutates. Exit
      // 0 on a successful checkup regardless of findings (the checkup is a
      // report, not a failure signal), 2 on a bad format. With --strict
      // (Issue #676) the exit code signals the verdict for automation: 1
      // when attention-needed, 0 when healthy. The flag is --store-doctor
      // because --doctor already names the installation and platform
      // readiness checks.
      if (opts.storeDoctor === true) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const record = buildStoreDoctorReport(store);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatStoreDoctorReport(record), opts.ascii));
        }
        process.exit(opts.strict === true ? storeDoctorStrictExit(record.verdict) : 0);
      }

      // Workspace-journal mode (Issue #630): a read-only merged chronology of
      // every session declared for the --workspace (default cwd) canonical
      // identity — per-session durable journals (#618) merged chronologically
      // and tagged per session. Archived sessions are skipped; corrupt
      // sessions contribute their readable state with their verdict. Bounded
      // rendering with a truthful elided count; the store is never mutated.
      // Exits 0 on a successful report (empty is honest), 2 on an
      // uncanonicalizable workspace or a bad format.
      if (opts.workspaceJournal) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json" && format !== "jsonl") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        // JSON-lines streaming is the follow-mode shape (Issue #686); the
        // aggregated snapshot record keeps --output json.
        if (format === "jsonl" && opts.follow !== true) {
          process.stderr.write(
            "Error: --output jsonl requires --follow (snapshots use --output json)\n",
          );
          process.exit(2);
        }
        let kinds: ReadonlySet<SessionJournalKind> | undefined;
        try {
          kinds = parseJournalKinds(opts.kind);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let window: JournalTimeWindow | undefined;
        try {
          window = parseJournalWindow(opts.since, opts.until);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let limit: number | undefined;
        try {
          limit = opts.limit === undefined ? undefined : parseJournalLimit(String(opts.limit));
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let skip: number | undefined;
        try {
          skip = opts.skip === undefined ? undefined : parseJournalSkip(String(opts.skip));
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        // Follow mode (Issue #684): print the current chronology exactly as
        // the non-follow surface would, then keep watching the store and
        // emit newly appearing entries live until SIGINT/SIGTERM exits 0.
        // Text output only; --kind stays live while the window/pagination
        // filters apply to the initial snapshot alone; the aggregation
        // surfaces are incompatible. Strictly read-only throughout.
        if (opts.follow === true) {
          if (format === "json") {
            process.stderr.write(
              "Error: --follow requires text or jsonl output; --output json is not supported with --follow\n",
            );
            process.exit(2);
          }
          const aggregations: Array<[string, boolean]> = [
            ["--by-session", opts.bySession === true],
            ["--by-session-day", opts.bySessionDay === true],
            ["--by-kind", opts.byKind === true],
            ["--by-day", opts.byDay === true],
            ["--by-hour", opts.byHour === true],
            ["--by-week", opts.byWeek === true],
            ["--by-month", opts.byMonth === true],
            ["--count", opts.count === true],
          ];
          const activeAggregations = aggregations.filter(([, on]) => on).map(([flag]) => flag);
          if (activeAggregations.length > 0) {
            process.stderr.write(
              `Error: --follow cannot be combined with ${activeAggregations.join(", ")}\n`,
            );
            process.exit(2);
          }
          let pollMs = JOURNAL_FOLLOW_DEFAULT_POLL_MS;
          if (opts.pollMs !== undefined) {
            try {
              pollMs = parseJournalPollMs(String(opts.pollMs));
            } catch (err) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exit(2);
            }
          }
          const workspaceArg = String(opts.workspace);
          const store = new SessionStore();
          // Unbounded, kind-filtered, unwindowed rebuild: follow must see
          // every entry (the snapshot cap would hide new arrivals), and
          // --kind is the only filter that stays live after the snapshot.
          const buildUnbounded = (): WorkspaceJournalRecord => {
            try {
              return buildWorkspaceJournal(store, {
                workspace: workspaceArg,
                kinds,
                maxEntries: Number.MAX_SAFE_INTEGER,
              });
            } catch {
              process.stderr.write(
                `Error: cannot journal workspace "${redactHomePath(workspaceArg)}": its identity cannot be canonicalized\n`,
              );
              process.exit(2);
            }
          };
          // Baseline: everything that exists right now is "already seen",
          // including entries the bounded snapshot elided.
          const seen = new Set<string>(buildUnbounded().entries.map(journalEntryIdentity));
          // Initial snapshot: byte-identical to the non-follow surface.
          let snapshot: WorkspaceJournalRecord;
          try {
            snapshot = buildWorkspaceJournal(store, {
              workspace: workspaceArg,
              kinds,
              window,
              limit,
              skip,
              newestFirst: opts.newestFirst === true,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(workspaceArg)}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          const relative = opts.relative === true;
          if (format === "jsonl") {
            // Streaming shape (Issue #686): one self-describing JSON object
            // per entry in render order, flushed per record.
            for (const entry of snapshot.entries) {
              process.stdout.write(workspaceJournalEntryJsonLine(entry) + "\n");
            }
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournal(snapshot, { relative }), opts.ascii),
            );
          }
          const stamp = (at: number): string =>
            relative ? formatRelativeAge(at, Date.now()) : new Date(at).toISOString();
          const timer = setInterval(() => {
            const fresh = diffNewEntries(seen, buildUnbounded().entries);
            for (const entry of fresh) {
              seen.add(journalEntryIdentity(entry));
              process.stdout.write(
                format === "jsonl"
                  ? workspaceJournalEntryJsonLine(entry) + "\n"
                  : renderReportLines([workspaceJournalEntryLine(entry, stamp)], opts.ascii) + "\n",
              );
            }
          }, pollMs);
          const stop = (): void => {
            clearInterval(timer);
            process.exit(0);
          };
          // Follow owns Ctrl-C for its lifetime: the default handler exits
          // 130 with a session-saved message that does not apply here.
          process.removeListener("SIGINT", defaultSigintHandler);
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          return;
        }
        if (opts.bySession === true) {
          // Per-session grouping mode (Issue #648): the same pipeline, but
          // the output carries session buckets only — never entry contents.
          // Bucketing fixes the order, so --newest-first has no effect here.
          let bySessionRecord;
          try {
            bySessionRecord = buildWorkspaceJournalBySession(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(bySessionRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalBySession(bySessionRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.bySessionDay === true) {
          // Session × day cross-tab mode (Issue #662): the same pipeline,
          // but the output carries (day × session) pair buckets only —
          // never entry contents. Bucketing fixes the order, so
          // --newest-first has no effect here.
          let bySessionDayRecord;
          try {
            bySessionDayRecord = buildWorkspaceJournalBySessionDay(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(bySessionDayRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalBySessionDay(bySessionDayRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byDay === true) {
          // Per-day grouping mode (Issue #646): the same pipeline, but the
          // output carries UTC day buckets only — never entry contents.
          // Bucketing fixes the order, so --newest-first has no effect here.
          let byDayRecord;
          try {
            byDayRecord = buildWorkspaceJournalByDay(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(byDayRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalByDay(byDayRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byHour === true) {
          // Per-hour grouping mode (Issue #656): the same pipeline, but the
          // output carries UTC hour buckets only — never entry contents.
          // Bucketing fixes the order, so --newest-first has no effect here.
          let byHourRecord;
          try {
            byHourRecord = buildWorkspaceJournalByHour(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(byHourRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalByHour(byHourRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byWeek === true) {
          // Per-ISO-week grouping mode (Issue #658): the same pipeline, but
          // the output carries ISO week buckets only — never entry contents.
          // Bucketing fixes the order, so --newest-first has no effect here.
          let byWeekRecord;
          try {
            byWeekRecord = buildWorkspaceJournalByWeek(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(byWeekRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalByWeek(byWeekRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byMonth === true) {
          // Per-month grouping mode (Issue #660): the same pipeline, but the
          // output carries calendar-month buckets only — never entry
          // contents. Bucketing fixes the order, so --newest-first has no
          // effect here.
          let byMonthRecord;
          try {
            byMonthRecord = buildWorkspaceJournalByMonth(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(byMonthRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalByMonth(byMonthRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byKind === true) {
          // Per-kind summary mode (Issue #644): the same pipeline, but the
          // output carries tallies only — never entry contents. Aggregation
          // is order-independent, so --newest-first has no effect here. The
          // flag is --by-kind because --summary already names the unattended
          // run-summary surface.
          let summaryRecord;
          try {
            summaryRecord = buildWorkspaceJournalSummary(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(summaryRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalSummary(summaryRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.count === true) {
          // Counts-only mode (Issue #642): the same pipeline, but the output
          // carries counts only — never entry contents. Direction is
          // meaningless for a size, so --newest-first has no effect here.
          let countRecord;
          try {
            countRecord = buildWorkspaceJournalCount(new SessionStore(), {
              workspace: String(opts.workspace),
              kinds,
              window,
              limit,
              skip,
            });
          } catch {
            process.stderr.write(
              `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(countRecord) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatWorkspaceJournalCount(countRecord), opts.ascii),
            );
          }
          process.exit(0);
        }
        let record;
        try {
          record = buildWorkspaceJournal(new SessionStore(), {
            workspace: String(opts.workspace),
            kinds,
            window,
            limit,
            skip,
            newestFirst: opts.newestFirst === true,
          });
        } catch {
          process.stderr.write(
            `Error: cannot journal workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
          );
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(
            renderReportLines(
              formatWorkspaceJournal(record, { relative: opts.relative === true }),
              opts.ascii,
            ),
          );
        }
        process.exit(0);
      }

      // Session-search mode (Issue #594): a read-only, headless,
      // case-insensitive substring search over every loadable session's
      // transcript content — session, message index, role, and a bounded
      // redacted snippet per match. Metadata filtering stays with --filter;
      // this surface searches content. Corrupt checkpoints are skipped and
      // counted, never fatal, never mutated; the store is byte-identical
      // after the scan. Exits 0 on a completed scan (matches or none), 2 on
      // a blank query or a bad format.
      if (opts.searchSessions !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (String(opts.searchSessions).trim() === "") {
          process.stderr.write("Error: --search-sessions requires non-empty search text\n");
          process.exit(2);
        }
        const store = new SessionStore();
        // --workspace-scoped (Issue #596): scope the scan to the canonical
        // identity of --workspace; an uncanonicalizable target fails closed
        // before any output. Composes with the corrupt skip-and-count.
        let searchScope: SessionSearchScope | undefined;
        if (opts.workspaceScoped) {
          let targetKey: string;
          try {
            targetKey = workspaceTrustKey(String(opts.workspace));
          } catch {
            process.stderr.write(
              `Error: cannot scope to workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          searchScope = { workspaceKey: targetKey, workspacePath: String(opts.workspace) };
        }
        const record = searchSessions(store, String(opts.searchSessions), searchScope);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(formatSessionSearch(record) + "\n");
        }
        process.exit(0);
      }

      // Attention mode (Issue #558): a read-only, workspace-scoped summary of
      // what needs action after time away — corrupt sessions, recoverable
      // partial checkpoints, and each session's most recent turn outcome —
      // derived purely from durable state. Never heals, mutates, approves, or
      // executes; every listed action is a hint for the user to run. Scoped by
      // the canonical workspace identity, so other workspaces' sessions never
      // appear. Exits 0 on a successful read, 2 on a bad format. With
      // --strict (Issue #682) the exit code signals the findings for
      // automation: 1 when the summary lists at least one item, 0 when the
      // workspace is quiet — an empty summary is an honest zero state, never
      // a failure.
      if (opts.attention) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        let items: AttentionItem[];
        try {
          items = buildAttention({ store, workspacePath: String(opts.workspace) });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: cannot compute attention: ${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(attentionRecord(items, String(opts.workspace))) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatAttention(items, String(opts.workspace)), opts.ascii));
        }
        process.exit(opts.strict === true ? attentionStrictExit(items) : 0);
      }

      // Session-stats mode (Issue #201): render a read-only, deterministic
      // activity/efficiency view for a session, backed only by the canonical
      // message log (no provider call, no mutation, nothing created). Every
      // value states its provenance (measured / estimate / n/a) so a headless
      // read never fabricates a cost, token, or latency the runtime never
      // reported. Exits 0 on success, 2 on a missing session or bad format.
      if (opts.sessionStats !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536): exact id wins, then the user-owned
        // name fallback; fail closed without substitution.
        const resolved = resolveSessionTarget(String(opts.sessionStats), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const meta = store.readMeta(id);
        const stats = buildSessionStats({
          sessionId: id,
          messages: loadSessionMessages(store, id),
          model: meta?.model ?? null,
          workspace: meta?.workspace ? redactHomePath(meta.workspace) : null,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(stats) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionStats(stats), opts.ascii));
        }
        process.exit(0);
      }

      // Turn-history mode (Issue #568): render a session's durable
      // turn-checkpoint log as read-only per-turn change provenance — captured
      // heads, message deltas, file changes with derived actions and bounded
      // magnitude, undo state, and receipts. Strictly non-mutating: it reads
      // the turn log and nothing else, and never echoes file content. Exits 0
      // on success, 2 on a missing session or bad format.
      if (opts.turnHistory !== undefined) {
        const store = new SessionStore();
        const resolved = resolveSessionTarget(String(opts.turnHistory), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const record = buildTurnHistory({ sessionId: id, store });
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatTurnHistory(record), opts.ascii));
        }
        process.exit(0);
      }

      // Workspace-memory mode (Issue #570): manual durable memories with
      // provenance, forget, and disable controls. Secrets are redacted before
      // persistence; the store is scoped by the canonical workspace identity;
      // it grants no authority and this slice performs no retrieval into
      // turns. OMC_MEMORY_DISABLED=1 refuses everything. Exits 0 on success,
      // 2 on empty input, unknown id, corrupt store, or disabled mode.
      if (
        opts.memoryAdd !== undefined ||
        opts.memoryList !== undefined ||
        opts.memoryForget !== undefined
      ) {
        if (process.env[MEMORY_DISABLED_ENV] === "1") {
          process.stderr.write(
            `Error: workspace memory is disabled (${MEMORY_DISABLED_ENV}=1); nothing was read or written\n`,
          );
          process.exit(2);
        }
        const memWorkspace = String(opts.workspace);
        if (opts.memoryAdd !== undefined) {
          const result = addWorkspaceMemory(memWorkspace, String(opts.memoryAdd), {}, {
            head: currentRepoHead(memWorkspace) || undefined,
          });
          if (!result.ok) {
            process.stderr.write(`Error: ${result.reason}\n`);
            process.exit(2);
          }
          process.stdout.write(`Recorded memory ${result.entry?.id ?? ""}\n`);
          process.exit(0);
        }
        if (opts.memoryForget !== undefined) {
          const result = forgetWorkspaceMemory(memWorkspace, String(opts.memoryForget));
          if (!result.ok) {
            process.stderr.write(`Error: ${result.reason}\n`);
            process.exit(2);
          }
          process.stdout.write(`Forgot memory ${String(opts.memoryForget)}\n`);
          process.exit(0);
        }
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(buildMemoryListRecord(memWorkspace)) + "\n");
        } else {
          process.stdout.write(formatMemoryList(memWorkspace).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Performance-report mode (Issue #572): a read-only, redacted diagnostic
      // that attributes wall time to bounded local phases (workspace discovery,
      // session-store scan, bounded turn-log scan, memory) and compares each
      // against declared budgets with honest ok/exceeds verdicts. Measurement
      // only — no writes, no optimization. Exits 0 on success, 2 on a missing
      // workspace or bad format.
      if (opts.perfReport) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const perfWorkspaceRoot = String(opts.workspace);
        let stat: fs.Stats | null = null;
        try {
          stat = fs.statSync(perfWorkspaceRoot);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isDirectory()) {
          process.stderr.write(
            `Error: workspace "${redactHomePath(perfWorkspaceRoot)}" is not a readable directory\n`,
          );
          process.exit(2);
        }
        const report = collectPerfReport({
          workspace: new Workspace(perfWorkspaceRoot),
          store: new SessionStore(),
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatPerfReport(report).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Failure-receipts mode (Issue #574): render a session's bounded,
      // redacted shell failure receipts (newest first) from its sidecar.
      // Strictly read-only: nothing is written. Resolution follows the sibling
      // read-only surfaces (#536 id-or-name, fail-closed). Exits 0 on success,
      // 2 on a missing session or bad format.
      if (opts.failures !== undefined) {
        const store = new SessionStore();
        const resolved = resolveSessionTarget(String(opts.failures), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const record = buildFailureRecord(store, id);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(formatFailures(record).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Session-inspect mode (Issue #600): one read-only health card per
      // session — integrity verdict, sidecar presence/counts, redacted meta
      // provenance, and bounded verdict-only next-step hints. Strictly
      // read-only: resolution uses the heal-free id-or-name resolver so
      // inspecting a corrupt session never quarantines it. Exits 0 on a
      // successful inspection, 2 on resolution failure or a bad format.
      if (opts.inspectSession !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.inspectSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot inspect: ${resolved.reason}\n`);
          process.exit(2);
        }
        const record = buildSessionInspectRecord(store, resolved.sessionId);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionInspect(record), opts.ascii));
        }
        process.exit(0);
      }

      // Session-annotate mode (Issue #602): append one durable note to a
      // session's bounded notes sidecar. Metadata-only and integrity-agnostic
      // (corrupt sessions are annotatable, like the name/archive sidecars);
      // resolution uses the heal-free resolver so nothing is ever
      // quarantined; secrets are redacted before persistence. Exits 0 with a
      // bounded receipt on success, 2 on usage/refusal before any write.
      if (opts.annotateSession !== undefined) {
        if (opts.note === undefined) {
          process.stderr.write("Error: --annotate-session requires --note <text>\n");
          process.exit(2);
        }
        if (String(opts.note).trim() === "") {
          process.stderr.write("Error: --note requires non-empty text\n");
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.annotateSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot annotate: ${resolved.reason}\n`);
          process.exit(2);
        }
        const result = appendSessionNote(store, resolved.sessionId, String(opts.note));
        if (!result.ok) {
          process.stderr.write(`Cannot annotate: ${result.reason}\n`);
          process.exit(2);
        }
        const dropped =
          (result.droppedNow ?? 0) > 0
            ? ` (oldest note dropped; bound is ${SESSION_NOTES_MAX})`
            : "";
        process.stdout.write(
          `Added a note to session ${shortSessionId(resolved.sessionId)} — ${result.recorded} recorded${dropped}.\n`,
        );
        process.exit(0);
      }

      // Session-notes mode (Issue #602): render a session's durable notes
      // (newest first). Strictly read-only: nothing is written; an unreadable
      // sidecar is preserved and reported honestly. Exits 0 (absence of notes
      // is not an error), 2 on resolution failure or a bad format.
      if (opts.sessionNotes !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.sessionNotes), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot read notes: ${resolved.reason}\n`);
          process.exit(2);
        }
        const record = buildSessionNotesRecord(store, resolved.sessionId);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionNotes(record), opts.ascii));
        }
        process.exit(0);
      }

      // Session-journal mode (Issue #618): one read-only chronological
      // journal assembled from the durable state — creation, goal
      // transitions, notes, pin/archive markers, and last transcript
      // activity. Heal-free resolution: corrupt transcripts are journalable
      // (markers and readable history appear); the store is never mutated.
      // Exits 0 on success, 2 on resolution failure or a bad format.
      if (opts.sessionJournal !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json" && format !== "jsonl") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        // JSON-lines streaming is the follow-mode shape (Issue #688); the
        // aggregated snapshot record keeps --output json.
        if (format === "jsonl" && opts.follow !== true) {
          process.stderr.write(
            "Error: --output jsonl requires --follow (snapshots use --output json)\n",
          );
          process.exit(2);
        }
        let kinds: ReadonlySet<SessionJournalKind> | undefined;
        try {
          kinds = parseJournalKinds(opts.kind);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let window: JournalTimeWindow | undefined;
        try {
          window = parseJournalWindow(opts.since, opts.until);
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let limit: number | undefined;
        try {
          limit = opts.limit === undefined ? undefined : parseJournalLimit(String(opts.limit));
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        let skip: number | undefined;
        try {
          skip = opts.skip === undefined ? undefined : parseJournalSkip(String(opts.skip));
        } catch (err) {
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.sessionJournal), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot read journal: ${resolved.reason}\n`);
          process.exit(2);
        }
        // Follow mode (Issue #688): print the current journal exactly as the
        // non-follow surface would, then keep watching the store and emit
        // newly appearing entries live until SIGINT/SIGTERM exits 0 — text
        // lines by default, --output jsonl for the machine-readable stream.
        // --kind stays live; window/pagination apply to the initial snapshot
        // alone; the aggregation surfaces are incompatible. Read-only.
        if (opts.follow === true) {
          if (format === "json") {
            process.stderr.write(
              "Error: --follow requires text or jsonl output; --output json is not supported with --follow\n",
            );
            process.exit(2);
          }
          const aggregations: Array<[string, boolean]> = [
            ["--by-session-day", opts.bySessionDay === true],
            ["--by-kind", opts.byKind === true],
            ["--by-day", opts.byDay === true],
            ["--by-hour", opts.byHour === true],
            ["--by-week", opts.byWeek === true],
            ["--by-month", opts.byMonth === true],
            ["--count", opts.count === true],
          ];
          const activeAggregations = aggregations.filter(([, on]) => on).map(([flag]) => flag);
          if (activeAggregations.length > 0) {
            process.stderr.write(
              `Error: --follow cannot be combined with ${activeAggregations.join(", ")}\n`,
            );
            process.exit(2);
          }
          let pollMs = JOURNAL_FOLLOW_DEFAULT_POLL_MS;
          if (opts.pollMs !== undefined) {
            try {
              pollMs = parseJournalPollMs(String(opts.pollMs));
            } catch (err) {
              process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
              process.exit(2);
            }
          }
          const sessionId = resolved.sessionId;
          // Unbounded, kind-filtered rebuild: follow must see every entry
          // (the snapshot cap would hide new arrivals), and --kind is the
          // only filter that stays live after the snapshot.
          const buildUnbounded = (): SessionJournalRecord => {
            const built = buildSessionJournal(store, sessionId, { kinds });
            if ("error" in built) {
              process.stderr.write(`Error: ${built.error}\n`);
              process.exit(2);
            }
            return built.journal;
          };
          const liveIntegrity = (r: SessionJournalRecord): "partial" | "corrupt" | undefined =>
            r.integrity === "partial" || r.integrity === "corrupt" ? r.integrity : undefined;
          // Baseline: everything that exists right now is "already seen",
          // including entries the bounded snapshot elided.
          const seen = new Set<string>(buildUnbounded().entries.map(sessionJournalEntryIdentity));
          // Initial snapshot: byte-identical to the non-follow surface.
          const snapshotBuilt = buildSessionJournal(store, sessionId, {
            kinds,
            window,
            limit,
            skip,
            newestFirst: opts.newestFirst === true,
          });
          if ("error" in snapshotBuilt) {
            process.stderr.write(`Error: ${snapshotBuilt.error}\n`);
            process.exit(2);
          }
          if (format === "jsonl") {
            for (const entry of snapshotBuilt.journal.entries) {
              process.stdout.write(
                sessionJournalEntryJsonLine(entry, {
                  sessionId,
                  integrity: liveIntegrity(snapshotBuilt.journal),
                }) + "\n",
              );
            }
          } else {
            const relative = opts.relative === true;
            process.stdout.write(
              renderReportLines(formatSessionJournal(snapshotBuilt.journal, { relative }), opts.ascii),
            );
          }
          const stamp = (at: number): string =>
            opts.relative === true ? formatRelativeAge(at, Date.now()) : new Date(at).toISOString();
          const timer = setInterval(() => {
            const current = buildUnbounded();
            const fresh = sessionDiffNewEntries(seen, current.entries);
            for (const entry of fresh) {
              seen.add(sessionJournalEntryIdentity(entry));
              process.stdout.write(
                format === "jsonl"
                  ? sessionJournalEntryJsonLine(entry, {
                      sessionId,
                      integrity: liveIntegrity(current),
                    }) + "\n"
                  : renderReportLines([sessionJournalEntryLine(entry, stamp)], opts.ascii) + "\n",
              );
            }
          }, pollMs);
          const stop = (): void => {
            clearInterval(timer);
            process.exit(0);
          };
          // Follow owns Ctrl-C for its lifetime: the default handler exits
          // 130 with a session-saved message that does not apply here.
          process.removeListener("SIGINT", defaultSigintHandler);
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          return;
        }
        if (opts.byDay === true) {
          // Per-day grouping mode (Issue #646): the same pipeline and
          // resolution semantics, but the output carries UTC day buckets
          // only — never entry contents. Bucketing fixes the order, so
          // --newest-first has no effect here.
          const grouped = buildSessionJournalByDay(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in grouped) {
            process.stderr.write(`Cannot read journal: ${grouped.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(grouped.byDay) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalByDay(grouped.byDay), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byHour === true) {
          // Per-hour grouping mode (Issue #656): the same pipeline and
          // resolution semantics, but the output carries UTC hour buckets
          // only — never entry contents. Bucketing fixes the order, so
          // --newest-first has no effect here.
          const grouped = buildSessionJournalByHour(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in grouped) {
            process.stderr.write(`Cannot read journal: ${grouped.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(grouped.byHour) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalByHour(grouped.byHour), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byWeek === true) {
          // Per-ISO-week grouping mode (Issue #658): the same pipeline and
          // resolution semantics, but the output carries ISO week buckets
          // only — never entry contents. Bucketing fixes the order, so
          // --newest-first has no effect here.
          const grouped = buildSessionJournalByWeek(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in grouped) {
            process.stderr.write(`Cannot read journal: ${grouped.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(grouped.byWeek) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalByWeek(grouped.byWeek), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byMonth === true) {
          // Per-month grouping mode (Issue #660): the same pipeline and
          // resolution semantics, but the output carries calendar-month
          // buckets only — never entry contents. Bucketing fixes the order,
          // so --newest-first has no effect here.
          const grouped = buildSessionJournalByMonth(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in grouped) {
            process.stderr.write(`Cannot read journal: ${grouped.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(grouped.byMonth) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalByMonth(grouped.byMonth), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.byKind === true) {
          // Per-kind summary mode (Issue #644): the same pipeline and
          // resolution semantics, but the output carries tallies only —
          // never entry contents. Aggregation is order-independent, so
          // --newest-first has no effect here. The flag is --by-kind because
          // --summary already names the unattended run-summary surface.
          const summarized = buildSessionJournalSummary(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in summarized) {
            process.stderr.write(`Cannot read journal: ${summarized.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(summarized.summary) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalSummary(summarized.summary), opts.ascii),
            );
          }
          process.exit(0);
        }
        if (opts.count === true) {
          // Counts-only mode (Issue #642): the same pipeline and resolution
          // semantics, but the output carries counts only — never entry
          // contents. Direction is meaningless for a size, so --newest-first
          // has no effect here.
          const counted = buildSessionJournalCount(store, resolved.sessionId, {
            kinds,
            window,
            limit,
            skip,
          });
          if ("error" in counted) {
            process.stderr.write(`Cannot read journal: ${counted.error}\n`);
            process.exit(2);
          }
          if (format === "json") {
            process.stdout.write(JSON.stringify(counted.count) + "\n");
          } else {
            process.stdout.write(
              renderReportLines(formatSessionJournalCount(counted.count), opts.ascii),
            );
          }
          process.exit(0);
        }
        const built = buildSessionJournal(store, resolved.sessionId, {
          kinds,
          window,
          limit,
          skip,
          newestFirst: opts.newestFirst === true,
        });
        if ("error" in built) {
          process.stderr.write(`Cannot read journal: ${built.error}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(built.journal) + "\n");
        } else {
          process.stdout.write(
            renderReportLines(
              formatSessionJournal(built.journal, { relative: opts.relative === true }),
              opts.ascii,
            ),
          );
        }
        process.exit(0);
      }

      // Session-diff mode (Issue #622): read-only comparison of two sessions
      // — per-side facts, shared leading prefix, divergence counts, fork
      // provenance, and redacted bounded first-divergence snippets. Heal-free
      // resolution: corrupt sessions compare via recoverable messages. Exits
      // 0 on success, 2 on resolution failure, wrong arity, or a bad format.
      if (opts.diffSessions !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const targets = (opts.diffSessions as unknown[]).map((t) => String(t));
        if (targets.length !== 2) {
          process.stderr.write(
            "Error: --diff-sessions requires exactly two session ids or names\n",
          );
          process.exit(2);
        }
        const store = new SessionStore();
        const resolvedIds: string[] = [];
        for (const target of targets) {
          const resolved = resolveArchiveTarget(target, store);
          if (!resolved.ok) {
            process.stderr.write(`Cannot diff: ${resolved.reason}\n`);
            process.exit(2);
          }
          resolvedIds.push(resolved.sessionId);
        }
        const built = buildSessionDiff(store, resolvedIds[0], resolvedIds[1]);
        if ("error" in built) {
          process.stderr.write(`Cannot diff: ${built.error}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(built.diff) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionDiff(built.diff), opts.ascii));
        }
        process.exit(0);
      }

      // Session-notes-search mode (Issue #606): a read-only scan over every
      // session's notes ledger for a case-insensitive substring — session,
      // note timestamp, and a redacted snippet per match. Notes are
      // integrity-agnostic, so corrupt sessions' notes are searchable;
      // archived sessions are skipped (consistent discovery semantics).
      // Zero mutation. Exits 0 on a completed scan (matches or none), 2 on a
      // blank query or a bad format.
      if (opts.searchNotes !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (String(opts.searchNotes).trim() === "") {
          process.stderr.write("Error: --search-notes requires non-empty search text\n");
          process.exit(2);
        }
        const store = new SessionStore();
        // --workspace-scoped (Issue #628): mirror transcript search's #596
        // scoping — scan only ledgers of sessions declared for the scoped
        // workspace's canonical identity; an uncanonicalizable target fails
        // closed before any output.
        let notesScope: SessionNotesSearchScope | undefined;
        if (opts.workspaceScoped) {
          let targetKey: string;
          try {
            targetKey = workspaceTrustKey(String(opts.workspace));
          } catch {
            process.stderr.write(
              `Error: cannot scope to workspace "${redactHomePath(String(opts.workspace))}": its identity cannot be canonicalized\n`,
            );
            process.exit(2);
          }
          notesScope = { workspaceKey: targetKey, workspacePath: String(opts.workspace) };
        }
        const record = searchSessionNotes(store, String(opts.searchNotes), notesScope);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatSessionNotesSearch(record), opts.ascii));
        }
        process.exit(0);
      }

      // Goal-status mode (Issue #578): render a session's durable Goal
      // checkpoint (status, redacted objective, ISO timestamps, revision).
      // Strictly read-only: inspection only, no control authority, no writes.
      // A corrupt or absent sidecar renders the honest no-goal state exactly
      // as store.readGoal behaves. Exits 0 (absence of a goal is not an
      // error), 2 on a missing session or bad format.
      if (opts.goalStatus !== undefined) {
        const store = new SessionStore();
        const resolved = resolveSessionTarget(String(opts.goalStatus), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const record = buildGoalStatusRecord(store, id);
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(formatGoalStatus(record).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Goal-control mode (Issue #582): run the exact /goal semantics
      // headlessly against a resolved session's durable Goal checkpoint
      // (set / pause / resume / achieve / clear / status), preserving the #580
      // append-only history. Session-state mutation only — never tool
      // authority. Exits 0, or 2 on a missing/ambiguous session, a missing
      // --session target, a conflicting flag, or a bad output format.
      if (opts.goal !== undefined) {
        if (opts.sideQuestion !== undefined) {
          process.stderr.write("Error: --goal cannot be combined with --side-question\n");
          process.exit(2);
        }
        if (opts.session === undefined) {
          process.stderr.write("Error: --goal requires --session <id-or-name> to target a session\n");
          process.exit(2);
        }
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveSessionTarget(String(opts.session), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const record = runGoalControl(store, id, String(opts.goal));
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(record.output + "\n");
        }
        process.exit(0);
      }

      // Language-server status mode (Issue #202): render a read-only,
      // workspace-bound discovery + readiness view for the current workspace.
      // Discovery never installs a binary; an untrusted workspace surfaces no
      // running servers; unsupported languages and missing binaries are explicit
      // and quiet. No provider call, no mutation, no edits. Exits 0 on success,
      // 2 on a bad output format.
      if (opts.lspStatus) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const view = buildLspView(process.cwd());
        if (format === "json") {
          // The workspace key is the canonical trust identity (an absolute path);
          // redact the home prefix so a shared dump never leaks the host home.
          const report = { ...view.report, workspaceKey: redactHomePath(view.report.workspaceKey) };
          process.stdout.write(
            JSON.stringify({
              report,
              summary: summarizeLspRuntime(view.servers),
              servers: view.servers,
            }) + "\n",
          );
        } else {
          process.stdout.write(formatLspView(view).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Background-task center mode (Issue #203): render a read-only,
      // session-owned view of runtime background work and its durable receipts,
      // reconciled against real process state. A missing sidecar is a quiet empty
      // view; a malformed or stale one is refused (fail closed); a dead task is
      // never presented as running. No provider call, no mutation, no edits.
      // Exits 0 on success, 2 on a missing session or bad output format.
      if (opts.tasks !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536).
        const resolved = resolveSessionTarget(String(opts.tasks), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: session "${id}" not found\n`);
          process.exit(2);
        }
        const meta = store.readMeta(id);
        const view = buildTaskView(store, id, meta?.workspace ?? "");
        if (format === "json") {
          // The workspace key is the canonical trust identity (an absolute path);
          // redact the home prefix so a shared dump never leaks the host home.
          const redactTask = (t: (typeof view.summary.active)[number]) => ({
            ...t,
            workspaceKey: redactHomePath(t.workspaceKey),
          });
          process.stdout.write(
            JSON.stringify({
              schema: view.summary.schema,
              v: view.summary.v,
              sessionId: view.summary.sessionId,
              workspace: redactHomePath(view.summary.workspaceKey),
              counts: view.summary.counts,
              total: view.summary.total,
              evicted: view.summary.evicted,
              active: view.summary.active.map(redactTask),
              recent: view.summary.recent.map(redactTask),
            }) + "\n",
          );
        } else {
          process.stdout.write(formatTaskView(view).join("\n") + "\n");
        }
        process.exit(0);
      }

      // Compaction mode: derive a bounded, versioned summary sidecar for a
      // session. The original transcript is never modified; the sidecar is
      // consumed on the next resume via loadSessionMessages. Exits 2 on a
      // missing/empty session, 0 on success.
      if (opts.compact !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536).
        const resolved = resolveSessionTarget(String(opts.compact), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const full = store.load(id);
        if (full.length === 0) {
          process.stderr.write(`Error: no such session "${id}"\n`);
          process.exit(2);
        }
        const { summary } = compactMessages(full);
        saveCompaction(store.compactPath(id), summary);
        process.stdout.write(formatCompaction(summary) + "\n");
        process.exit(0);
      }

      // Session-export mode: render a session's canonical record to redacted
      // Markdown plus a deterministic JSON manifest, written locally (no network,
      // no provider config needed). Redaction is applied before bytes are
      // written; writes are atomic and never overwrite without --force. Exits 0
      // on success (a corrupt/partial session still exports, flagged), 2 on a
      // missing session, collision, or write error.
      if (opts.exportSession !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536) via the heal-free resolver: the export
        // is read-only and honest about integrity, so corrupt sessions are
        // exportable (flagged) and nothing is ever quarantined here (#614).
        const resolved = resolveArchiveTarget(String(opts.exportSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const outDir = opts.out ? String(opts.out) : process.cwd();
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        try {
          const result = exportSession(store, id, { outDir, force: Boolean(opts.force) });
          if (result.manifest.integrity !== "ok") {
            process.stderr.write(
              `Warning: session ${id} is ${result.manifest.integrity}; the export reflects the recoverable content.\n`,
            );
          }
          if (format === "json") {
            process.stdout.write(
              JSON.stringify({
                markdownPath: result.markdownPath,
                manifestPath: result.manifestPath,
                manifest: result.manifest,
              }) + "\n",
            );
          } else {
            process.stdout.write(formatSessionExport(result) + "\n");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        process.exit(0);
      }

      // Bundle mode (Issue #704): the lossless moving shape — raw transcript
      // lines + every present sidecar carried as-is, unredacted, to stdout or
      // --bundle-file. Strictly read-only; corrupt sessions bundle honestly
      // (their torn lines/sidecars ride along for a faithful round-trip).
      if (opts.bundleSession !== undefined) {
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.bundleSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const bundle = bundleSession(store, resolved.sessionId, Date.now());
        const doc = JSON.stringify(bundle) + "\n";
        if (opts.bundleFile !== undefined) {
          fs.writeFileSync(String(opts.bundleFile), doc);
          process.stdout.write(
            `Bundled session ${shortSessionId(resolved.sessionId)} -> ${String(opts.bundleFile)}\n`,
          );
        } else {
          process.stdout.write(doc);
        }
        process.exit(0);
      }

      // Restore mode (Issue #704): materialize a bundle as a NEW session id —
      // never overwriting or reusing an existing session. Fail-closed on any
      // invalid bundle before writing anything.
      if (opts.restoreSession !== undefined) {
        const bundlePath = String(opts.restoreSession);
        let raw: string;
        try {
          raw = fs.readFileSync(bundlePath, "utf-8");
        } catch {
          process.stderr.write(`Error: cannot read bundle file "${bundlePath}"\n`);
          process.exit(2);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          process.stderr.write(`Error: cannot parse bundle file "${bundlePath}" (invalid JSON)\n`);
          process.exit(2);
        }
        if (!isSessionBundle(parsed)) {
          process.stderr.write(
            `Error: invalid session bundle "${bundlePath}" (expected schema ${SESSION_BUNDLE_SCHEMA} v${SESSION_BUNDLE_VERSION})\n`,
          );
          process.exit(2);
        }
        const store = new SessionStore();
        const { sessionId } = restoreSessionBundle(store, parsed);
        process.stdout.write(
          `Restored session ${shortSessionId(sessionId)} (${sessionId}) from bundle of ${parsed.sourceSessionId}.\n`,
        );
        process.exit(0);
      }

      // Store-bundle mode (Issue #706): the whole-set shape layered on the
      // session bundles — every session in deterministic order, unredacted,
      // strictly read-only.
      if (opts.bundleStore === true) {
        const store = new SessionStore();
        const bundle = bundleStore(store, Date.now());
        const doc = JSON.stringify(bundle) + "\n";
        if (opts.bundleFile !== undefined) {
          fs.writeFileSync(String(opts.bundleFile), doc);
          process.stdout.write(
            `Bundled store (${bundle.sessionCount} session(s)) -> ${String(opts.bundleFile)}\n`,
          );
        } else {
          process.stdout.write(doc);
        }
        process.exit(0);
      }

      // Store-restore mode (Issue #706): materialize every contained session
      // as a NEW id — never overwriting. Fail-closed on any invalid bundle
      // (schema, version, count, or contained entries) before any write.
      if (opts.restoreStore !== undefined) {
        const bundlePath = String(opts.restoreStore);
        let raw: string;
        try {
          raw = fs.readFileSync(bundlePath, "utf-8");
        } catch {
          process.stderr.write(`Error: cannot read store bundle "${bundlePath}"\n`);
          process.exit(2);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          process.stderr.write(`Error: cannot parse store bundle "${bundlePath}" (invalid JSON)\n`);
          process.exit(2);
        }
        if (!isStoreBundle(parsed)) {
          process.stderr.write(
            `Error: invalid store bundle "${bundlePath}" (expected schema ${STORE_BUNDLE_SCHEMA} v${STORE_BUNDLE_VERSION})\n`,
          );
          process.exit(2);
        }
        const store = new SessionStore();
        const { sessionIds } = restoreStoreBundle(store, parsed);
        process.stdout.write(
          `Restored ${sessionIds.length} session(s) from store bundle (${sessionIds.map(shortSessionId).join(", ")}).\n`,
        );
        process.exit(0);
      }

      // Verify mode (Issue #708): read-only integrity check of a session or
      // store bundle (auto-detected by schema). Restore carries honest
      // damage forward; verify reports it — 0 healthy, 1 damaged, 2
      // unreadable/invalid/unknown before any output. Nothing is written.
      if (opts.verifyBundle !== undefined) {
        const bundlePath = String(opts.verifyBundle);
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let raw: string;
        try {
          raw = fs.readFileSync(bundlePath, "utf-8");
        } catch {
          process.stderr.write(`Error: cannot read bundle file "${bundlePath}"\n`);
          process.exit(2);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          process.stderr.write(`Error: cannot parse bundle file "${bundlePath}" (invalid JSON)\n`);
          process.exit(2);
        }
        let kind: "session" | "store";
        let sessions: ReturnType<typeof verifyStoreBundle>["sessions"];
        if (isSessionBundle(parsed)) {
          kind = "session";
          sessions = [verifySessionBundle(parsed)];
        } else if (isStoreBundle(parsed)) {
          kind = "store";
          sessions = verifyStoreBundle(parsed).sessions;
        } else {
          process.stderr.write(
            `Error: unknown bundle schema in "${bundlePath}" (expected ${SESSION_BUNDLE_SCHEMA} v${SESSION_BUNDLE_VERSION} or ${STORE_BUNDLE_SCHEMA} v${STORE_BUNDLE_VERSION})\n`,
          );
          process.exit(2);
        }
        const healthy = sessions.every((session) => session.healthy);
        const record = { kind, sessions, healthy };
        if (format === "json") {
          process.stdout.write(
            JSON.stringify({
              schema: BUNDLE_VERIFY_SCHEMA,
              v: BUNDLE_VERIFY_VERSION,
              kind,
              sessionCount: sessions.length,
              sessions,
              verdict: healthy ? "healthy" : "damaged",
            }) + "\n",
          );
        } else {
          process.stdout.write(renderReportLines(formatBundleVerify(record), opts.ascii));
        }
        process.exit(healthy ? 0 : 1);
      }

      // Session rename mode (#249): set, replace, or clear a user-owned name for
      // an exact session. The name is normalized (bounded; control/escape/
      // secret-like rejected; empty clears) and persisted atomically as bounded
      // metadata — the transcript is never rewritten. Missing/corrupt targets fail
      // closed (exit 2) without touching any other session.
      if (opts.renameSession !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536): the target may be addressed by its
        // current user-owned name as well as its exact id.
        const resolved = resolveSessionTarget(String(opts.renameSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        if (opts.sessionName === undefined) {
          process.stderr.write("Error: --rename-session requires --session-name <name> (empty clears the override)\n");
          process.exit(2);
        }
        const status = store.integrity(id).status;
        if (status === "missing") {
          process.stderr.write(`Error: session ${shortSessionId(id)} was not found\n`);
          process.exit(2);
        }
        if (status === "corrupt") {
          process.stderr.write(`Error: session ${shortSessionId(id)} is corrupt and cannot be renamed safely\n`);
          process.exit(2);
        }
        const normalized = normalizeSessionName(String(opts.sessionName));
        if (!normalized.ok) {
          process.stderr.write(`Error: ${normalized.reason}\n`);
          process.exit(2);
        }
        store.writeName(id, normalized.name);
        if (normalized.name === null) {
          process.stdout.write(`Cleared the name for session ${shortSessionId(id)}.\n`);
        } else {
          process.stdout.write(`Named session ${shortSessionId(id)}: ${redactSecrets(normalized.name).text}\n`);
        }
        process.exit(0);
      }

      // Session-salvage mode (Issue #546): copy the recoverable prefix of a
      // corrupt session into a fresh resumable session (recorded provenance),
      // leaving the source checkpoint byte-identical. Healthy sessions refuse
      // (nothing to salvage); zero-parseable corrupt sessions fail closed with
      // an actionable reason. Exits 0 on success, 2 on refusal/usage errors.
      if (opts.salvageSession !== undefined) {
        const store = new SessionStore();
        // Id-or-name targeting (#536) via the salvage-specific resolver: it
        // skips the heal step resume resolution performs, because healing
        // quarantines the corrupt checkpoint salvage must read.
        const resolved = resolveSalvageTarget(String(opts.salvageSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot salvage: ${resolved.reason}\n`);
          process.exit(2);
        }
        const result = salvageSession(store, resolved.sessionId);
        if (!result.ok) {
          process.stderr.write(`Cannot salvage: ${result.reason}\n`);
          process.exit(2);
        }
        process.stdout.write(
          `Salvaged ${result.salvagedMessages} message(s) ` +
            `(skipped ${result.skippedLines} corrupt line(s)) from ` +
            `${shortSessionId(resolved.sessionId)} into new session ${result.newSessionId}\n` +
            `Resume it with: oh-my-cli --resume ${result.newSessionId} -p "<prompt>"\n`,
        );
        process.exit(0);
      }

      // Session-archive mode (Issue #598): retire a session from discovery
      // (listing, search, --continue, picker) via a durable, integrity-agnostic
      // sidecar marker — metadata only, so the transcript/meta/goal/name bytes
      // are untouched and even corrupt sessions are archivable. The session
      // stays resumable by exact id or name. Unarchiving removes the marker.
      // Exits 0 on success (including idempotent no-ops), 2 on refusal/usage.
      if (opts.archiveSession !== undefined || opts.unarchiveSession !== undefined) {
        if (opts.archiveSession !== undefined && opts.unarchiveSession !== undefined) {
          process.stderr.write(
            "Error: --archive-session and --unarchive-session cannot be combined\n",
          );
          process.exit(2);
        }
        const store = new SessionStore();
        const archiving = opts.archiveSession !== undefined;
        const target = String(archiving ? opts.archiveSession : opts.unarchiveSession);
        // Id-or-name targeting via the heal-free archive resolver: archiving
        // is metadata-only and must never quarantine or otherwise mutate its
        // target, and corrupt sessions are valid archive targets.
        const resolved = resolveArchiveTarget(target, store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot ${archiving ? "archive" : "unarchive"}: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        if (store.integrity(id).status === "missing") {
          process.stderr.write(
            `Cannot ${archiving ? "archive" : "unarchive"}: session ${shortSessionId(id)} was not found\n`,
          );
          process.exit(2);
        }
        const result = archiving ? archiveSession(store, id) : unarchiveSession(store, id);
        if (!result.ok) {
          process.stderr.write(`Cannot ${archiving ? "archive" : "unarchive"}: ${result.reason}\n`);
          process.exit(2);
        }
        if (archiving) {
          if (result.alreadyArchived) {
            process.stdout.write(
              `Session ${shortSessionId(id)} is already archived (since ${new Date(result.archivedAt ?? 0).toISOString()}).\n`,
            );
          } else {
            process.stdout.write(
              `Archived session ${shortSessionId(id)} — hidden from session listing, search, --continue, and the picker.\n` +
                `Resume it anytime with: oh-my-cli --resume ${id} -p "<prompt>"\n`,
            );
          }
        } else if (result.alreadyUnarchived) {
          process.stdout.write(`Session ${shortSessionId(id)} is not archived.\n`);
        } else {
          process.stdout.write(
            `Unarchived session ${shortSessionId(id)} — it is visible in discovery again.\n`,
          );
        }
        process.exit(0);
      }

      // Session-pin mode (Issue #610): elevate an important session to the
      // top of the listing regardless of recency. Metadata-only and
      // integrity-agnostic (corrupt sessions are pinnable, like the archive
      // marker); resolution uses the heal-free resolver so nothing is ever
      // quarantined; re-pinning preserves the original timestamp. Exits 0
      // with a bounded receipt on success (including idempotent no-ops), 2 on
      // resolution failure.
      if (opts.pinSession !== undefined || opts.unpinSession !== undefined) {
        if (opts.pinSession !== undefined && opts.unpinSession !== undefined) {
          process.stderr.write(
            "Error: --pin-session and --unpin-session cannot be combined\n",
          );
          process.exit(2);
        }
        const store = new SessionStore();
        const pinning = opts.pinSession !== undefined;
        const target = String(pinning ? opts.pinSession : opts.unpinSession);
        const resolved = resolveArchiveTarget(target, store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot ${pinning ? "pin" : "unpin"}: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        if (store.integrity(id).status === "missing") {
          process.stderr.write(
            `Cannot ${pinning ? "pin" : "unpin"}: session ${shortSessionId(id)} was not found\n`,
          );
          process.exit(2);
        }
        const result = pinning ? pinSession(store, id) : unpinSession(store, id);
        if (!result.ok) {
          process.stderr.write(`Cannot ${pinning ? "pin" : "unpin"}: ${result.reason}\n`);
          process.exit(2);
        }
        if (pinning) {
          if (result.alreadyPinned) {
            process.stdout.write(
              `Session ${shortSessionId(id)} is already pinned (since ${new Date(result.pinnedAt ?? 0).toISOString()}).\n`,
            );
          } else {
            process.stdout.write(
              `Pinned session ${shortSessionId(id)} — it now lists first among visible sessions.\n`,
            );
          }
        } else if (result.alreadyUnpinned) {
          process.stdout.write(`Session ${shortSessionId(id)} is not pinned.\n`);
        } else {
          process.stdout.write(
            `Unpinned session ${shortSessionId(id)} — recency order restored.\n`,
          );
        }
        process.exit(0);
      }

      // Session-fork mode (Issue #592): branch a healthy session into a fresh,
      // independently resumable session — transcript and durable Goal copied
      // with `forkedFrom` provenance — leaving the source byte-identical.
      // Corrupt/missing/ambiguous sources fail closed before any write (exit
      // 2), as does an invalid --session-name (validated before anything is
      // created, so a refusal never leaves a partial fork). Exits 0 on
      // success. Workspace-mutation provenance (turn checkpoints, failure
      // receipts, compaction sidecars) stays with the source.
      if (opts.forkSession !== undefined) {
        const store = new SessionStore();
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        // Id-or-name targeting (#536) via the fork-specific resolver: it
        // skips the heal step resume resolution performs, because healing
        // quarantines a corrupt checkpoint and a fork refusal must leave the
        // source exactly as it was.
        const resolved = resolveForkTarget(String(opts.forkSession), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot fork: ${resolved.reason}\n`);
          process.exit(2);
        }
        const status = store.integrity(resolved.sessionId).status;
        if (status !== "ok") {
          const detail =
            status === "missing"
              ? "was not found"
              : status === "corrupt"
                ? "is corrupt and cannot be forked safely (see --salvage-session for the recoverable prefix)"
                : `is ${status} and cannot be forked cleanly; resume it first to heal it`;
          process.stderr.write(`Cannot fork: session ${shortSessionId(resolved.sessionId)} ${detail}\n`);
          process.exit(2);
        }
        // An optional user-owned name for the fork. Validated BEFORE the fork
        // is created so an invalid name fails closed with nothing written;
        // names follow the documented #249 contract (never a unique selector).
        let forkName: string | null = null;
        if (opts.sessionName !== undefined) {
          const normalized = normalizeSessionName(String(opts.sessionName));
          if (!normalized.ok) {
            process.stderr.write(`Cannot fork: ${normalized.reason}\n`);
            process.exit(2);
          }
          forkName = normalized.name;
        }
        const result = forkSession(store, resolved.sessionId);
        if (!result.ok) {
          process.stderr.write(`Cannot fork: ${result.reason}\n`);
          process.exit(2);
        }
        const newId = result.newSessionId!;
        if (forkName !== null) {
          store.writeName(newId, forkName);
        }
        if (format === "json") {
          const record: SessionForkRecord = {
            schema: SESSION_FORK_SCHEMA,
            v: SESSION_FORK_VERSION,
            sourceSessionId: resolved.sessionId,
            newSessionId: newId,
            forkedMessages: result.forkedMessages ?? 0,
            forkedGoal: result.forkedGoal === true,
            name: forkName,
          };
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          const goalNote = result.forkedGoal ? "goal copied" : "no goal";
          const nameNote = forkName !== null ? ` named "${redactSecrets(forkName).text}"` : "";
          process.stdout.write(
            `Forked session ${shortSessionId(resolved.sessionId)} into new session ${newId}` +
              `${nameNote} (${result.forkedMessages} message(s), ${goalNote})\n` +
              `Resume it with: oh-my-cli --resume ${newId} -p "<prompt>"\n`,
          );
        }
        process.exit(0);
      }

      // Turn undo/redo mode: safely reverse (or re-apply) the most recent
      // completed agent turn of a session by restoring exactly the files its
      // mutating tools touched and trimming/re-adding its transcript entries.
      // No Git force/reset/stash is ever used; a diverged, conflicted, or
      // already-applied turn fails closed with nothing changed. --dry-run
      // previews the plan without touching the workspace or transcript. Exits 0
      // on success (or a clean preview), 2 when the operation fails closed or on
      // a usage error.
      if (opts.undoTurn !== undefined || opts.redoTurn !== undefined) {
        const store = new SessionStore();
        const op: "undo" | "redo" = opts.undoTurn !== undefined ? "undo" : "redo";
        // Id-or-name targeting (#536).
        const resolved = resolveSessionTarget(String(opts.undoTurn ?? opts.redoTurn), store);
        if (!resolved.ok) {
          process.stderr.write(`Error: ${resolved.reason}\n`);
          process.exit(2);
        }
        const id = resolved.sessionId;
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const meta = store.readMeta(id);
        // Existence is the session file, not a non-empty transcript: undoing the
        // first turn legitimately leaves a valid session with zero messages.
        if (store.integrity(id).status === "missing") {
          process.stderr.write(`Error: no such session "${id}"\n`);
          process.exit(2);
        }
        // Advisory lock (Issue #741): undo/redo rewrites the whole session,
        // so a live holder fails closed instead of being rewritten under.
        const undoLock = store.openLock(id);
        const undoLockResult = undoLock.acquire();
        if (!undoLockResult.acquired) {
          const msg =
            `Cannot ${op}: session ${shortSessionId(id)} appears to be in use by process ${undoLockResult.holder.pid}. ` +
            `Try again when it exits, or if that process is gone, remove ${undoLock.filePath} and retry.`;
          if (format === "json") {
            process.stdout.write(JSON.stringify({ op, ok: false, reason: msg }) + "\n");
          } else {
            process.stderr.write(msg + "\n");
          }
          process.exit(1);
        }
        process.once("exit", () => undoLock.release());
        // Restore against the workspace the turn ran in (recorded in the session
        // meta) so undo is correct regardless of the current directory; fall
        // back to the current directory for sessions without a recorded one.
        const ws = new Workspace(meta?.workspace ?? process.cwd());
        const log = loadTurnLog(store, id);
        const plan = op === "undo" ? planUndo(log, store, ws) : planRedo(log, store, ws);
        const preview = {
          turnIndex: plan.checkpoint?.turnIndex ?? null,
          digest: plan.checkpoint?.digest ?? null,
          files: plan.fileOps.map((o) => ({ path: o.path, action: o.action })),
          messageDelta: plan.messageDelta,
        };
        if (!plan.ok) {
          if (format === "json") {
            process.stdout.write(JSON.stringify({ op, ok: false, reason: plan.reason }) + "\n");
          } else {
            process.stderr.write(formatTurnPlan(plan) + "\n");
          }
          process.exit(2);
        }
        if (opts.dryRun) {
          if (format === "json") {
            process.stdout.write(JSON.stringify({ op, ok: true, dryRun: true, preview }) + "\n");
          } else {
            process.stdout.write(formatTurnPlan(plan) + "\n");
          }
          process.exit(0);
        }
        const result = op === "undo" ? applyUndo(log, store, ws, id) : applyRedo(log, store, ws, id);
        if (!result.ok) {
          if (format === "json") {
            process.stdout.write(JSON.stringify({ op, ok: false, reason: result.reason }) + "\n");
          } else {
            process.stderr.write(`${formatTurnPlan(plan)}\nFailed: ${result.reason}\n`);
          }
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify({ op, ok: true, receipt: result.receipt, preview }) + "\n");
        } else {
          process.stdout.write(
            `${formatTurnPlan(plan)}\nApplied ${op} (receipt ${result.receipt?.digest.slice(0, 12)}…).\n`,
          );
        }
        process.exit(0);
      }

      if (opts.doctor) {
        // Machine-readable form follows the sibling diagnostics (Issue #540):
        // a versioned record for automation, text for humans; exit semantics
        // are identical in both modes (0 when no check failed, 1 otherwise).
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const report = collectDoctorReport();
        if (format === "json") {
          process.stdout.write(JSON.stringify(doctorRecord(report)) + "\n");
        } else {
          process.stdout.write(formatDoctorReport(report) + "\n");
        }
        process.exit(report.ok ? 0 : 1);
      }

      // Command-policy mode: evaluate one shell command against the offline,
      // deterministic policy (no provider config needed). Exits 0 when allowed,
      // 1 when denied, and 2 on a usage error.
      if (opts.commandPolicy !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const provenance = String(opts.provenance ?? "repository");
        if (provenance !== "builtin" && provenance !== "repository" && provenance !== "issue") {
          process.stderr.write(
            `Error: invalid provenance "${provenance}" (expected builtin, repository, or issue)\n`,
          );
          process.exit(2);
        }
        const decision = evaluateCommandPolicy(String(opts.commandPolicy), {
          provenance,
          workspace: opts.workspace,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(decision) + "\n");
        } else {
          process.stdout.write(formatCommandPolicyDecision(decision) + "\n");
        }
        process.exit(decision.allowed ? 0 : 1);
      }

      if (opts.readiness) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        const report = collectRepoReadiness({
          workspace: opts.workspace,
          expectedBranch: opts.expectedBranch,
          remote: opts.remote,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatRepoReadiness(report) + "\n");
        }
        process.exit(report.ready ? 0 : 1);
      }

      // Repository-context mode: emit a bounded, redacted snapshot of how the
      // CLI models the repository (toolchain, canonical commands, languages,
      // structure, VCS state). Read-only and never a gate, so it always exits 0.
      if (opts.repoContext) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        const snapshot = collectRepoContext({ workspace: opts.workspace });
        if (format === "json") {
          process.stdout.write(JSON.stringify(snapshot) + "\n");
        } else {
          process.stdout.write(formatRepoContext(snapshot) + "\n");
        }
        process.exit(0);
      }

      // Repo-map mode: emit a bounded, ranked, redacted map of the workspace's
      // key files and their top-level symbols (the automatic context a fresh
      // session is seeded with). Read-only and never a gate, so it always exits 0.
      if (opts.repoMap) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        let budgetChars: number | undefined;
        if (opts.mapTokens !== undefined) {
          const tokens = Number.parseInt(String(opts.mapTokens), 10);
          if (!Number.isFinite(tokens) || tokens <= 0) {
            process.stderr.write(`Error: invalid --map-tokens "${String(opts.mapTokens)}"\n`);
            process.exit(1);
          }
          budgetChars = tokensToBudgetChars(tokens);
        }
        const snapshot = collectRepoMap(
          new Workspace(opts.workspace),
          budgetChars === undefined ? {} : { budgetChars },
        );
        if (format === "json") {
          process.stdout.write(JSON.stringify(snapshot) + "\n");
        } else {
          process.stdout.write(formatRepoMap(snapshot) + "\n");
        }
        process.exit(0);
      }

      // Instruction-context mode: emit the effective, redacted repository
      // instruction context (the trusted instruction hierarchy a fresh session
      // is seeded with). Read-only and never a gate, so it always exits 0.
      if (opts.instructionContext) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        const snapshot = collectInstructionContext({ workspace: opts.workspace });
        if (format === "json") {
          process.stdout.write(JSON.stringify(snapshot) + "\n");
        } else {
          process.stdout.write(formatInstructionContext(snapshot) + "\n");
        }
        process.exit(0);
      }

      // Task-plan mode: derive a bounded, deterministic, read-only execution
      // plan for one task, grounded in the repository context. Never executes
      // the commands it lists and never calls a provider, so it always exits 0.
      if (opts.plan !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        if (String(opts.plan).trim() === "") {
          process.stderr.write("Error: --plan requires a non-empty task description\n");
          process.exit(2);
        }
        const plan = planTask({ task: String(opts.plan), workspace: opts.workspace });
        if (format === "json") {
          process.stdout.write(JSON.stringify(plan) + "\n");
        } else {
          process.stdout.write(formatTaskPlan(plan) + "\n");
        }
        process.exit(0);
      }

      // Task-verify mode: run the repository's own detected canonical verify
      // commands (build/test/typecheck/lint) and report a bounded, redacted,
      // head-bound pass/fail verdict. Exit 0 when every command passes (or none
      // are detected), 1 when any command fails, 2 on a usage error.
      if (opts.verifyTask) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const report = verifyTask({ workspace: opts.workspace });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatVerifyReport(report) + "\n");
        }
        process.exit(report.verdict === "fail" ? 1 : 0);
      }

      // Change-review mode: inspect the current change against a base ref and
      // emit a bounded, redacted, head-bound review brief. Read-only (Git and
      // package.json only, no commands run, no provider). Exit 0 when the change
      // is clean or empty, 1 when an objective risk signal fires, 2 on a usage
      // error.
      if (opts.reviewChange) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const report = reviewChange({ workspace: opts.workspace, base: opts.base });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatChangeReviewReport(report) + "\n");
        }
        process.exit(report.verdict === "needs-attention" ? 1 : 0);
      }

      // CI-handoff mode: compose the verify and review slices into a single
      // bounded, redacted, head-bound handoff brief. Runs only the repository's
      // own canonical verify commands; never mutates the repository or
      // governance paths. Exit 0 when ready for CI or there is no change, 1 when
      // a local blocker is present, 2 on a usage error.
      if (opts.ciHandoff) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const report = collectCiHandoff({ workspace: opts.workspace, base: opts.base });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatCiHandoffReport(report) + "\n");
        }
        process.exit(report.verdict === "local-blockers" ? 1 : 0);
      }

      // Delivery-brief mode: compose the plan, verify, review, and CI-handoff
      // slices with a bounded CI result into a single head-bound completion
      // verdict (ship / hold / no-ship). Runs only the repository's own
      // canonical verify commands (via the handoff slice); never mutates the
      // repository or governance paths. Exit 0 only when the verdict is ship, 1
      // for hold or no-ship, 2 on a usage error.
      if (opts.deliveryBrief) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let ciResult;
        try {
          ciResult = parseCiResult(opts.ciResult);
        } catch (e) {
          process.stderr.write(`Error: ${(e as Error).message}\n`);
          process.exit(2);
        }
        const report = collectDeliveryBrief({
          workspace: opts.workspace,
          base: opts.base,
          ciResult,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatDeliveryBrief(report) + "\n");
        }
        process.exit(report.verdict === "ship" ? 0 : 1);
      }

      // Provider-contract mode: inspect the resolved provider extension contract
      // declared in the user settings file (versioned, redacted, read-only).
      // Proves the provider extension contract end to end — declare providers in
      // settings, negotiate the contract version, select one, and resolve its
      // non-secret configuration — without changing core code. Exit 0 on success,
      // 2 on a contract/usage error (unknown version, malformed section, unknown
      // provider, inlined credential, or invalid output format).
      if (opts.providerContract) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectProviderContract({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            providerId: opts.provider,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatProviderContract(report) + "\n");
        }
        process.exit(0);
      }

      // MCP-contract mode: inspect the resolved MCP server extension contract
      // declared in the user settings file (versioned, redacted, read-only).
      // Proves the MCP-lifecycle slice end to end — declare servers in settings,
      // negotiate the contract version, deterministically select one, and resolve
      // its lifecycle state (declared / ready / isolated) with safe failure
      // defaults — without changing core code. A disabled or unavailable server
      // resolves to "isolated" (exit 0); a contract/usage error exits 2.
      if (opts.mcpContract) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectMcpContract({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            serverId: opts.server,
            probe: opts.probe,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatMcpContract(report) + "\n");
        }
        process.exit(0);
      }

      // Tool-contract mode: inspect the resolved tool extension contract declared
      // in the user settings file (versioned, redacted, read-only). Completes the
      // provider/tool/MCP contract triad — declare tools in settings, negotiate
      // the contract version, deterministically select one, and resolve its
      // readiness state (declared / ready / isolated) with safe failure defaults —
      // without changing core code. A disabled or unavailable tool resolves to
      // "isolated" (exit 0); a contract/usage error exits 2.
      if (opts.toolContract) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectToolContract({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            toolId: opts.tool,
            probe: opts.probe,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatToolContract(report) + "\n");
        }
        process.exit(0);
      }

      // Tool-invocation mode: governed, non-interactive execution of exactly one
      // resolved-`ready` tool extension through its contract (#135), gated by the
      // command trust policy (#51) and the approval mode, confined to the
      // workspace, bounded by a hard timeout and an output-size cap, and redacted.
      // Exit 0 on a successful invocation; 2 for a contract/selection/version
      // error, a non-`ready` tool, a policy denial, or a missing approval (refused
      // before execution); 1 for a tool runtime failure (timeout, oversized
      // output, non-zero exit, or spawn error) — never crashing the run.
      if (opts.invokeTool) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const approvalMode = String(opts.approvalMode ?? "default");
        if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
          process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
          process.exit(2);
        }
        let timeoutMs: number | undefined;
        if (opts.invokeTimeout !== undefined) {
          timeoutMs = Number(opts.invokeTimeout);
          if (!Number.isFinite(timeoutMs)) {
            process.stderr.write(`Error: invalid --invoke-timeout "${opts.invokeTimeout}"\n`);
            process.exit(2);
          }
        }
        let report;
        try {
          report = await invokeTool({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            toolId: opts.tool,
            workspace: opts.workspace,
            approvalMode: approvalMode as ApprovalMode,
            timeoutMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatToolInvocation(report) + "\n");
        }
        process.exit(invocationExitCode(report));
      }

      // MCP-invocation mode: governed, non-interactive connection to exactly one
      // resolved-`ready` MCP server through its contract (#120), the initialize
      // handshake and tool listing over the safe local stdio transport, and the
      // call of exactly one tool — gated by the command trust policy (#51) and the
      // approval mode, confined to the workspace, bounded by a hard timeout and an
      // output-size cap, and redacted. Exit 0 on a successful tool call; 2 for a
      // contract/selection/version error, a non-`ready` server, a policy denial,
      // or a missing approval (refused before connecting); 1 for a session runtime
      // failure (handshake failure, timeout, oversized output, tool-selection
      // ambiguity, tool error, or spawn error) — never crashing the run.
      if (opts.invokeMcp) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const approvalMode = String(opts.approvalMode ?? "default");
        if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
          process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
          process.exit(2);
        }
        let timeoutMs: number | undefined;
        if (opts.invokeTimeout !== undefined) {
          timeoutMs = Number(opts.invokeTimeout);
          if (!Number.isFinite(timeoutMs)) {
            process.stderr.write(`Error: invalid --invoke-timeout "${opts.invokeTimeout}"\n`);
            process.exit(2);
          }
        }
        const toolArguments: Record<string, string> = {};
        for (const raw of opts.mcpArg ?? []) {
          const eq = raw.indexOf("=");
          const key = eq < 0 ? "" : raw.slice(0, eq);
          if (eq < 0 || key === "") {
            process.stderr.write(`Error: invalid --mcp-arg "${raw}" (expected key=value)\n`);
            process.exit(2);
          }
          toolArguments[key] = raw.slice(eq + 1);
        }
        let report;
        try {
          report = await invokeMcpServer({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            serverId: opts.server,
            toolName: opts.mcpTool,
            toolArguments,
            workspace: opts.workspace,
            approvalMode: approvalMode as ApprovalMode,
            timeoutMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatMcpInvocation(report) + "\n");
        }
        process.exit(mcpInvocationExitCode(report));
      }

      // Provider-invocation mode: governed, non-interactive issuance of exactly
      // one bounded model request to one resolved-`ready` provider through its
      // contract (#118), gated by readiness (credential available, endpoint
      // valid) and the approval mode, bounded by a hard timeout, a bounded
      // generation, and an output-size cap, and redacted. The credential value is
      // never printed. Exit 0 on a successful response; 2 for a
      // contract/selection/version error, a non-`ready` provider, or a missing
      // approval (refused before calling); 1 for a request runtime failure (empty
      // response, auth rejection, rate limit, network/API error, timeout, or
      // oversized output) — never crashing the run.
      if (opts.invokeProvider) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const approvalMode = String(opts.approvalMode ?? "default");
        if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
          process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
          process.exit(2);
        }
        let timeoutMs: number | undefined;
        if (opts.invokeTimeout !== undefined) {
          timeoutMs = Number(opts.invokeTimeout);
          if (!Number.isFinite(timeoutMs)) {
            process.stderr.write(`Error: invalid --invoke-timeout "${opts.invokeTimeout}"\n`);
            process.exit(2);
          }
        }
        let report;
        try {
          report = await invokeProvider({
            settingsPath: resolveSettingsPath(opts.settings),
            env: process.env,
            providerId: opts.provider,
            prompt: opts.providerPrompt,
            workspace: opts.workspace,
            approvalMode: approvalMode as ApprovalMode,
            timeoutMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatProviderInvocation(report) + "\n");
        }
        process.exit(providerInvocationExitCode(report));
      }

      // Extension-discovery mode: a single read-only view across the versioned
      // extension contracts. Composes the provider (#118) and MCP (#120) contract
      // resolvers into one redacted report of which extension surfaces are declared
      // and ready — without re-probing every integration (health inventory) and
      // without changing core code. An absent surface is reported (not an error);
      // a missing settings file reports every surface absent. Exit 0 on success,
      // 2 on an invalid contract (fail closed) or an invalid output format.
      if (opts.discoverExtensions) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectExtensionDiscovery({
            settingsPath: resolveSettingsPath(opts.settings),
            probe: opts.probe,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatExtensionDiscovery(report) + "\n");
        }
        process.exit(0);
      }

      // Extension-compatibility mode: publish the supported contract-version
      // matrix (provider, tool, MCP, workflow) and a proactive, redacted
      // compatibility verdict for the user settings file — before an unattended
      // run, instead of a fail-closed error mid-run. It reads only each section's
      // declared contractVersion (never entry ids or secrets) and never executes
      // or probes any extension. An unsupported version is a VERDICT (exit 0, an
      // audit not a gate); only a malformed settings root (invalid JSON or a
      // non-object) fails closed (exit 2), matching discovery's settings guarantee.
      if (opts.extensionCompat) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectExtensionCompat({
            settingsPath: resolveSettingsPath(opts.settings),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatExtensionCompat(report) + "\n");
        }
        process.exit(0);
      }

      // Concept-capability mode: publish the shared workbench concept contract
      // and the per-surface (TUI/Desktop) capability matrix with explicit parity
      // gaps. Fixed product metadata — it reads no settings, probes nothing, and
      // never throws for a supported concept — so a valid invocation always exits
      // 0; only an invalid --output value fails closed (exit 2).
      if (opts.capabilities) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const report = collectConceptCapabilities();
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatConceptCapabilities(report) + "\n");
        }
        process.exit(0);
      }

      // Session-continuity mode: report the real continuity state (bound head,
      // branch, pending approvals, surface of origin) rendered from the shared
      // concept contract. Read-only and never throws; a valid invocation exits 0.
      // With --assert-head <sha>, additionally guards a mutation against a moved
      // head and exits 1 (refused) when the head is stale, mirroring --recover's
      // exit semantics (0 current, 1 refused, 2 usage error).
      if (opts.continuity) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const state = collectContinuity();
        const assertHead = typeof opts.assertHead === "string" ? opts.assertHead : undefined;
        if (assertHead !== undefined) {
          const guard = assertHeadCurrent(assertHead);
          if (!guard.ok) {
            if (format === "json") {
              process.stdout.write(JSON.stringify({ continuity: state, guard }) + "\n");
            } else {
              process.stdout.write(formatContinuity(state) + "\n");
              process.stderr.write(`Refused: ${guard.reason}\n`);
            }
            process.exit(1);
          }
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(state) + "\n");
        } else {
          process.stdout.write(formatContinuity(state) + "\n");
        }
        process.exit(0);
      }

      // Activity-model mode: publish the canonical activity event presentation
      // model (event kinds, statuses, and the real runtime condition each status
      // maps to). Fixed product metadata — reads nothing, never throws — so a
      // valid invocation always exits 0; only an invalid --output value fails
      // closed (exit 2).
      if (opts.activityModel) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const model = collectActivityModel();
        if (format === "json") {
          process.stdout.write(JSON.stringify(model) + "\n");
        } else {
          process.stdout.write(formatActivityModel(model) + "\n");
        }
        process.exit(0);
      }

      // Failure-model mode: publish the canonical failure/waiting presentation
      // guidance (categories, outcome class, retryable, and the actionable next
      // step). Fixed product metadata — reads nothing, never throws — so a valid
      // invocation always exits 0; only an invalid --output value fails closed
      // (exit 2).
      if (opts.failureModel) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const model = collectFailureModel();
        if (format === "json") {
          process.stdout.write(JSON.stringify(model) + "\n");
        } else {
          process.stdout.write(formatFailureModel(model) + "\n");
        }
        process.exit(0);
      }

      // Lifecycle-model mode: publish the canonical Goal/Workflow lifecycle
      // projection model (node kinds, node states, terminal states, and the event
      // types that drive the projection). Fixed product metadata — reads nothing,
      // never throws — so a valid invocation always exits 0; only an invalid
      // --output value fails closed (exit 2).
      if (opts.lifecycleModel) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const model = collectLifecycleModel();
        if (format === "json") {
          process.stdout.write(JSON.stringify(model) + "\n");
        } else {
          process.stdout.write(formatLifecycleModel(model) + "\n");
        }
        process.exit(0);
      }

      // Mission-status mode: publish the mission-status surfacing contract — the
      // gate/retry/budget/waiting/failed categories surfaced from the lifecycle
      // projection and what each means. Fixed product metadata (the surfacing
      // contract, not a mission's runtime state) — reads nothing, never throws —
      // so a valid invocation always exits 0; only an invalid --output value
      // fails closed (exit 2).
      if (opts.missionStatus) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const descriptor = collectMissionStatusDescriptor();
        if (format === "json") {
          process.stdout.write(JSON.stringify(descriptor) + "\n");
        } else {
          process.stdout.write(formatMissionStatusDescriptor(descriptor) + "\n");
        }
        process.exit(0);
      }

      // Intervention-model mode: publish the mission-intervention contract — the
      // inspect/pause/resume/approve/reject/cancel/open-receipt operations,
      // whether each mutates, and the lifecycle state each maps to. Fixed product
      // metadata (the intervention contract, not a mission's runtime state) —
      // reads nothing, never throws — so a valid invocation always exits 0; only
      // an invalid --output value fails closed (exit 2).
      if (opts.interventionModel) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const descriptor = collectInterventionDescriptor();
        if (format === "json") {
          process.stdout.write(JSON.stringify(descriptor) + "\n");
        } else {
          process.stdout.write(formatInterventionDescriptor(descriptor) + "\n");
        }
        process.exit(0);
      }

      // Reconnect-model mode: publish the mission-reconnect contract — the
      // deterministic-replay / no-history-rewrite / incremental-continuation
      // guarantees and the durable event types replayed. Fixed product metadata
      // (the reconnect contract, not a mission's runtime state) — reads nothing,
      // never throws — so a valid invocation always exits 0; only an invalid
      // --output value fails closed (exit 2).
      if (opts.reconnectModel) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const descriptor = collectReconnectDescriptor();
        if (format === "json") {
          process.stdout.write(JSON.stringify(descriptor) + "\n");
        } else {
          process.stdout.write(formatReconnectDescriptor(descriptor) + "\n");
        }
        process.exit(0);
      }

      // Recovery mode: decide whether an interrupted task can safely resume from
      // a durable checkpoint, offline (no provider config needed). Exits 0 when
      // resume is safe, 1 when the checkpoint is refused, 2 on a usage/input error.
      if (opts.recover) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (!opts.checkpoint) {
          process.stderr.write("Error: --recover requires --checkpoint <file>\n");
          process.exit(2);
        }
        if (!opts.taskIdentity) {
          process.stderr.write("Error: --recover requires --task-identity <id>\n");
          process.exit(2);
        }
        let checkpoint: ReturnType<typeof readRecoveryCheckpoint>;
        let evidence: Record<string, string>;
        try {
          checkpoint = readRecoveryCheckpoint(opts.checkpoint);
          evidence = opts.evidence ? readEvidenceFile(opts.evidence) : {};
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        const context: RecoveryContext = {
          taskIdentity: redactSecrets(String(opts.taskIdentity)).text,
          repoHead: currentRepoHead(opts.workspace),
          evidence,
        };
        const plan = evaluateRecovery(checkpoint, context);
        if (format === "json") {
          process.stdout.write(JSON.stringify(plan) + "\n");
        } else {
          process.stdout.write(formatRecoveryPlan(plan) + "\n");
        }
        process.exit(plan.decision === "resume" ? 0 : 1);
      }

      // Evidence-archive export mode: compose a portable, signed evidence bundle
      // from already-redacted run artifacts, offline (no provider config needed).
      // Exits 0 on success, 2 on a usage/input error.
      if (opts.exportEvidence !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (!opts.summaryFile && !opts.checkpoint && !opts.evidence && !opts.outcomesFile) {
          process.stderr.write(
            "Error: --export-evidence needs at least one of --summary-file, --checkpoint, --evidence, or --outcomes-file\n",
          );
          process.exit(2);
        }
        const input: EvidenceInput = {};
        try {
          if (opts.summaryFile) input.summary = readRunSummaryFile(String(opts.summaryFile), "summary");
          if (opts.checkpoint) input.checkpoint = readRecoveryCheckpoint(String(opts.checkpoint));
          if (opts.evidence) input.contentDigests = readEvidenceFile(String(opts.evidence));
          if (opts.outcomesFile) input.outcomes = readCommandOutcomes(String(opts.outcomesFile));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (opts.taskIdentity) input.source = { task: String(opts.taskIdentity) };
        try {
          const bundle = buildEvidenceBundle(input);
          writeEvidenceBundle(String(opts.exportEvidence), bundle);
          if (format === "json") {
            process.stdout.write(JSON.stringify(bundle) + "\n");
          } else {
            process.stdout.write(formatEvidenceExport(bundle) + "\n");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        process.exit(0);
      }

      // Evidence-archive verify mode: check a portable evidence bundle's manifest
      // signature and per-entry digests offline (no provider config needed). Exits
      // 0 when the bundle is intact, 1 when it is tampered, 2 on a usage/input error.
      if (opts.verifyEvidence !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let bundle: ReturnType<typeof readEvidenceBundle>;
        try {
          bundle = readEvidenceBundle(String(opts.verifyEvidence));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        const result = verifyEvidenceBundle(bundle);
        if (format === "json") {
          process.stdout.write(JSON.stringify(result) + "\n");
        } else {
          process.stdout.write(formatEvidenceVerification(result) + "\n");
        }
        process.exit(result.ok ? 0 : 1);
      }

      // List-workspaces mode: a read-only, bounded, redacted graph of the leased
      // parallel workspaces (worktree-lease.ts collectWorktreeGraph). Never mutates
      // anything. Exits 0 (an empty lease set is an empty graph, not an error);
      // exits 2 on a usage error or a non-repository target.
      if (opts.listWorkspaces) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let graph;
        try {
          graph = collectWorktreeGraph({ repo: opts.workspace, worktreeRoot: opts.worktreeRoot });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(graph) + "\n");
        } else {
          process.stdout.write(formatWorktreeGraph(graph) + "\n");
        }
        process.exit(0);
      }

      // Handoff mode: a read-only, bounded, redacted handoff brief for one specific
      // leased workspace (worktree-lease.ts collectWorktreeHandoff), identified by
      // --task-identity/--agent-identity. Never mutates anything. Exits 0 (an
      // absent lease is an absent handoff, not an error); exits 2 on a usage error
      // (missing identity) or a non-repository target.
      if (opts.handoff) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (!opts.taskIdentity) {
          process.stderr.write("Error: --handoff requires --task-identity <id>\n");
          process.exit(2);
        }
        if (!opts.agentIdentity) {
          process.stderr.write("Error: --handoff requires --agent-identity <id>\n");
          process.exit(2);
        }
        let handoff;
        try {
          handoff = collectWorktreeHandoff({
            repo: opts.workspace,
            taskIdentity: String(opts.taskIdentity),
            agentIdentity: String(opts.agentIdentity),
            worktreeRoot: opts.worktreeRoot,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(handoff) + "\n");
        } else {
          process.stdout.write(formatWorktreeHandoff(handoff) + "\n");
        }
        process.exit(0);
      }

      // Leased-worktree mode: create or clean one isolated git worktree per
      // mutating delegated agent, offline (no provider config needed). Exits 0
      // on success (including idempotent no-ops), 1 on a safety refusal, and 2
      // on a usage error or unexpected git failure.
      if (opts.createWorktree || opts.cleanWorktree || opts.cancelWorktree) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const chosen = [opts.createWorktree, opts.cleanWorktree, opts.cancelWorktree].filter(Boolean).length;
        if (chosen > 1) {
          process.stderr.write("Error: choose one of --create-worktree, --clean-worktree, or --cancel-worktree\n");
          process.exit(2);
        }
        if (!opts.taskIdentity) {
          process.stderr.write("Error: worktree lease requires --task-identity <id>\n");
          process.exit(2);
        }
        if (!opts.agentIdentity) {
          process.stderr.write("Error: worktree lease requires --agent-identity <id>\n");
          process.exit(2);
        }
        const leaseOpts = {
          repo: opts.workspace,
          taskIdentity: String(opts.taskIdentity),
          agentIdentity: String(opts.agentIdentity),
          worktreeRoot: opts.worktreeRoot,
        };
        if (opts.cancelWorktree) {
          const cancelResult = cancelWorktreeLease(leaseOpts, { force: Boolean(opts.cancelForce) });
          if (format === "json") {
            process.stdout.write(JSON.stringify(cancelResult) + "\n");
          } else {
            process.stdout.write(formatWorktreeCancelResult(cancelResult) + "\n");
          }
          process.exit(cancelResult.ok ? 0 : cancelResult.reason === "git_error" ? 2 : 1);
        }
        const result = opts.createWorktree
          ? createWorktreeLease(leaseOpts)
          : cleanWorktreeLease(leaseOpts);
        if (format === "json") {
          process.stdout.write(JSON.stringify(result) + "\n");
        } else {
          process.stdout.write(
            formatWorktreeLeaseResult(result, opts.createWorktree ? "create" : "clean") + "\n",
          );
        }
        process.exit(result.ok ? 0 : result.reason === "git_error" ? 2 : 1);
      }

      // Health mode (Issue #12): a read-only inventory of the configured
      // MCP servers and extensions, probed shallowly with a hard timeout
      // and never mutating settings or integration state. Exits 0 on a
      // successful probe — the inventory is diagnostic output, not a
      // failure signal. With --strict (Issue #690) the exit code signals
      // the findings for automation: 1 when the settings cannot be parsed
      // or any enabled integration is unhealthy (unavailable or
      // misconfigured), 0 otherwise — disabled entries and an empty
      // inventory are honest zero states, never failures.
      if (opts.health) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const settingsPath = resolveSettingsPath(opts.settings);
        const inventory = await collectHealthInventory(settingsPath);
        if (format === "json") {
          // Machine-readable record (Issue #694): the same facts as the
          // text surface as stable, versioned fields. --strict composes —
          // the output is identical, the exit code signals.
          process.stdout.write(JSON.stringify(healthInventoryRecord(inventory)) + "\n");
        } else {
          process.stdout.write(renderReportLines(formatHealthInventory(inventory), opts.ascii));
        }
        process.exit(opts.strict === true ? healthInventoryStrictExit(inventory) : 0);
      }

      if (opts.sandboxInfo) {
        const diag = collectSandboxDiagnostic(
          opts.approvalMode,
          opts.workspace ?? null,
          Boolean(process.stdin.isTTY),
        );
        process.stdout.write(formatDiagnostic(diag) + "\n");
        process.exit(0);
      }

      if (opts.trustInfo) {
        const enforcing =
          Boolean(opts.enforceFolderTrust) || process.env.OMC_ENFORCE_FOLDER_TRUST === "1";
        const ft = resolveFolderTrust({
          workspacePath: opts.workspace,
          env: process.env,
          trustThisRun: Boolean(opts.trust),
        });
        process.stdout.write(
          formatFolderTrust({
            workspacePath: opts.workspace,
            decision: ft.decision,
            sandbox: ft.sandbox,
            enforcing,
          }) + "\n",
        );
        process.exit(0);
      }

      // Trust-posture mode: compose the folder-trust decision, sandbox isolation,
      // approval mode, extension readiness, and the extension contract-version
      // compatibility verdict into one redacted, read-only view (folder-trust.ts +
      // sandbox-diag.ts + approval.ts + extension-discovery.ts + extension-compat.ts).
      // It is an audit, not a gate: it never mutates the trust store or settings
      // and always exits 0 — even an invalid extension contract is surfaced as a
      // visible warning rather than thrown. Exit 2 only on a usage error.
      if (opts.trustPosture) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const approvalMode = String(opts.approvalMode ?? "default");
        if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
          process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
          process.exit(2);
        }
        const enforcing =
          Boolean(opts.enforceFolderTrust) || process.env.OMC_ENFORCE_FOLDER_TRUST === "1";
        const report = collectTrustPosture({
          workspacePath: opts.workspace,
          approvalMode: approvalMode as ApprovalMode,
          settingsPath: resolveSettingsPath(opts.settings),
          env: process.env,
          trustThisRun: Boolean(opts.trust),
          enforcing,
          isTTY: Boolean(process.stdin.isTTY),
          probe: opts.probe,
        });
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatTrustPosture(report) + "\n");
        }
        process.exit(0);
      }

      // Conflict-prediction mode: predict read-only whether merging a source
      // revision into a target would conflict (conflict-prediction.ts). It runs
      // `git merge-tree` (no working-tree mutation, no commit) and fails closed on
      // a dirty tree, an unresolvable revision, or a merge-tree error. Exits 0 on a
      // successful prediction (clean or conflict); exits 2 on a usage/state error.
      if (opts.predictConflict) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const source = String(opts.predictConflict);
        const target = opts.conflictTarget ? String(opts.conflictTarget) : "HEAD";
        let prediction;
        try {
          prediction = predictMergeConflict(opts.workspace, source, target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(prediction) + "\n");
        } else {
          process.stdout.write(formatConflictPrediction(prediction) + "\n");
        }
        process.exit(0);
      }

      // Selective-integration mode: reviewably integrate a source branch into the
      // current branch (selective-integration.ts). It reuses conflict prediction
      // (#226) to refuse a conflicting merge, shows a bounded/redacted preview, and
      // performs a non-fast-forward merge that preserves commit identity. Fails
      // closed on a detached HEAD, dirty tree, unresolvable revision, predicted
      // conflict, or failed merge. Exits 0 on success; exits 2 on a usage/state
      // error.
      if (opts.integrate) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let result;
        try {
          result = integrateBranch(opts.workspace, String(opts.integrate), {
            dryRun: Boolean(opts.integrateDryRun),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(result) + "\n");
        } else {
          process.stdout.write(formatIntegrationResult(result) + "\n");
        }
        process.exit(0);
      }

      // Effective-settings mode: the one immutable, validated, hierarchical
      // settings snapshot — defaults < user settings < trusted project settings <
      // environment overrides < CLI overrides — with redacted provenance
      // (effective-settings.ts). The project scope is considered only after folder
      // trust and can never set a credential endpoint or security-policy field. It
      // is a read-only audit that exits 0; a malformed or unknown settings field
      // exits 2 as a usage/input error.
      if (opts.effectiveSettings) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let snapshot;
        try {
          snapshot = resolveEffectiveSettings({
            userSettingsPath: resolveSettingsPath(opts.settings),
            workspacePath: opts.workspace,
            env: process.env,
            trustThisRun: Boolean(opts.trust),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(snapshot) + "\n");
        } else {
          process.stdout.write(formatEffectiveSettings(snapshot) + "\n");
        }
        process.exit(0);
      }

      // List-workflows mode: a read-only, redacted inventory of the workflows
      // declared in the user-owned settings scope (workflow-contract.ts). The
      // project scope is never read, so an untrusted repository cannot surface a
      // workflow. Exits 0 on success; a malformed/unknown contract or an invalid
      // output format exits 2 as a usage/input error.
      if (opts.listWorkflows) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectWorkflowList({ settingsPath: resolveSettingsPath(opts.settings) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatWorkflowList(report) + "\n");
        }
        process.exit(0);
      }

      // List-hooks mode: a read-only, redacted inventory of the PreToolUse hooks
      // declared in the user-owned settings scope (hook-contract.ts). The project
      // scope is never read, so an untrusted repository cannot surface a hook.
      // Exits 0 on success (an absent `hooks` section lists as an empty inventory);
      // a malformed/unknown contract or an invalid output format exits 2 as a
      // usage/input error.
      if (opts.listHooks) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectHookList({ settingsPath: resolveSettingsPath(opts.settings) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatHookList(report) + "\n");
        }
        process.exit(0);
      }

      // List-profiles mode: a read-only, redacted inventory of the model profiles
      // declared in the user-owned settings scope (model-profiles.ts). The project
      // scope is never read, so an untrusted repository cannot surface a profile.
      // Exits 0 on success; a malformed section or an invalid output format exits 2
      // as a usage/input error.
      if (opts.listProfiles) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        let report;
        try {
          report = collectProfileList({ settingsPath: resolveSettingsPath(opts.settings) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatProfileList(report) + "\n");
        }
        process.exit(0);
      }

      // Run-workflow mode: run a named workflow from the user-owned settings scope
      // non-interactively (workflow-runner.ts). Each step is a bounded prompt run
      // through the existing headless `-p` path in its own process; steps run in
      // declared order and the first failing step halts the run. Output is
      // redacted in both human (streamed per-step) and machine (single summary)
      // modes. Resolution/usage errors exit 2; a completed run exits 0 and a
      // halted run exits 1 (matching the headless run-outcome convention).
      if (opts.runWorkflow !== undefined) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const name = String(opts.runWorkflow ?? "").trim();
        if (name === "") {
          process.stderr.write("Error: --run-workflow requires a workflow name\n");
          process.exit(2);
        }
        let report;
        const workflowFormat = {
          style: workflowConsoleStyle(
            detectColorDepth({
              noColor: opts.color === false,
              env: process.env,
              isTTY: process.stdout.isTTY,
            }),
          ),
          width: process.stdout.columns ?? 80,
        };
        try {
          report = await runWorkflow({
            name,
            settingsPath: resolveSettingsPath(opts.settings),
            workspace: opts.workspace,
            env: process.env,
            onWorkflowStart:
              format === "text"
                ? (start) => {
                    process.stdout.write(formatWorkflowStart(start, workflowFormat) + "\n");
                  }
                : undefined,
            onStepStart:
              format === "text"
                ? (step, stepsTotal) => {
                    process.stdout.write(
                      formatWorkflowStepStart(step, stepsTotal, workflowFormat) + "\n",
                    );
                  }
                : undefined,
            onStepEnd:
              format === "text"
                ? (step, stepsTotal) => {
                    process.stdout.write(
                      formatWorkflowStepLine(step, stepsTotal, workflowFormat) + "\n",
                    );
                  }
                : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(report) + "\n");
        } else {
          process.stdout.write(formatWorkflowOutcome(report, workflowFormat) + "\n");
        }
        process.exit(report.result === "completed" ? 0 : 1);
      }

      if (opts.trustWorkspace) {
        const storePath = defaultTrustStorePath();
        const key = workspaceTrustKey(opts.workspace);
        const store = addTrusted(loadTrustStore(storePath), key);
        saveTrustStore(storePath, store);
        process.stdout.write(
          `Trusted workspace ${redactHomePath(opts.workspace)} (store: ${redactHomePath(storePath)})\n`,
        );
        process.exit(0);
      }

      // Offline mode (Issue #576): --offline or OMC_OFFLINE=1 guards provider
      // dispatch for the whole run; read-only surfaces and local tools are
      // unaffected.
      const offlineRequested = Boolean(opts.offline) || isOfflineRequested(process.env);

      if (opts.preflight) {
        const resolved = resolveModelProfileConfig({
          settingsPath: resolveSettingsPath(opts.settings),
          env: process.env,
          profile: opts.profile,
          workspaceEnv: loadWorkspaceEnv({
            workspacePath: opts.workspace,
            trustThisRun: Boolean(opts.trust),
          }),
        });
        process.stderr.write(describeResolvedConfig(resolved) + "\n");
        // Offline posture is reported without any network probe (Issue #576).
        if (offlineRequested) resolved.config.offline = true;
        // One-shot fallback model (Issue #590): resolved and validated
        // alongside the primary; an invalid override fails closed.
        try {
          const fallback = resolveFallbackModelOverride(
            opts.fallbackModel,
            process.env.OMC_FALLBACK_MODEL,
            resolved.config.model,
          );
          if (fallback !== undefined) resolved.config.fallbackModel = fallback;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(1);
        }
        const result = await runPreflight(resolved.config);
        process.stdout.write(formatPreflight(result) + "\n");
        process.exit(result.ok ? 0 : 1);
      }

      const settingsPath = resolveSettingsPath(opts.settings);
      const resolved = resolveModelProfileConfig({
        settingsPath,
        env: process.env,
        profile: opts.profile,
        // Issue #509: a trusted workspace's `.env` feeds model-config
        // resolution as the layer under the real environment.
        workspaceEnv: loadWorkspaceEnv({
          workspacePath: opts.workspace,
          trustThisRun: Boolean(opts.trust),
        }),
      });
      const config = resolved.config;
      // Offline mode (Issue #576): provider dispatch to non-loopback
      // endpoints is refused fail-closed before any network I/O. It guards
      // only provider dispatch — read-only surfaces and local tools keep
      // working.
      if (offlineRequested) {
        config.offline = true;
        process.stderr.write(
          "Offline mode: provider routes are restricted to loopback endpoints.\n",
        );
      }
      // One-shot fallback model (Issue #590): --fallback-model wins over
      // OMC_FALLBACK_MODEL; an invalid override fails closed before any work.
      try {
        const fallback = resolveFallbackModelOverride(
          opts.fallbackModel,
          process.env.OMC_FALLBACK_MODEL,
          config.model,
        );
        if (fallback !== undefined) config.fallbackModel = fallback;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }
      const store = new SessionStore();

      // Side question (Issue #200): ask a bounded, read-only question against a
      // session's context without disturbing the main task. The provider call
      // carries no tool schemas, no workspace/session/goal handle is passed, and
      // the source session is only read — so nothing is mutated and nothing is
      // persisted. Answers stream to stdout; the boundary summary goes to stderr.
      if (opts.sideQuestion !== undefined) {
        const question = String(opts.sideQuestion);
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }
        let contextMessages: SessionMessage[] = [];
        if (opts.session !== undefined) {
          // Id-or-name targeting (#536).
          const resolved = resolveSessionTarget(String(opts.session), store);
          if (!resolved.ok) {
            process.stderr.write(`Error: ${resolved.reason}\n`);
            process.exit(2);
          }
          const sourceId = resolved.sessionId;
          if (store.integrity(sourceId).status === "missing") {
            process.stderr.write(`Error: session "${sourceId}" not found\n`);
            process.exit(2);
          }
          contextMessages = loadSessionMessages(store, sourceId);
        }
        const context = buildSideContext(contextMessages);
        process.stderr.write(`${formatSideContextSummary(context)}\n`);
        const result = await runSideQuestion({
          config,
          context,
          question,
          onDelta: (delta) => {
            if (format === "text") process.stdout.write(delta);
          },
        });
        if (format === "json") {
          process.stdout.write(
            JSON.stringify({
              schema: SIDE_QUESTION_SCHEMA,
              v: SIDE_QUESTION_VERSION,
              ok: result.ok,
              reason: result.reason,
              answer: result.text,
              context: {
                sourceMessageCount: context.sourceMessageCount,
                included: context.included,
                truncated: context.truncated,
              },
            }) + "\n",
          );
        } else {
          process.stdout.write("\n");
        }
        process.exit(result.ok ? 0 : 1);
      }

      // Interactive session browser (Issue #197): pick an exact session to
      // resume before the conversation starts. Runs only with a terminal; a
      // cancel exits cleanly. The chosen session's declared workspace is
      // restored, and a missing/corrupt/stale selection fails closed instead of
      // silently resuming something else. The active session and any draft are
      // untouched until a selection is confirmed.
      let browseResume: { sessionId: string; workspace?: string } | null = null;
      if (opts.browseSessions) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write("Error: --browse-sessions requires an interactive terminal.\n");
          process.exit(1);
        }
        const pickerColor = colorEnabled({ noColor: opts.color === false, env: process.env });
        const picked = await runSessionPicker(store, process.stdin, process.stdout, {
          color: pickerColor,
        });
        if (!picked) {
          process.stderr.write("No session selected.\n");
          process.exit(0);
        }
        const target = resolveResumeTarget(picked.sessionId, store);
        if (!target.ok) {
          process.stderr.write(`Cannot resume: ${target.reason}\n`);
          process.exit(1);
        }
        browseResume = { sessionId: target.sessionId, workspace: target.workspace };
      }

      const workspace = new Workspace(browseResume?.workspace ?? opts.workspace);
      // Mutable: the interactive surfaces switch the effective mode at runtime
      // (Issue #715). Initialized from the startup flag; never persisted.
      let approvalMode = opts.approvalMode as ApprovalMode;

      if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
        process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
        process.exit(1);
      }

      // Folder-trust boundary: when enforcement is on, an untrusted workspace
      // fails closed for every mutating tool (approval modes stay subordinate,
      // so yolo cannot widen it). Off by default; read-only tools are unaffected.
      // Computed lazily so a non-enforcing run pays no cost and behaves exactly
      // as before.
      const enforcingFolderTrust =
        Boolean(opts.enforceFolderTrust) || process.env.OMC_ENFORCE_FOLDER_TRUST === "1";
      let mutatingAllowed = true;
      if (enforcingFolderTrust) {
        const folderTrust = resolveFolderTrust({
          workspacePath: workspace.root,
          env: process.env,
          trustThisRun: Boolean(opts.trust),
        });
        mutatingAllowed = folderTrust.decision.mutatingAllowed;
        if (!mutatingAllowed) {
          process.stderr.write(
            `Folder trust: ${folderTrust.decision.state} — mutating tools denied (fail closed). ` +
              `Trust with --trust (this run) or --trust-workspace (durable), or set OMC_SANDBOX=enforced.\n`,
          );
        }
      }

      // Optional spend budget (flag overrides env). Invalid values fail fast with
      // an actionable message rather than silently disabling enforcement.
      let budgetUsd: number | null = null;
      try {
        budgetUsd = parseBudgetUsd(opts.budget ?? process.env.OMC_SPEND_BUDGET_USD);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }

      // Operator run caps (Issue #515): turn and wall-time bounds for bounded
      // unattended execution. Same flag-then-env convention as --budget; an
      // invalid value is a usage error rather than a silent disable.
      let maxTurns: number | null = null;
      try {
        maxTurns = parseMaxTurns(opts.maxTurns ?? process.env.OMC_MAX_TURNS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }
      let maxWallTimeMs: number | null = null;
      try {
        maxWallTimeMs = parseWallTimeMs(opts.maxWallTime ?? process.env.OMC_MAX_WALL_TIME);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }
      // Tool-call cap (Issue #517): same convention; bounds cumulative tool
      // activity for runs where turns and wall time alone are not enough.
      let maxToolCalls: number | null = null;
      try {
        maxToolCalls = parseMaxToolCalls(opts.maxToolCalls ?? process.env.OMC_MAX_TOOL_CALLS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }

      // Persist the run summary artifact when requested (Issue #519). Independent
      // of `--summary` printing: automation needs the schema-versioned file the
      // scorecard and evidence-export surfaces already consume. A failed write
      // (existing target without --force, missing parent directory) fails
      // closed — the artifact was requested but not delivered.
      const persistSummary = (summary: RunSummary): void => {
        if (opts.summaryOut === undefined) return;
        try {
          writeRunSummaryFile(summary, String(opts.summaryOut), Boolean(opts.force));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${msg}\n`);
          process.exit(1);
        }
      };

      // Context-pressure auto-compaction threshold (tokens). Honors the flag then
      // the env var; absent/blank disables it, an unparseable value is a usage
      // error rather than a silent disable.
      let compactThreshold: number | undefined;
      const compactRaw = opts.compactThreshold ?? process.env.OMC_COMPACT_THRESHOLD;
      if (compactRaw !== undefined && String(compactRaw).trim() !== "") {
        const parsed = Number(String(compactRaw));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          process.stderr.write(`Error: invalid compact threshold "${compactRaw}" (expected a positive integer)\n`);
          process.exit(1);
        }
        compactThreshold = Math.floor(parsed);
      }

      // --continue (Issue #513): one-step return to work. Resolves the most
      // recent healthy session declared for this workspace and hands it to the
      // existing resume path exactly as `--resume <id>` would. Selection is
      // read-only and fail-closed: no match never silently starts a fresh
      // session, and another workspace's session is never resumed. Matching
      // uses the canonical workspace identity (the same one folder trust uses),
      // so symlink aliases and linked worktrees match the parent workspace's
      // sessions.
      let continueResumeId: string | undefined;
      if (opts.continue) {
        if (opts.resume !== undefined || opts.browseSessions) {
          process.stderr.write(
            "Error: --continue cannot be combined with --resume or --browse-sessions\n",
          );
          process.exit(1);
        }
        const picked = pickContinueSession(
          // Discovery semantics (archived never picked, pinned preferred)
          // live inside pickContinueSession itself (Issue #616).
          collectSessionSummaries(store),
          workspaceTrustKey(opts.workspace),
        );
        if (!picked.ok) {
          const reason =
            picked.reason === "only-corrupt"
              ? "the most recent sessions for this workspace are corrupt and cannot be resumed safely; see --list-sessions"
              : "no resumable session found for this workspace; list sessions with --list-sessions or start a new one";
          process.stderr.write(`Cannot continue: ${reason}\n`);
          process.exit(1);
        }
        const modelNote = picked.model ? ` (model: ${redactSecrets(picked.model).text})` : "";
        process.stderr.write(
          `Continuing session ${shortSessionId(picked.sessionId)}${modelNote} — selected for this workspace\n`,
        );
        continueResumeId = picked.sessionId;
      }

      // One-shot fallback model (Issue #590): an unusable fallback fails
      // closed here — before any session or provider work — instead of
      // surfacing mid-run as a failed degrade. Task-fixture replays drive a
      // scripted provider and never touch the network, so they skip the probe
      // and never receive a fallback.
      if (config.fallbackModel !== undefined && opts.replayFixture === undefined) {
        const fallbackProbe = await validateFallbackModel(config);
        if (!fallbackProbe.ok) {
          process.stderr.write(
            `✗ Fallback model preflight failed [${fallbackProbe.category}]: ${fallbackProbe.message}\n`,
          );
          process.exit(1);
        }
      }

      let sessionId: string;
      let existingMessages: SessionMessage[] = [];

      // A picker selection resumes the exact chosen session (validated fail-closed
      // at selection time). A --resume <id> given on the command line must also
      // resolve to a readable session: fail closed before any provider interaction
      // when the id is empty, the session is missing, or the checkpoint cannot be
      // resumed safely — silently starting fresh would drop the context the user
      // asked to resume. An exact session id wins; when no session exists under
      // the id, the value resolves as a user-owned session name (#534) with the
      // same fail-closed semantics (ambiguous and corrupt matches are reported,
      // never substituted).
      let resumeFlagSessionId: string | undefined;
      if (browseResume === null && opts.resume !== undefined) {
        const target = resolveSessionTarget(String(opts.resume), store);
        if (!target.ok) {
          process.stderr.write(`Cannot resume: ${target.reason}\n`);
          process.exit(1);
        }
        // Workspace binding guard (#554): a --resume target is never silently
        // resumed into a different workspace. The comparison uses the same
        // canonical identity as --continue (symlink aliases and linked
        // worktrees of one repository still match); a legacy session without
        // workspace metadata warns but is not blocked. Runs before any
        // provider interaction; the refusal itself never mutates anything.
        const binding = checkResumeWorkspaceBinding(target.workspace, workspace.root);
        if (binding.verdict === "mismatch") {
          process.stderr.write(
            resumeWorkspaceMismatchMessage(target.sessionId, binding.sessionWorkspace, workspace.root),
          );
          process.exit(1);
        }
        if (binding.verdict === "legacy") {
          process.stderr.write(resumeWorkspaceLegacyMessage(target.sessionId));
        }
        resumeFlagSessionId = target.sessionId;
      }
      const resumeId = browseResume?.sessionId ?? resumeFlagSessionId ?? continueResumeId;
      // Immediate Goal status summary on resume (Issue #584): one bounded line
      // when the resumed session carries a durable goal; silent when it does
      // not. Shown on stderr for every resume path (picker, --resume,
      // --continue) and surfaced in the TUI transcript below.
      let resumeGoalNotice: string | null = null;
      // Advisory session lock (Issue #741): acquired before the session is
      // read or written so a concurrent opener fails fast and honestly
      // instead of interleaving writers. Released on process exit; a stale
      // lock (dead holder) self-heals on acquire.
      let sessionLock: SessionLock | null = null;
      const failLockClosed = (lock: SessionLock, result: { holder: SessionLockInfo }): void => {
        process.stderr.write(
          `Cannot resume: session ${shortSessionId(sessionId)} appears to be in use by process ${result.holder.pid}.\n` +
            `Resume a different session, or if that process is gone, remove ${lock.filePath} and retry.\n`,
        );
        process.exit(1);
      };
      if (resumeId) {
        sessionId = resumeId;
        sessionLock = store.openLock(sessionId);
        const lockResult = sessionLock.acquire();
        if (!lockResult.acquired) failLockClosed(sessionLock, lockResult);
        // Heal an interrupted checkpoint before loading (promotes a complete temp
        // left by an interrupted write). Recovery is scoped to this session and
        // never touches sibling sessions. A checkpoint that cannot be healed fails
        // closed instead of silently starting fresh.
        const recovery = store.recover(sessionId);
        if (recovery.action === "quarantined") {
          process.stderr.write(
            `Cannot resume: session ${shortSessionId(sessionId)} is corrupt and cannot be resumed safely\n`,
          );
          process.exit(1);
        }
        existingMessages = loadSessionMessages(store, sessionId);
        if (existingMessages.length === 0) {
          process.stderr.write(`Warning: session ${sessionId} is empty\n`);
        }
        // A resumed run may select a different profile (or model) than the session
        // was created under. Explain the change visibly before continuing; the
        // conversation, tool, usage, and approval history loaded above is left
        // intact. Model and profile names are non-secret identifiers.
        const meta = store.readMeta(sessionId);
        if (meta) {
          const parts: string[] = [];
          if (meta.model !== undefined && meta.model !== config.model) {
            parts.push(`model ${meta.model} → ${config.model}`);
          }
          if ((meta.profile ?? undefined) !== (resolved.profile ?? undefined)) {
            parts.push(`profile ${meta.profile ?? "(none)"} → ${resolved.profile ?? "(none)"}`);
          }
          if (parts.length > 0) {
            process.stderr.write(
              `Warning: resuming session ${sessionId} with a changed model configuration ` +
                `(${parts.join("; ")}); conversation, tool, and approval history are preserved.\n`,
            );
          }
        }
        // Surface the resumed session's durable Goal immediately (Issue #584).
        // Derived read-only via readGoal; absent or corrupt sidecars stay
        // silent (null) and the resume itself is never altered.
        resumeGoalNotice = resumeGoalSummaryLine(store, sessionId);
        if (resumeGoalNotice !== null) {
          process.stderr.write(`${resumeGoalNotice}\n`);
        }
      } else {
        sessionId = store.newId();
        store.writeMeta(sessionId, {
          model: config.model,
          ...(resolved.profile ? { profile: resolved.profile } : {}),
          workspace: workspace.root,
          createdAt: Date.now(),
        });
        // Lock fresh sessions too: a second process must not be able to
        // resume this id while this run is still writing it.
        sessionLock = store.openLock(sessionId);
        const lockResult = sessionLock.acquire();
        if (!lockResult.acquired) failLockClosed(sessionLock, lockResult);
      }
      // Release the advisory lock on any exit path (normal exit, process.exit
      // from signal handlers). A kill -9 leaves a stale lock, which the next
      // opener self-heals via the pid-liveness check.
      process.once("exit", () => {
        sessionLock?.release();
      });

      const onMessage = (msg: SessionMessage) => {
        store.append(sessionId, msg);
      };

      // Atomically seal the session after a non-interactive run so the canonical
      // checkpoint is always complete (no trailing partial) and crash-safe.
      const sealSession = () => {
        store.checkpoint(sessionId, store.load(sessionId), store.readMeta(sessionId));
      };

      // Resolve user-owned PreToolUse hooks once (user settings scope only) so a
      // matching hook can gate tool calls in both the headless and interactive
      // paths. A malformed/oversized hooks section fails closed before any tool
      // runs (exit 2), consistent with the other settings listings; an absent
      // `hooks` section yields no hooks.
      let preToolUseHooks: PreToolUseHook[] = [];
      try {
        preToolUseHooks = resolvePreToolUseHooks({ settingsPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(2);
      }

      if (opts.prompt || opts.replayFixture) {
        // Non-interactive mode
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }

        // Task-fixture replay (#224): load the fixture (fail closed) and drive the
        // run from its bounded prompt and deterministic script instead of the
        // network provider, so the same fixture reproduces the same run.
        let replayFixture: TaskFixture | null = null;
        if (opts.replayFixture) {
          try {
            replayFixture = readTaskFixtureFile(String(opts.replayFixture));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`${msg}\n`);
            process.exit(2);
          }
        }
        let runPrompt: string | undefined = replayFixture ? replayFixture.prompt : undefined;
        if (!replayFixture && opts.prompt !== undefined) {
          // -p/--prompt resolution (Issue #759): the value argument wins; a
          // valueless flag reads the prompt from piped stdin; a TTY cannot be
          // a pipe and gets one honest usage error.
          const source = resolveHeadlessPromptSource(opts.prompt, Boolean(process.stdin.isTTY));
          if (source.kind === "error") {
            process.stderr.write(`${source.message}\n`);
            process.exit(1);
          }
          if (source.kind === "value") {
            runPrompt = source.value;
          } else {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
            const piped = normalizeStdinPrompt(Buffer.concat(chunks).toString("utf8"));
            if (piped === null) {
              process.stderr.write(
                "Error: stdin was empty — pipe a prompt into -p or pass it as an argument.\n",
              );
              process.exit(1);
            }
            runPrompt = piped;
          }
        }
        if (!runPrompt) {
          process.stderr.write("Error: a prompt is required (use -p or --replay-fixture)\n");
          process.exit(1);
        }
        const streamProvider = replayFixture ? fixtureStreamProvider(replayFixture) : undefined;

        // Capture a content-based checkpoint around this turn so a completed
        // turn can later be undone (and redone) without a Git reset. The
        // collector records each mutated file's pre-image before its tool runs;
        // here we only need the raw transcript length before the turn's messages
        // are appended. It is read from the store, not existingMessages, because
        // a compaction sidecar can make the resume view shorter than the raw log.
        const messageCountBefore = store.load(sessionId).length;
        const recordTurnCheckpoint = (collector: TurnImageCollector) => {
          const turnMessages = store.load(sessionId).slice(messageCountBefore);
          const log = loadTurnLog(store, sessionId);
          const checkpoint = buildTurnCheckpoint(collector, {
            workspace,
            sessionId,
            turnIndex: log.checkpoints.length,
            messageCountBefore,
            messages: turnMessages,
            head: currentRepoHead(workspace.root) || null,
          });
          if (checkpoint) appendCheckpoint(store, sessionId, checkpoint);
        };

        // Load image attachments (if any) up front so a missing/oversized/
        // unsupported file fails with a clear message and a non-zero exit before
        // any provider call. The data URL stays in memory; only the non-secret
        // reference is persisted and reported in the summary.
        let images: LoadedImage[] = [];
        if (opts.image && opts.image.length > 0) {
          try {
            images = loadImageAttachments(opts.image, workspace);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Error: ${msg}\n`);
            process.exit(1);
          }
        }
        const attachmentRefs = images.map(imageRef);

        // The run summary (opt-in) points at the session log as its evidence,
        // with the host home directory collapsed to ~ so the path stays private.
        const evidencePath = () => redactHomePath(store.filePath(sessionId));

        if (format === "json") {
          // Headless protocol: a versioned NDJSON event stream on stdout. The
          // terminal `complete` record's exitCode matches the process exit code.
          const writer = new HeadlessWriter(process.stdout);
          writer.emit(startEvent({ sessionId, model: config.model, prompt: runPrompt }));
          // Publish the writer so the fatal boundary (#246) can emit exactly one
          // terminal record if the run fails with an uncaught asynchronous error.
          activeHeadlessWriter = writer;
          maybeInjectFault();
          const sink = createHeadlessSink(writer, {
            includePartialMessages: Boolean(opts.includePartialMessages),
          });
          const startedAt = Date.now();
          const turnImages = new TurnImageCollector();
          const bottleneck = opts.bottleneck ? createBottleneckCollector() : null;
          const failureTaxonomy = opts.failureTaxonomy ? createFailureTaxonomyCollector() : null;
          // Cooperative SIGINT cancel (#552): the first Ctrl+C stops the run at
          // the next cancel boundary with a truthful terminal `complete` record;
          // a second exits immediately. Replaces the default hard-exit handler
          // for the run's lifetime only.
          process.removeListener("SIGINT", defaultSigintHandler);
          const sigint = installSigintCancel({
            onInterrupt: () =>
              process.stderr.write("\nInterrupted: cancelling at the next safe boundary...\n"),
          });
          let result: AgentResult;
          try {
            result = await runAgent(runPrompt, existingMessages, {
              config,
              workspace,
              approvalMode,
              sessionId,
              onMessage,
              sink,
              budgetUsd,
              maxTurns,
              maxWallTimeMs,
              maxToolCalls,
              compactThreshold,
              // One-shot fallback degrade (Issue #590); never for fixture
              // replays — a scripted provider cannot degrade truthfully.
              fallbackModel: replayFixture ? null : (config.fallbackModel ?? null),
              mutatingAllowed,
              images,
              turnImages,
              preToolUseHooks,
              bottleneck: bottleneck?.collector,
              failureTaxonomy: failureTaxonomy?.collector,
              streamProvider,
              readOnly: Boolean(opts.readOnly),
              cancelRequested: sigint.cancelRequested,
              onShellFailure: (detail) =>
                appendFailureReceipt(store, sessionId, detail, {
                  head: currentRepoHead(workspace.root) || null,
                }),
            });
          } catch (err: unknown) {
            sigint.dispose();
            process.on("SIGINT", defaultSigintHandler);
            const msg = err instanceof Error ? err.message : String(err);
            writer.emit({ type: "error", stage: "internal", message: redactSecrets(msg).text });
            if (bottleneck) {
              writer.emit({ type: "bottleneck", bottleneck: bottleneck.build(Date.now() - startedAt) });
            }
            if (failureTaxonomy) {
              writer.emit({
                type: "failure_taxonomy",
                failureTaxonomy: failureTaxonomy.build(Date.now() - startedAt, "error"),
              });
            }
            if (opts.summary || opts.summaryOut !== undefined) {
              const summary = buildRunSummary({
                ok: false,
                exitCode: 1,
                reason: "error",
                elapsedMs: Date.now() - startedAt,
                rounds: 0,
                toolCalls: {},
                toolFailures: {},
                tokens: null,
                sessionId,
                sessionPath: evidencePath(),
                attachments: attachmentRefs,
              });
              persistSummary(summary);
              if (opts.summary) {
                writer.emit({ type: "summary", summary });
              }
            }
            writer.emit({ type: "complete", ok: false, exitCode: 1, rounds: 0, reason: "error" });
            process.exit(1);
          }
          sigint.dispose();
          process.on("SIGINT", defaultSigintHandler);
          sealSession();
          recordTurnCheckpoint(turnImages);
          // A cooperative cancel is a user stop, not a run failure (#552): the
          // terminal `complete` record carries reason "cancelled" and the
          // process exits with the conventional SIGINT code.
          const exitCode = result.ok ? 0 : result.reason === "cancelled" ? SIGINT_EXIT_CODE : 1;
          if (opts.summary || opts.summaryOut !== undefined) {
            const summary = buildRunSummary({
              ok: result.ok,
              exitCode,
              reason: result.reason,
              elapsedMs: Date.now() - startedAt,
              rounds: result.rounds,
              retries: result.retries,
              toolCalls: result.stats.toolCalls,
              toolFailures: result.stats.toolFailures,
              tokens: result.tokens,
              estimatedCostUsd: result.estimatedCostUsd,
              fellBack: result.fellBack,
              fallbackModel: result.fallbackModel,
              sessionId,
              sessionPath: evidencePath(),
              attachments: attachmentRefs,
            });
            persistSummary(summary);
            if (opts.summary) {
              writer.emit({ type: "summary", summary });
            }
          }
          if (bottleneck) {
            writer.emit({ type: "bottleneck", bottleneck: bottleneck.build(Date.now() - startedAt) });
          }
          if (failureTaxonomy) {
            writer.emit({
              type: "failure_taxonomy",
              failureTaxonomy: failureTaxonomy.build(Date.now() - startedAt, result.reason),
            });
          }
          writer.emit({
            type: "complete",
            ok: result.ok,
            exitCode,
            rounds: result.rounds,
            reason: result.reason,
          });
          process.exit(exitCode);
        }

        const startedAt = Date.now();
        const turnImages = new TurnImageCollector();
        const bottleneck = opts.bottleneck ? createBottleneckCollector() : null;
        const failureTaxonomy = opts.failureTaxonomy ? createFailureTaxonomyCollector() : null;
        // Cooperative SIGINT cancel (#552), same contract as the JSON path: one
        // bounded interruption notice on stderr, a stop at the next cancel
        // boundary, and the conventional SIGINT exit code.
        process.removeListener("SIGINT", defaultSigintHandler);
        const sigint = installSigintCancel({
          onInterrupt: () =>
            process.stderr.write("\nInterrupted: cancelling at the next safe boundary...\n"),
        });
        const result = await runAgent(runPrompt, existingMessages, {
          config,
          workspace,
          approvalMode,
          sessionId,
          onMessage,
          // Opt-in per-message usage line (#241); off by default so the default
          // conversation output is unchanged. The headless JSON stream always
          // carries the same per-message timing in its `usage` event.
          sink: createConsoleSink({ messageUsage: process.env.OMC_MESSAGE_USAGE === "1" }),
          budgetUsd,
          maxTurns,
          maxWallTimeMs,
          maxToolCalls,
          compactThreshold,
          // One-shot fallback degrade (Issue #590); never for fixture replays.
          fallbackModel: replayFixture ? null : (config.fallbackModel ?? null),
          mutatingAllowed,
          images,
          turnImages,
          preToolUseHooks,
          bottleneck: bottleneck?.collector,
          failureTaxonomy: failureTaxonomy?.collector,
          streamProvider,
          readOnly: Boolean(opts.readOnly),
          cancelRequested: sigint.cancelRequested,
          onShellFailure: (detail) =>
            appendFailureReceipt(store, sessionId, detail, {
              head: currentRepoHead(workspace.root) || null,
            }),
        });
        sigint.dispose();
        process.on("SIGINT", defaultSigintHandler);
        sealSession();
        recordTurnCheckpoint(turnImages);
        // Exit with the run outcome so unattended/CI callers can detect failure;
        // the plain-text path previously fell through and always exited 0. A
        // cooperative cancel exits with the conventional SIGINT code (#552).
        const exitCode = result.ok ? 0 : result.reason === "cancelled" ? SIGINT_EXIT_CODE : 1;
        if (opts.summary || opts.summaryOut !== undefined) {
          const summary = buildRunSummary({
            ok: result.ok,
            exitCode,
            reason: result.reason,
            elapsedMs: Date.now() - startedAt,
            rounds: result.rounds,
            retries: result.retries,
            toolCalls: result.stats.toolCalls,
            toolFailures: result.stats.toolFailures,
            tokens: result.tokens,
            estimatedCostUsd: result.estimatedCostUsd,
            fellBack: result.fellBack,
            fallbackModel: result.fallbackModel,
            sessionId,
            sessionPath: evidencePath(),
            attachments: attachmentRefs,
          });
          persistSummary(summary);
          if (opts.summary) {
            process.stdout.write("\n" + formatRunSummary(summary) + "\n");
          }
        }
        if (bottleneck) {
          process.stdout.write("\n" + formatBottleneckReport(bottleneck.build(Date.now() - startedAt)) + "\n");
        }
        if (failureTaxonomy) {
          process.stdout.write(
            "\n" + formatFailureTaxonomyReport(failureTaxonomy.build(Date.now() - startedAt, result.reason)) + "\n",
          );
        }
        process.exit(exitCode);
      } else {
        // Interactive REPL
        if (!process.stdin.isTTY) {
          process.stderr.write("Error: interactive mode requires a TTY. Use -p for non-interactive.\n");
          process.exit(1);
        }

        const useColor = colorEnabled({ noColor: opts.color === false, env: process.env });
        // Match the palette to the terminal's advertised color depth so a
        // reduced-color terminal renders portable 16-color SGR instead of indexed
        // codes it cannot map (Issue #164, criterion 3).
        const colorDepth = detectColorDepth({
          noColor: opts.color === false,
          env: process.env,
          isTTY: Boolean(process.stdout.isTTY),
        });

        const toolNames = createTools().map((tool) => tool.name);
        const runtimeSlashContext = {
          model: config.model,
          workspace: workspace.root,
          approvalMode,
          sessionId,
          settingsPath,
          tools: toolNames,
        };

        // Durable workspace-scoped prompt history (Issue #711): submitted
        // prompts stay recallable across sessions of this workspace. Keyed by
        // the canonical workspace identity; interactive-only by construction —
        // headless `-p` runs never reach this branch, so they neither read nor
        // write the store.
        const promptHistories = openPromptHistoryStore({ workspacePath: workspace.root });

        // Pending approval-mode escalation for the readline surface (Issue
        // #715); the full-screen shell keeps its own pending state. Never
        // persisted — an invocation restart drops it by design.
        let pendingApprovalEscalation: ApprovalMode | null = null;

        // Interactive compaction of the current session (Issue #719): the
        // exact headless mechanics (--compact) over the live session id,
        // which the closures read at call time so /new restarts target the
        // fresh session. The transcript is never touched; the sidecar applies
        // from the next turn and the next --resume.
        const compactIo = {
          load: (sid: string) => store.load(sid),
          save: (sid: string, summary: CompactionSummary) =>
            saveCompaction(store.compactPath(sid), summary),
        };
        const runCompactForCurrentSession = (args: string): string => {
          const rejection = rejectCompactArgs(args);
          if (rejection !== null) return rejection;
          return compactCurrentSession(sessionId, compactIo);
        };

        // Read-only context budget view (Issue #721): the shell facts come
        // from the surface (full-screen shell state or the readline turn
        // tracker below); the store facts are read here at call time, so the
        // view always reflects the current session id and sidecar. Reads
        // only — never writes.
        const renderContextView = (facts: ShellContextFacts): string => {
          const sidecar = loadCompaction(store.compactPath(sessionId));
          return formatContextView({
            lastCallPromptTokens: facts.lastCallPromptTokens,
            threshold: compactThreshold ?? null,
            lastTurnUsage: facts.lastTurnUsage,
            sidecar: sidecar
              ? { messageCount: sidecar.messageCount, sourceDigest: sidecar.sourceDigest }
              : null,
            messageCount: store.load(sessionId).length,
          });
        };
        // The readline surface has no shell state: track the same facts from
        // each dispatched turn's result (updated in dispatchInput).
        let readlineContextFacts: ShellContextFacts = {
          lastCallPromptTokens: null,
          lastTurnUsage: null,
        };

        // Build palette commands with live context
        const paletteCommands: PaletteCommand[] = [
          {
            // /new (Issue #713), plain-readline surface: the full-screen shell
            // intercepts /new and returns the structured restart result; on the
            // readline fallback this action performs the same contract in place —
            // seal the current session and switch the REPL to a fresh session id
            // in the same workspace and posture. Run-scoped bounds are per-turn
            // gates on the shared invocation options, so they carry over
            // unchanged; workspace-keyed durable state (#556/#711) is untouched.
            name: "/new",
            description: "Start a new conversation session",
            action: () => {
              sealSession();
              sessionId = store.newId();
              store.writeMeta(sessionId, {
                model: config.model,
                ...(resolved.profile ? { profile: resolved.profile } : {}),
                workspace: workspace.root,
                createdAt: Date.now(),
              });
              runtimeSlashContext.sessionId = sessionId;
              return `New session started: ${sessionId}`;
            },
          },
          {
            // /approval-mode (Issue #715), plain-readline surface: the
            // full-screen shell intercepts the command in runPaletteCommand;
            // here the same pure decision contract applies to the shared
            // invocation-scoped `approvalMode` binding. De-escalation is
            // immediate; escalation requires the explicit `<mode> confirm`
            // form matching a pending request. Never persisted.
            name: "/approval-mode",
            description: "View or change the approval mode (default, auto-edit, yolo)",
            action: (args = "") => {
              const decision = approvalModeCommandDecision(
                approvalMode,
                args,
                pendingApprovalEscalation,
              );
              if (decisionAppliesMode(decision)) {
                approvalMode = decision.mode;
                runtimeSlashContext.approvalMode = approvalMode;
              }
              pendingApprovalEscalation = nextPendingEscalation(decision);
              return formatApprovalModeNotice(decision);
            },
          },
          {
            // /compact (Issue #719): same report on both surfaces — the
            // readline action and the full-screen shell's onCompact option
            // share runCompactForCurrentSession.
            name: "/compact",
            description: "Compact the current session (transcript preserved; applies from next turn/resume)",
            action: (args = "") => runCompactForCurrentSession(args),
          },
          {
            // /context (Issue #721): read-only budget view, streaming-safe.
            // The full-screen shell intercepts it with its own live facts via
            // the onContext option; this action serves the readline surface.
            name: "/context",
            description: "Show the context-compaction budget (read-only)",
            action: () => renderContextView(readlineContextFacts),
          },
          ...defaultCommands().filter(
            (command) =>
              !RUNTIME_SLASH_COMMANDS.some(
                (name) => name === command.name,
              ) && command.name !== "/new" && command.name !== "/approval-mode",
          ),
          ...RUNTIME_SLASH_COMMAND_DESCRIPTORS.map(({ name, description }) => ({
            name,
            description,
            action: () => {
              process.stderr.write(
                `${formatRuntimeSlashCommand(name, runtimeSlashContext)}\n`,
              );
            },
          })),
          {
            name: "/goal",
            description: "Set, inspect, pause, resume, achieve, or clear the session goal",
            action: (args = "") => runGoalCommand(store, sessionId, args),
          },
          {
            // Durable prompt history (Issue #711): the explicit clear for the
            // workspace's recall store. Clears only the durable record — the
            // loaded session's own transcript recall is untouched, and future
            // submissions start recording again into a fresh store.
            name: "/clear-history",
            description: "Clear this workspace's durable prompt history",
            action: () => {
              try {
                promptHistories.clear();
                return "Prompt history cleared for this workspace.";
              } catch {
                return "Prompt history could not be cleared (store unavailable).";
              }
            },
          },
          {
            // Side question (Issue #200) for the plain readline REPL. The
            // full-screen shell opens a dedicated overlay for typed `/ask`; this
            // action covers the non-full-screen fallback and a palette selection.
            // It reads the session's context only — no tools, no mutation, and
            // nothing appended to the transcript, goal, or workflow.
            name: "/ask",
            description: "Ask a side question without disturbing the main task",
            action: async (args = "") => {
              const question = args.trim();
              if (!question) {
                return "usage: /ask <question> — ask a side question without disturbing the main task";
              }
              const context = buildSideContext(loadSessionMessages(store, sessionId));
              process.stderr.write(`${formatSideContextSummary(context)}\n`);
              const result = await runSideQuestion({
                config,
                context,
                question,
                onDelta: (delta) => process.stderr.write(delta),
              });
              process.stderr.write("\n");
              return result.ok ? undefined : `side question failed: ${result.reason}`;
            },
          },
          {
            // Session stats (Issue #201) for the plain readline REPL. The
            // full-screen shell opens a dedicated overlay for `/stats`; this
            // action covers the non-full-screen fallback and a palette
            // selection. It reads the session's canonical log only — no tools,
            // no mutation, nothing appended to the transcript.
            name: "/stats",
            description: "Show session activity and efficiency (read-only)",
            action: () => {
              const stats = buildSessionStats({
                sessionId,
                messages: loadSessionMessages(store, sessionId),
                model: config.model,
                workspace: redactHomePath(workspace.root),
              });
              return formatSessionStats(stats).join("\n");
            },
          },
          {
            // Language-server discovery + readiness (Issue #202) for the plain
            // readline REPL. The full-screen shell opens a dedicated overlay for
            // `/lsp`; this action covers the non-full-screen fallback and a
            // palette selection. It is read-only: it discovers configured servers
            // for the trusted workspace without installing anything and performs
            // no edits.
            name: "/lsp",
            description: "Show language-server discovery and readiness (read-only)",
            action: () => formatLspView(buildLspView(workspace.root)).join("\n"),
          },
          {
            // Background-task center (Issue #203) for the plain readline REPL. The
            // full-screen shell opens a dedicated overlay for `/tasks`; this action
            // covers the non-full-screen fallback and a palette selection. It is
            // read-only: it reads the session's durable task receipts, reconciled
            // against real process state, and performs no edits.
            name: "/tasks",
            description: "Show background tasks and durable receipts (read-only)",
            action: () => formatTaskView(buildTaskView(store, sessionId, workspace.root)).join("\n"),
          },
          {
            // Mission lifecycle view (Issue #314) for the plain readline REPL. The
            // full-screen shell opens a dedicated overlay for `/mission`; this
            // action covers the non-full-screen fallback and a palette selection.
            // It is read-only: it renders the durable lifecycle projection (#313).
            // Until a live mission source exists (#319) it renders an empty model
            // ("no mission activity"); it never simulates mission state.
            name: "/mission",
            description: "Show the mission lifecycle timeline and graph (read-only)",
            action: () => formatLifecycleView(emptyLifecycleModel()).join("\n"),
          },
          {
            // Activity view (Issue #307) for the plain readline REPL. The
            // full-screen shell opens a dedicated overlay for `/activity`; this
            // action covers the non-full-screen fallback and a palette selection.
            // It is read-only: it renders the #306 presented event stream as
            // progressive-disclosure cards. Until a live activity source exists it
            // renders an empty stream ("no activity"); it never simulates activity.
            name: "/activity",
            description: "Show the activity stream as progressive-disclosure cards (read-only)",
            action: () => formatActivityView([], initialActivityViewState()).join("\n"),
          },
        ];

        // Prefer the stable full-screen conversation shell (regions + fixed
        // composer) when the terminal supports it. Reduced color still uses it
        // (without ANSI); only a non-TTY, missing/dumb terminal, or a too-small
        // viewport falls back to the plain readline REPL below.
        if (
          isFullScreenCapable({
            isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
            rows: process.stdout.rows,
            cols: process.stdout.columns,
            env: process.env,
          })
        ) {
          // Restart loop for the /new contract (Issue #713): the shell resolves
          // only when the user asks for a fresh session; ordinary exits
          // terminate the process inside the shell. The Goal resume notice
          // belongs to the session the shell was launched with, never to a
          // session started via /new.
          let resumeNoticeForShell: string | undefined = resumeGoalNotice ?? undefined;
          for (;;) {
          maybeInjectFault();
          const shellExit = await runConversationShell({
            config,
            workspace,
            approvalMode,
            sessionId,
            onMessage,
            loadHistory: () => loadSessionMessages(store, sessionId),
            budgetUsd,
            maxTurns,
            maxWallTimeMs,
            maxToolCalls,
            compactThreshold,
            mutatingAllowed,
            color: useColor,
            colorDepth,
            paletteCommands,
            loadGoal: () => store.readGoal(sessionId),
            settleGoal: (revision, succeeded) =>
              settleGoalExecution(store, sessionId, revision, succeeded),
            loadLsp: () => buildLspView(workspace.root),
            loadTasks: () => buildTaskView(store, sessionId, workspace.root),
            // Mission lifecycle source (Issue #314). Until a live mission source
            // exists (#319) this supplies an empty model, so the /mission overlay
            // shows "no mission activity" rather than simulated state.
            loadLifecycle: () => emptyLifecycleModel(),
            // Activity source (Issue #307). Until a live activity source exists
            // this supplies an empty stream, so the /activity overlay shows "no
            // activity" rather than simulated activity.
            loadActivity: () => [],
            settingsPath,
            tools: toolNames,
            // Durable workspace-scoped composer draft (Issue #556): unsent text
            // survives a restart in the same workspace and never leaks into
            // another. Keyed by the canonical workspace identity.
            composerDrafts: openComposerDraftStore({ workspacePath: workspace.root }),
            // Durable workspace-scoped prompt history (Issue #711): a fresh
            // session recalls prompts submitted in prior sessions of this
            // workspace, and every submitted prompt is recorded for future
            // recall. Keyed by the same canonical workspace identity.
            promptHistories,
            // Interactive compaction of the current session (Issue #719);
            // the shell renders the returned report. The session id is read
            // at call time, so a /new restart targets the fresh session.
            onCompact: () => runCompactForCurrentSession(""),
            // Read-only context budget view (Issue #721): the shell passes
            // its live facts; the store facts are added at call time.
            onContext: (facts) => renderContextView(facts),
            // Offline posture banner before the first request (Issue #576).
            offline: offlineRequested,
            // Immediate Goal status summary on resume (Issue #584).
            resumeNotice: resumeNoticeForShell,
            // Shell failure receipts (Issue #574): persistence is session-bound;
            // the shell forwards failed shell executions here.
            onShellFailure: (detail) =>
              appendFailureReceipt(store, sessionId, detail, {
                head: currentRepoHead(workspace.root) || null,
              }),
          });
            if (shellExit.kind !== "new-session") break;
            // Seal the finished session and start a fresh one in the same
            // workspace and posture (Issue #713). Workspace-keyed durable state
            // (composer draft #556, prompt history #711) carries over by
            // construction; run-scoped bounds are per-turn gates on the shared
            // options above, so they are never reset by a restart. The
            // effective approval mode is invocation posture (Issue #715): it
            // survives the restart and gates the fresh session's turns.
            approvalMode = shellExit.approvalMode;
            runtimeSlashContext.approvalMode = approvalMode;
            sealSession();
            // Lock handover (Issue #741): the sealed session's lock is
            // released; the fresh session locks before any write.
            sessionLock?.release();
            sessionId = store.newId();
            store.writeMeta(sessionId, {
              model: config.model,
              ...(resolved.profile ? { profile: resolved.profile } : {}),
              workspace: workspace.root,
              createdAt: Date.now(),
            });
            sessionLock = store.openLock(sessionId);
            const restartLockResult = sessionLock.acquire();
            if (!restartLockResult.acquired) failLockClosed(sessionLock, restartLockResult);
            resumeNoticeForShell = undefined;
          }
          return;
        }

        const { bold: BOLD, dim: DIM, reset: RESET } = createColorPalette(useColor);

        // Multi-line paste guard (Issue #727): registered BEFORE the readline
        // interface so it observes each raw chunk ahead of readline's line
        // splitting. A chunk that is a multi-line paste is flagged for the
        // dispatch path, which flattens it into the composer instead of
        // auto-submitting its first line. Observes only — never consumes
        // data. Gated on a pending prompt question so a paste arriving
        // mid-turn (typeahead) is left to the pre-#727 behavior rather than
        // arming a stale interception.
        let pasteChunk: Buffer | null = null;
        process.stdin.on("data", (buf: Buffer) => {
          if (promptActive && isMultilinePasteChunk(buf)) {
            pasteChunk = Buffer.from(buf);
          }
        });

        // Universal control keystrokes for the readline surface. Ctrl+L clears
        // the screen and redraws the prompt line (Issue #745); Ctrl+W kills
        // the word before the cursor (Issue #747); Ctrl+U kills the line
        // before the cursor (Issue #749); Ctrl+Z suspends the process like
        // every terminal app (Issue #751); Ctrl+A/Ctrl+E are ignored cleanly
        // (Issue #753) — all standard in bash/zsh/the node REPL, except the
        // last two: under TERM=dumb Node 24's readline is append-only with
        // no cursor addressing, so for 0x01/0x05 the repair of readline's
        // inserted byte IS the effect (the keystrokes stop corrupting the
        // prompt). Every remaining unhandled lone control byte gets that
        // same repair-only treatment (Issue #755 sweep, including Tab —
        // this surface wires no completer, so a tab is just pollution) —
        // the bytes other machinery owns (interface SIGINT, Enter, the
        // palette's Ctrl+K, escape prefixes) keep their existing behavior
        // exactly.
        // Registered BEFORE the readline interface (like the paste tap) so
        // it snapshots the line before readline consumes the byte: Node's
        // readline inserts the raw control byte into the line buffer, so
        // the follow-up repairs that insertion (verified shape only — fail
        // closed otherwise) and then applies the keystroke's real effect.
        // Effects land only at the idle prompt; mid-turn or with the
        // palette open the buffer is still repaired but the streaming
        // output / picker stays untouched. Non-TTY stdin is never touched:
        // there these bytes are literal piped data, not keystrokes.
        process.stdin.on("data", (buf: Buffer) => {
          if (buf.length !== 1 || !process.stdin.isTTY) return;
          const isCtrlL = buf[0] === 0x0c;
          const isCtrlW = buf[0] === 0x17;
          const isCtrlU = buf[0] === 0x15;
          const isCtrlZ = buf[0] === 0x1a;
          const isCtrlA = buf[0] === 0x01;
          const isCtrlE = buf[0] === 0x05;
          const swept =
            !isCtrlL &&
            !isCtrlW &&
            !isCtrlU &&
            !isCtrlZ &&
            !isCtrlA &&
            !isCtrlE &&
            isSweptControlByte(buf[0]);
          if (!isCtrlL && !isCtrlW && !isCtrlU && !isCtrlZ && !isCtrlA && !isCtrlE && !swept) {
            return;
          }
          // Every handled byte is its own inserted character.
          const insertedChar = String.fromCharCode(buf[0]);
          const snapshot = {
            line: (rl as unknown as { line: string }).line,
            cursor: (rl as unknown as { cursor: number }).cursor,
          };
          setImmediate(() => {
            const rlInternals = rl as unknown as {
              line: string;
              cursor: number;
              _refreshLine(): void;
            };
            const repaired = repairControlCharInsertion(
              snapshot,
              { line: rlInternals.line, cursor: rlInternals.cursor },
              insertedChar,
            );
            if (repaired === null) return;
            const idle =
              !turnInFlight && !paletteOpen && !paletteQuestionActive && promptActive;
            if (idle && isCtrlZ) {
              // Suspend edits nothing — the buffer keeps the repaired state
              // and the suspend recipe redraws it after the resume.
              rlInternals.line = repaired.line;
              rlInternals.cursor = repaired.cursor;
              suspendReadlineSurface(rlInternals);
              return;
            }
            const next = idle
              ? isCtrlW
                ? wordKillBefore(repaired)
                : isCtrlU
                  ? lineKillBefore(repaired)
                  : repaired
              : repaired;
            rlInternals.line = next.line;
            rlInternals.cursor = next.cursor;
            if (!idle) return;
            if (isCtrlL) process.stderr.write(CLEAR_SCREEN_SEQUENCE);
            rlInternals._refreshLine();
          });
        });

        // Job-control suspend for the readline surface (Issue #751): the #735
        // recipe adapted to the line-oriented surface. Readline keeps the
        // input in raw mode, so the tty never generates SIGTSTP on Ctrl+Z —
        // the byte arrives as data (handled by the tap above). Pause
        // readline's input and leave raw mode so the user's shell regains a
        // cooked terminal, note the resume key, then restore the default
        // SIGTSTP disposition and raise it: the kernel stops the process and
        // execution continues right after the raise on SIGCONT (fg) —
        // re-enter raw mode, resume readline, and redraw the prompt line on
        // a fresh line below whatever the shell printed while suspended. The
        // line buffer survives untouched.
        const suspendReadlineSurface = (rlInternals: {
          line: string;
          cursor: number;
          _refreshLine(): void;
        }): void => {
          rl.pause();
          try {
            process.stdin.setRawMode(false);
          } catch {
            /* not a raw-capable stream */
          }
          process.stderr.write("[oh-my-cli suspended — resume with fg]\n");
          // Remove any JS SIGTSTP handling so the raise gets the kernel's
          // default action (stop the process); execution continues after it
          // returns.
          process.removeAllListeners("SIGTSTP");
          process.kill(process.pid, "SIGTSTP");
          // -- the process is stopped here and resumes here on SIGCONT --
          try {
            process.stdin.setRawMode(true);
          } catch {
            /* not a raw-capable stream */
          }
          rl.resume();
          // A fresh line: the user's shell printed its own prompt/output
          // below the suspended surface, so the redrawn prompt starts under
          // it rather than overprinting it.
          process.stderr.write("\n");
          rlInternals._refreshLine();
        };

        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stderr,
          // Bounded like the durable store; duplicates collapse across the
          // seeding seam (Issue #723).
          historySize: PROMPT_HISTORY_MAX_ENTRIES,
          removeHistoryDuplicates: true,
        });
        // Seed Up-recall from the durable workspace prompt history (Issue
        // #723): the store is oldest-first, readline recalls index 0 first
        // (newest-first). Any store failure degrades to the pre-#723
        // behavior — an empty in-invocation history — never a crash; a
        // corrupt store additionally produces one bounded warning (Issue
        // #739), matching the full-screen shell's honesty. `history` is a
        // documented runtime property of readline.Interface (mutable line
        // history) that this @types/node version does not declare, hence the
        // bounded cast.
        let promptHistoryWarning: string | null = null;
        try {
          const historyLoad = promptHistories.load();
          if (historyLoad.corrupt) {
            promptHistoryWarning = corruptStoreWarning("prompt history", promptHistories.filePath);
          }
          (rl as unknown as { history: string[] }).history = readlineHistorySeed(
            historyLoad.entries,
          );
        } catch {
          promptHistoryWarning = corruptStoreWarning("prompt history", promptHistories.filePath);
        }

        // Durable composer draft on the readline surface (Issue #725), parity
        // with the full-screen shell's #556 contract. Restore: a saved draft
        // is prefilled into the input line after the first prompt (the visible
        // line is the notice). Save: debounced on real editing input plus a
        // final save/clear at exit boundaries. Clear: submitting clears (the
        // #564 invariant — submitted text is never restored) and Ctrl+C on a
        // non-empty line clears the line + draft and keeps the session alive.
        // Same workspace-keyed store the full-screen shell uses (opened
        // inline there): identical file, ownership, and semantics.
        const composerDrafts = openComposerDraftStore({ workspacePath: workspace.root });
        let readlineDraftText: string | null = null;
        // A corrupt draft degrades to no restore (fail closed) plus one
        // bounded warning naming the preserved file (Issue #739).
        let draftWarning: string | null = null;
        try {
          const draft = composerDrafts.load();
          if (draft.status === "restored" && draft.text.trim() !== "") {
            readlineDraftText = draft.text;
          } else if (draft.status === "corrupt") {
            draftWarning = corruptStoreWarning("composer draft", composerDrafts.filePath);
          }
        } catch {
          draftWarning = corruptStoreWarning("composer draft", composerDrafts.filePath);
        }

        let draftAutosaveTimer: NodeJS.Timeout | null = null;
        const cancelDraftAutosave = () => {
          if (draftAutosaveTimer) {
            clearTimeout(draftAutosaveTimer);
            draftAutosaveTimer = null;
          }
        };
        const saveDraftNow = () => {
          cancelDraftAutosave();
          const line = rl.line;
          try {
            // save("") clears the durable copy — empty exits never leave a
            // stale draft behind.
            composerDrafts.save(line.trim() !== "" ? line : "");
          } catch {
            /* best-effort durability */
          }
        };
        // Debounced autosave for crash durability (mirrors the shell's
        // per-paint save). Only real editing schedules a save: escape-led
        // sequences (history navigation, Ctrl+K palette) never persist a
        // recalled line as a draft — that would re-restore submitted text,
        // violating #564.
        const scheduleDraftAutosave = (buf: Buffer) => {
          if (buf.length === 0) return;
          const first = buf[0];
          if (first === 0x1b || first < 32) return;
          cancelDraftAutosave();
          draftAutosaveTimer = setTimeout(() => {
            draftAutosaveTimer = null;
            const line = rl.line;
            if (line.trim() === "") return;
            try {
              composerDrafts.save(line);
            } catch {
              /* best-effort durability */
            }
          }, 300);
        };
        process.stdin.on("data", scheduleDraftAutosave);

        // Ctrl+C with terminal readline emits SIGINT on the interface (not the
        // process): non-empty line clears the draft and stays alive (shell
        // parity); empty line exits cleanly like the shell's empty-composer
        // Ctrl+C. Mid-turn, re-dispatch to the process handler so the
        // run-scoped installSigintCancel escalation applies (Issue #743):
        // first Ctrl+C requests the cooperative cancel, second exits.
        rl.on("SIGINT", () => {
          if (turnInFlight) {
            process.kill(process.pid, "SIGINT");
            return;
          }
          if (rl.line.trim() !== "") {
            // `line`/`cursor` are documented runtime-mutable state that this
            // @types/node version declares read-only, hence the bounded cast.
            (rl as unknown as { line: string; cursor: number }).line = "";
            (rl as unknown as { cursor: number }).cursor = 0;
            // Ctrl-U redraws the (now empty) line under the pending prompt —
            // the pending question survives the interface SIGINT, so no
            // re-prompt is needed.
            rl.write(null, { ctrl: true, name: "u" });
            cancelDraftAutosave();
            clearDurableDraft(composerDrafts);
            process.stderr.write("\nDraft cleared. Ctrl+C again to exit.\n");
            return;
          }
          rl.close();
        });

        // Exit boundaries (/exit and Ctrl-D EOF both close the interface):
        // preserve unsent text, clear stale drafts when the line is empty,
        // then exit. Read-only runs never reach this surface.
        rl.on("close", () => {
          saveDraftNow();
          process.exit(0);
        });

        // Startup identity: a responsive pixel-art banner printed once to stderr.
        // It is never redrawn, so it yields space naturally as the session scrolls.
        process.stderr.write(
          formatProductBanner({
            version: VERSION,
            model: config.model,
            workspace: workspace.root,
            authReady: config.apiKey.length > 0,
            approvalMode,
            width: process.stderr.columns ?? 80,
            noColor: opts.color === false,
            env: process.env,
            isTTY: Boolean(process.stdin.isTTY),
          }) + "\n\n",
        );

        process.stderr.write(`Session: ${sessionId}  ${DIM}Ctrl+K: command palette${RESET}\n`);
        // Resume orientation for the readline surface (Issue #737): the
        // full-screen shell seeds a transcript view on resume; the
        // line-oriented surface gets one bounded line instead. Read-only,
        // built from the already-loaded messages; fresh sessions print
        // nothing (resumeId is null).
        if (resumeId) {
          process.stderr.write(`${readlineOrientationLine(existingMessages)}\n`);
        }
        // Corrupt durable stores are visible, not silent (Issue #739): one
        // bounded warning per store, after the session/orientation lines.
        if (promptHistoryWarning) {
          process.stderr.write(`${promptHistoryWarning}\n`);
        }
        if (draftWarning) {
          process.stderr.write(`${draftWarning}\n`);
        }

        let paletteOpen = false;
        // The picker's own rl.question is pending (distinct from the typed
        // prompt's question); readline supports one pending question, so the
        // guarded prompt() must not stack a second one (Issue #717).
        let paletteQuestionActive = false;
        // The user's in-progress line, stashed while the palette is open
        // from a non-empty prompt (Issue #757); restored by
        // restorePaletteStash when the round-trip ends.
        let paletteLineStash: string | null = null;

        // Whether the current dispatch has an agent turn in flight. The
        // readline surface is single-threaded — typed input is only accepted
        // between turns — but the Ctrl+K listener is a raw stdin tap that
        // fires mid-turn too, so the palette gate needs an explicit flag.
        let turnInFlight = false;
        const BUSY_PALETTE_REASON = "a turn is in flight — available when it settles";

        // Images staged via /attach are sent with the next prompt, then cleared.
        const pendingImages: LoadedImage[] = [];

        // Idempotent prompt: a settling turn and the palette picker can both
        // reach for a fresh prompt; readline supports exactly one pending
        // question, so extra requests are dropped instead of stacked.
        let promptActive = false;
        const prompt = () => {
          if (promptActive || paletteQuestionActive) return;
          promptActive = true;
          rl.question("> ", (answer) => {
            promptActive = false;
            if (paletteOpen) {
              // The palette list is showing: this line is the user's
              // selection, not a command or prompt (Issue #717).
              paletteOpen = false;
              handlePaletteAnswer(answer);
              return;
            }
            void dispatchInput(answer);
          });
        };

        // Shared selection handling for both picker entry points (the pending
        // typed question during normal use, or the dedicated picker question
        // when Ctrl+K fires mid-turn with no typed question pending).
        //
        // Palette line stash (Issue #757): opening the palette from a
        // non-empty line clears the line so the selection answer is clean
        // input; the user's in-progress text is stashed here and restored
        // when the palette round-trip ends — cancel, invalid/busy notice, or
        // after the selected command's dispatch settles. The durable #725
        // draft mirrors the stash while it is out so a crash mid-palette
        // loses nothing.
        const restorePaletteStash = (onlyIfLineEmpty: boolean): void => {
          if (paletteLineStash === null) return;
          const rlInternals = rl as unknown as {
            line: string;
            cursor: number;
            _refreshLine(): void;
          };
          if (onlyIfLineEmpty && rlInternals.line !== "") {
            // Fresh input arrived after the dispatch — never clobber it.
            paletteLineStash = null;
            return;
          }
          rlInternals.line = paletteLineStash;
          rlInternals.cursor = paletteLineStash.length;
          paletteLineStash = null;
          rlInternals._refreshLine();
        };

        const handlePaletteAnswer = (answer: string) => {
          const selection = parsePaletteSelection(answer, paletteCommands.length);
          if (selection.kind === "cancel") {
            prompt();
            restorePaletteStash(false);
            return;
          }
          if (selection.kind === "invalid") {
            process.stderr.write(`${selection.message}\n`);
            prompt();
            restorePaletteStash(false);
            return;
          }
          const command = paletteCommands[selection.index];
          const reason = paletteBusyReason(command);
          if (reason) {
            process.stderr.write(`${command.name} unavailable — ${reason}\n`);
            prompt();
            restorePaletteStash(false);
            return;
          }
          // Dispatch exactly as if the command had been typed: same
          // resolution, same special cases, same visible output. The stashed
          // line returns once the dispatch settles and the prompt is rearmed
          // (the command was what got "submitted", never the stash — the
          // #564 invariant holds).
          void dispatchInput(command.name).then(() => restorePaletteStash(true));
        };

        const paletteBusyReason = (command: PaletteCommand): string | null =>
          turnInFlight && !isStreamingSafeSlashCommand(command.name)
            ? BUSY_PALETTE_REASON
            : null;

        // Ctrl+K opens the line-based command palette (Issue #717). The former
        // implementation overlaid the raw-mode interactive palette on the same
        // stdin readline owns: selecting exited the session, cancelling left a
        // prompt that accepted no input, and the dispatch discarded every
        // command output. The picker here stays in cooked mode end to end and
        // routes the selection through the shared typed dispatch path.
        const ctrlKHandler = (buf: Buffer) => {
          if (paletteOpen || buf[0] !== 0x0b) return;
          paletteOpen = true;
          process.stderr.write(
            `\n${BOLD}Command palette${RESET} — select by number, or press Enter to cancel:\n`,
          );
          process.stderr.write(
            `${formatPalettePickerLines(paletteCommands, { reasonFor: paletteBusyReason }).join("\n")}\n`,
          );
          if (promptActive) {
            // A typed question is already pending: its callback will route the
            // next line to handlePaletteAnswer. No second question. First,
            // though, make the palette safe for a non-empty line (Issue
            // #757): dumb-mode readline already appended a raw 0x0b, which
            // would pollute every selection answer, and the user's
            // in-progress text must not be swallowed by the picker. Strip
            // the inserted byte, stash the cleaned line (mirrored into the
            // durable draft), and clear the buffer so the answer is clean
            // input; restorePaletteStash returns the line when the palette
            // round-trip ends.
            const rlInternals = rl as unknown as { line: string; cursor: number };
            const cleaned = stripInsertedPaletteByte(rlInternals.line);
            paletteLineStash = cleaned !== "" ? cleaned : null;
            rlInternals.line = "";
            rlInternals.cursor = 0;
            if (paletteLineStash !== null) {
              try {
                composerDrafts.save(paletteLineStash);
              } catch {
                /* best-effort durability */
              }
            }
            return;
          }
          paletteQuestionActive = true;
          rl.question("Select #: ", (answer) => {
            paletteQuestionActive = false;
            paletteOpen = false;
            handlePaletteAnswer(answer);
          });
        };
        process.stdin.on("data", ctrlKHandler);

        // One dispatch path for typed lines and palette selections (Issue
        // #717): whatever the palette advertises executes with exactly the
        // semantics and visible output of typing it.
        async function dispatchInput(answer: string): Promise<void> {
            // Multi-line paste guard (Issue #727): never auto-submit. The
            // flagged chunk's first line arrived as this callback's answer and
            // the remaining lines are still being folded into the line buffer
            // by readline, so apply the flattened text after the chunk is
            // fully processed, then re-arm the prompt. Nothing reaches the
            // provider or the session store without an explicit Enter.
            if (pasteChunk !== null) {
              const flat = flattenPastedChunk(pasteChunk);
              pasteChunk = null;
              setImmediate(() => {
                const rlLine = rl as unknown as { line: string; cursor: number };
                rlLine.line = "";
                rlLine.cursor = 0;
                rl.write(null, { ctrl: true, name: "u" });
                if (flat !== "") {
                  rl.write(flat);
                  try {
                    composerDrafts.save(flat);
                  } catch {
                    /* best-effort durability */
                  }
                }
                process.stderr.write(
                  "\nMulti-line paste placed in the input line — review, then press Enter to send. " +
                    "True multi-line input: use the full-screen shell (Alt+Enter).\n",
                );
                prompt();
              });
              return;
            }
            if (!answer.trim()) {
              prompt();
              return;
            }
            let promptText = answer;
            let goalRevision: number | undefined;
            const slash = answer.trim().startsWith("/attach")
              ? { kind: "prompt" as const }
              : resolveSlashCommand(answer, paletteCommands.map((command) => command.name));
            if (slash.kind === "unknown") {
              process.stderr.write(`${slash.message}\n`);
              prompt();
              return;
            }
            if (slash.kind === "command" && slash.name === "/exit") {
              process.stdin.removeListener("data", ctrlKHandler);
              rl.close();
              process.exit(0);
            }
            if (slash.kind === "command" && slash.name === "/clear") {
              process.stderr.write("\x1b[2J\x1b[H");
              prompt();
              return;
            }
            if (slash.kind === "command" && slash.name === "/help") {
              process.stderr.write(
                `${formatSlashCommandHelp(paletteCommands.map((command) => command.name))}\n`,
              );
              prompt();
              return;
            }
            if (slash.kind === "command") {
              const output = formatRuntimeSlashCommand(
                slash.name,
                runtimeSlashContext,
              );
              if (output !== null) {
                process.stderr.write(`${output}\n`);
                prompt();
                return;
              }
              const command = paletteCommands.find((candidate) => candidate.name === slash.name);
              if (command) {
                const result = await command.action(slash.args);
                if (result) process.stderr.write(`${result}\n`);
                if (slash.name === "/goal") {
                  const request = goalExecutionRequest(slash.args, store.readGoal(sessionId));
                  if (request) {
                    promptText = request.prompt;
                    goalRevision = request.revision;
                  } else {
                    prompt();
                    return;
                  }
                } else {
                  prompt();
                  return;
                }
              }
            }
            if (answer.trim().startsWith("/attach")) {
              const paths = answer.trim().slice("/attach".length).split(/\s+/).filter(Boolean);
              if (paths.length === 0) {
                process.stderr.write("Usage: /attach <image-path> [more-paths...]\n");
              } else {
                try {
                  const loaded = loadImageAttachments(paths, workspace);
                  pendingImages.push(...loaded);
                  process.stderr.write(
                    `Attached ${loaded.length} image(s): ` +
                      `${loaded.map((i) => `${i.name} (${i.mediaType})`).join(", ")}\n`,
                  );
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  process.stderr.write(`Error: ${msg}\n`);
                }
              }
              prompt();
              return;
            }
            try {
              // Submitting clears the durable draft (Issue #725, carrying the
              // #564 invariant): submitted text must never be restored as a
              // draft, and any pending autosave is cancelled before it can
              // persist the submitted line.
              cancelDraftAutosave();
              clearDurableDraft(composerDrafts);
              // Durable workspace prompt history (Issue #723): readline
              // submissions are recorded under the full-screen shell's exact
              // rules — non-empty, non-slash-prefixed, best-effort, never
              // blocking or failing the submit.
              if (!promptText.startsWith("/")) {
                try {
                  promptHistories.append(promptText);
                } catch {
                  /* best-effort durability; recall degrades gracefully */
                }
              }
              turnInFlight = true;
              // Full history: the store ends with the previous turn's assistant
              // message and runAgent appends the current user message itself.
              // Slicing the last message away dropped the previous assistant
              // turn from the context on every turn (Issue #719) — the
              // headless paths already pass the full transcript.
              existingMessages = loadSessionMessages(store, sessionId);
              const images = pendingImages.splice(0);
              // Cooperative SIGINT cancel on the readline surface (Issue
              // #743), same contract as the headless plain path (#552): one
              // bounded interruption notice, a stop at the next cancel
              // boundary, and a settled "cancelled" turn (#550) — the
              // session survives instead of the process dying. The handler
              // swap is scoped to this turn (dispose + re-register in
              // finally), so idle Ctrl+C keeps the default exit behavior.
              process.removeListener("SIGINT", defaultSigintHandler);
              const sigint = installSigintCancel({
                onInterrupt: () =>
                  process.stderr.write("\nInterrupted: cancelling at the next safe boundary...\n"),
              });
              let result: AgentResult;
              try {
                result = await runAgent(promptText, existingMessages, {
                  config,
                  workspace,
                  approvalMode,
                  sessionId,
                  onMessage,
                  budgetUsd,
                  maxTurns,
                  maxWallTimeMs,
                  maxToolCalls,
                  compactThreshold,
                  // One-shot fallback degrade (Issue #590), carried on config.
                  fallbackModel: config.fallbackModel ?? null,
                  mutatingAllowed,
                  images,
                  preToolUseHooks,
                  cancelRequested: sigint.cancelRequested,
                  onShellFailure: (detail) =>
                    appendFailureReceipt(store, sessionId, detail, {
                      head: currentRepoHead(workspace.root) || null,
                    }),
                });
              } finally {
                sigint.dispose();
                process.on("SIGINT", defaultSigintHandler);
              }
              if (result.reason === "cancelled") {
                process.stderr.write("Turn cancelled.\n");
              }
              // /context facts for the readline surface (Issue #721): the
              // same live facts the full-screen shell tracks.
              readlineContextFacts = {
                lastCallPromptTokens: result.lastCallPromptTokens,
                lastTurnUsage: result.tokens ? { ...result.tokens } : null,
              };
              if (goalRevision !== undefined) {
                const output = settleGoalExecution(
                  store,
                  sessionId,
                  goalRevision,
                  result.ok,
                );
                if (output) process.stderr.write(`${output}\n`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`Error: ${msg}\n`);
            } finally {
              turnInFlight = false;
            }
            prompt();
        }

        prompt();
        // Prefill the restored draft into the input line (Issue #725): the
        // question is set synchronously by prompt(), so the write lands on
        // the live line. The draft stays stored until submit/clear.
        if (readlineDraftText !== null) {
          rl.write(readlineDraftText);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  });

program.parse();
