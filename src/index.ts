#!/usr/bin/env node

import { Command } from "commander";
import { resolveSettingsPath, describeResolvedConfig } from "./settings.js";
import {
  RUNTIME_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMAND_DESCRIPTORS,
  formatRuntimeSlashCommand,
  formatSlashCommandHelp,
  resolveSlashCommand,
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
import { runPalette, defaultCommands } from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { runPreflight, formatPreflight, validateFallbackModel } from "./preflight.js";
import { collectSandboxDiagnostic, formatDiagnostic } from "./sandbox-diag.js";
import { collectHealthInventory, formatHealthInventory } from "./health-inventory.js";
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
import { pinSession, unpinSession } from "./session-pin.js";
import { buildSessionInspectRecord, formatSessionInspect } from "./session-inspect.js";
import {
  appendSessionNote,
  buildSessionNotesRecord,
  formatSessionNotes,
  SESSION_NOTES_MAX,
} from "./session-notes.js";
import { buildSessionsOverviewRecord, formatSessionsOverview } from "./sessions-overview.js";
import { buildSessionJournal, formatSessionJournal } from "./session-journal.js";
import { searchSessionNotes, formatSessionNotesSearch } from "./session-notes-search.js";
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
import { openComposerDraftStore } from "./composer-draft.js";
import { buildAttention, attentionRecord, formatAttention } from "./attention-summary.js";
import type { AttentionItem } from "./attention-summary.js";
import { normalizeSessionName } from "./session-name.js";
import {
  compactMessages,
  saveCompaction,
  formatCompaction,
  loadSessionMessages,
} from "./compaction.js";
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
  .option("-p, --prompt <prompt>", "Run a single non-interactive request")
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
    "Output format for -p mode: text (default) or json (versioned NDJSON event stream)",
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
          process.stdout.write(formatSessionsOverview(record).join("\n") + "\n");
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
      // appear. Exits 0 on a successful read, 2 on a bad format.
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
          process.stdout.write(formatAttention(items, String(opts.workspace)) + "\n");
        }
        process.exit(0);
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
          process.stdout.write(formatSessionStats(stats).join("\n") + "\n");
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
          process.stdout.write(formatTurnHistory(record).join("\n") + "\n");
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
          process.stdout.write(formatSessionInspect(record).join("\n") + "\n");
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
          process.stdout.write(formatSessionNotes(record).join("\n") + "\n");
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
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        const store = new SessionStore();
        const resolved = resolveArchiveTarget(String(opts.sessionJournal), store);
        if (!resolved.ok) {
          process.stderr.write(`Cannot read journal: ${resolved.reason}\n`);
          process.exit(2);
        }
        const built = buildSessionJournal(store, resolved.sessionId);
        if ("error" in built) {
          process.stderr.write(`Cannot read journal: ${built.error}\n`);
          process.exit(2);
        }
        if (format === "json") {
          process.stdout.write(JSON.stringify(built.journal) + "\n");
        } else {
          process.stdout.write(formatSessionJournal(built.journal).join("\n") + "\n");
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
        const record = searchSessionNotes(store, String(opts.searchNotes));
        if (format === "json") {
          process.stdout.write(JSON.stringify(record) + "\n");
        } else {
          process.stdout.write(formatSessionNotesSearch(record).join("\n") + "\n");
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

      if (opts.health) {
        const settingsPath = resolveSettingsPath(opts.settings);
        const inventory = await collectHealthInventory(settingsPath);
        process.stdout.write(formatHealthInventory(inventory) + "\n");
        process.exit(0);
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
      const approvalMode = opts.approvalMode as ApprovalMode;

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
      if (resumeId) {
        sessionId = resumeId;
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
      }

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
        const runPrompt = replayFixture ? replayFixture.prompt : opts.prompt;
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

        // Build palette commands with live context
        const paletteCommands: PaletteCommand[] = [
          ...defaultCommands().filter(
            (command) => !RUNTIME_SLASH_COMMANDS.some(
              (name) => name === command.name,
            ),
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
          maybeInjectFault();
          await runConversationShell({
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
            // Offline posture banner before the first request (Issue #576).
            offline: offlineRequested,
            // Immediate Goal status summary on resume (Issue #584).
            resumeNotice: resumeGoalNotice ?? undefined,
            // Shell failure receipts (Issue #574): persistence is session-bound;
            // the shell forwards failed shell executions here.
            onShellFailure: (detail) =>
              appendFailureReceipt(store, sessionId, detail, {
                head: currentRepoHead(workspace.root) || null,
              }),
          });
          return;
        }

        const { bold: BOLD, dim: DIM, reset: RESET } = createColorPalette(useColor);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

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

        let paletteOpen = false;

        // Listen for Ctrl+K (0x0b) on raw stdin to open the palette
        const ctrlKHandler = (buf: Buffer) => {
          if (!paletteOpen && buf[0] === 0x0b) {
            paletteOpen = true;
            rl.pause();
            process.stderr.write("\n");
            runPalette(paletteCommands, process.stdin, process.stdout, { color: useColor }).then(async (result) => {
              paletteOpen = false;
              if (result.selected && !result.cancelled) {
                process.stderr.write(`\n${BOLD}${result.selected.name}${RESET}: ${result.selected.description}\n`);
                try {
                  await result.selected.action();
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  process.stderr.write(`Error: ${msg}\n`);
                }
              }
              rl.resume();
              prompt();
            });
          }
        };
        process.stdin.on("data", ctrlKHandler);

        // Images staged via /attach are sent with the next prompt, then cleared.
        const pendingImages: LoadedImage[] = [];

        const prompt = () => {
          rl.question("> ", async (answer) => {
            if (paletteOpen) return;
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
              existingMessages = loadSessionMessages(store, sessionId);
              const images = pendingImages.splice(0);
              const result = await runAgent(promptText, existingMessages.slice(0, -1), {
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
                onShellFailure: (detail) =>
                  appendFailureReceipt(store, sessionId, detail, {
                    head: currentRepoHead(workspace.root) || null,
                  }),
              });
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
            }
            prompt();
          });
        };

        prompt();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  });

program.parse();
