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
import { runWorkflow, formatWorkflowStepLine } from "./workflow-runner.js";
import {
  collectProfileList,
  formatProfileList,
  resolveModelProfileConfig,
} from "./model-profiles.js";
import { Workspace } from "./workspace.js";
import { SessionStore } from "./session.js";
import { runGoalCommand } from "./session-goal.js";
import { runAgent } from "./agent.js";
import type { AgentResult } from "./agent.js";
import type { ApprovalMode } from "./approval.js";
import type { SessionMessage } from "./session.js";
import { runPalette, defaultCommands } from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { runPreflight, formatPreflight } from "./preflight.js";
import { collectSandboxDiagnostic, formatDiagnostic } from "./sandbox-diag.js";
import { collectHealthInventory, formatHealthInventory } from "./health-inventory.js";
import { collectSessionSummaries, formatSessionList } from "./session-summary.js";
import { runSessionPicker, resolveResumeTarget } from "./session-picker.js";
import {
  compactMessages,
  saveCompaction,
  formatCompaction,
  loadSessionMessages,
} from "./compaction.js";
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
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
  formatWorktreeLeaseResult,
  formatWorktreeCancelResult,
  formatWorktreeGraph,
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
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { buildRunSummary, formatRunSummary } from "./run-summary.js";
import { createBottleneckCollector, formatBottleneckReport } from "./run-bottleneck.js";
import { createFailureTaxonomyCollector, formatFailureTaxonomyReport } from "./run-failure-taxonomy.js";
import { readTaskFixtureFile, fixtureStreamProvider, type TaskFixture } from "./task-fixture.js";
import { loadImageAttachments, imageRef } from "./image-input.js";
import type { LoadedImage } from "./image-input.js";
import { createTools } from "./tools.js";
import { parseBudgetUsd } from "./cost.js";
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
import path from "node:path";
import fs from "node:fs";

// Handle Ctrl-C gracefully — session is already persisted incrementally
process.on("SIGINT", () => {
  process.stderr.write("\nInterrupted. Session saved.\n");
  process.exit(130);
});

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
  .option("--resume <session-id>", "Resume a persisted session")
  .option(
    "--approval-mode <mode>",
    "Approval mode: default, auto-edit, or yolo (yolo is unsafe - allows all tools)",
    "default",
  )
  .option("--workspace <dir>", "Workspace directory", process.cwd())
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
  .option("--list-sessions", "List resumable sessions with a redacted usage summary and exit")
  .option("--session-stats <session-id>", "Show a read-only, deterministic activity/efficiency stats view for a session (add --output json for automation) and exit")
  .option("--lsp-status", "Show the read-only, workspace-bound language-server discovery and readiness view for the current workspace (add --output json for automation) and exit")
  .option("--tasks <session-id>", "Show a session's read-only background-task center with durable receipts, reconciled against real process state (add --output json for automation) and exit")
  .option("--browse-sessions", "Interactively browse, search, and resume a previous session (requires a terminal)")
  .option("--export-session <session-id>", "Export a session locally as redacted Markdown + a deterministic JSON manifest and exit")
  .option("--out <dir>", "Output directory for --export-session (default: current directory)")
  .option("--force", "Overwrite existing --export-session output files")
  .option("--compact <session-id>", "Compact a session into a bounded summary sidecar (original preserved) and exit")
  .option("--compact-threshold <tokens>", "Auto-compact the in-memory transcript when the latest prompt size reaches this (env: OMC_COMPACT_THRESHOLD)")
  .option("--undo-turn <session-id>", "Safely undo the most recent completed agent turn of a session (restores its files + transcript) and exit")
  .option("--redo-turn <session-id>", "Redo the most recent undone agent turn of a session and exit")
  .option("--dry-run", "Preview an --undo-turn/--redo-turn plan without changing the workspace or transcript")
  .option("--side-question <text>", "Ask a side question against a session's bounded, read-only context (no tools, no mutation, nothing persisted) and exit")
  .option("--session <session-id>", "Source session whose read-only context seeds --side-question")
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
  .option("--no-color", "Disable ANSI color output (also honors the NO_COLOR env var)")
  .option("--summary", "Print a privacy-safe execution summary for the run (unattended use)")
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
        const store = new SessionStore();
        const summaries = collectSessionSummaries(store);
        process.stdout.write(formatSessionList(summaries) + "\n");
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
        const id = String(opts.sessionStats);
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
        const id = String(opts.tasks);
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
        const id = String(opts.compact);
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
        const id = String(opts.exportSession);
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
        const id = String(opts.undoTurn ?? opts.redoTurn);
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
        const report = collectDoctorReport();
        process.stdout.write(formatDoctorReport(report) + "\n");
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
        try {
          report = await runWorkflow({
            name,
            settingsPath: resolveSettingsPath(opts.settings),
            workspace: opts.workspace,
            env: process.env,
            onStepEnd:
              format === "text"
                ? (step, stepsTotal) => {
                    process.stdout.write(formatWorkflowStepLine(step, stepsTotal) + "\n");
                    if (!step.ok && step.reason) {
                      process.stdout.write(`    reason: ${step.reason}\n`);
                    }
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
          if (report.stepsRun < report.stepsTotal) {
            process.stdout.write(
              `  Steps ${report.stepsRun + 1}-${report.stepsTotal}: skipped (halted)\n`,
            );
          }
          process.stdout.write(
            `Workflow "${report.workflow}": ${report.result} ` +
              `(${report.stepsRun}/${report.stepsTotal} steps, ${report.elapsedMs}ms)\n`,
          );
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

      if (opts.preflight) {
        const resolved = resolveModelProfileConfig({
          settingsPath: resolveSettingsPath(opts.settings),
          env: process.env,
          profile: opts.profile,
        });
        process.stderr.write(describeResolvedConfig(resolved) + "\n");
        const result = await runPreflight(resolved.config);
        process.stdout.write(formatPreflight(result) + "\n");
        process.exit(result.ok ? 0 : 1);
      }

      const settingsPath = resolveSettingsPath(opts.settings);
      const resolved = resolveModelProfileConfig({
        settingsPath,
        env: process.env,
        profile: opts.profile,
      });
      const config = resolved.config;
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
          const sourceId = String(opts.session);
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

      let sessionId: string;
      let existingMessages: SessionMessage[] = [];

      // A picker selection resumes the exact chosen session; --resume <id> keeps
      // working unchanged. Both share the same heal-then-load path.
      const resumeId = browseResume?.sessionId ?? opts.resume;
      if (resumeId) {
        sessionId = resumeId;
        // Heal an interrupted or corrupt checkpoint before loading. Recovery is
        // scoped to this session and never touches sibling sessions.
        const recovery = store.recover(sessionId);
        if (recovery.action === "quarantined") {
          const where = recovery.quarantinePath
            ? path.basename(recovery.quarantinePath)
            : "a sidecar file";
          process.stderr.write(
            `Warning: session ${sessionId} had a corrupt checkpoint; it was preserved as ${where} and isolated. Starting fresh.\n`,
          );
        }
        existingMessages = loadSessionMessages(store, sessionId);
        if (existingMessages.length === 0) {
          process.stderr.write(`Warning: session ${sessionId} is empty or not found\n`);
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
          const sink = createHeadlessSink(writer);
          const startedAt = Date.now();
          const turnImages = new TurnImageCollector();
          const bottleneck = opts.bottleneck ? createBottleneckCollector() : null;
          const failureTaxonomy = opts.failureTaxonomy ? createFailureTaxonomyCollector() : null;
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
              compactThreshold,
              mutatingAllowed,
              images,
              turnImages,
              preToolUseHooks,
              bottleneck: bottleneck?.collector,
              failureTaxonomy: failureTaxonomy?.collector,
              streamProvider,
              readOnly: Boolean(opts.readOnly),
            });
          } catch (err: unknown) {
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
            if (opts.summary) {
              writer.emit({
                type: "summary",
                summary: buildRunSummary({
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
                }),
              });
            }
            writer.emit({ type: "complete", ok: false, exitCode: 1, rounds: 0, reason: "error" });
            process.exit(1);
          }
          sealSession();
          recordTurnCheckpoint(turnImages);
          const exitCode = result.ok ? 0 : 1;
          if (opts.summary) {
            writer.emit({
              type: "summary",
              summary: buildRunSummary({
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
                sessionId,
                sessionPath: evidencePath(),
                attachments: attachmentRefs,
              }),
            });
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
        const result = await runAgent(runPrompt, existingMessages, {
          config,
          workspace,
          approvalMode,
          sessionId,
          onMessage,
          budgetUsd,
          compactThreshold,
          mutatingAllowed,
          images,
          turnImages,
          preToolUseHooks,
          bottleneck: bottleneck?.collector,
          failureTaxonomy: failureTaxonomy?.collector,
          streamProvider,
          readOnly: Boolean(opts.readOnly),
        });
        sealSession();
        recordTurnCheckpoint(turnImages);
        // Exit with the run outcome so unattended/CI callers can detect failure;
        // the plain-text path previously fell through and always exited 0.
        const exitCode = result.ok ? 0 : 1;
        if (opts.summary) {
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
            sessionId,
            sessionPath: evidencePath(),
            attachments: attachmentRefs,
          });
          process.stdout.write("\n" + formatRunSummary(summary) + "\n");
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
            description: "Set, inspect, pause, resume, or clear the session goal",
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
          await runConversationShell({
            config,
            workspace,
            approvalMode,
            sessionId,
            onMessage,
            loadHistory: () => loadSessionMessages(store, sessionId),
            budgetUsd,
            compactThreshold,
            mutatingAllowed,
            color: useColor,
            colorDepth,
            paletteCommands,
            loadGoal: () => store.readGoal(sessionId),
            loadLsp: () => buildLspView(workspace.root),
            loadTasks: () => buildTaskView(store, sessionId, workspace.root),
            settingsPath,
            tools: toolNames,
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
                prompt();
                return;
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
              await runAgent(answer, existingMessages.slice(0, -1), {
                config,
                workspace,
                approvalMode,
                sessionId,
                onMessage,
                budgetUsd,
                compactThreshold,
                mutatingAllowed,
                images,
                preToolUseHooks,
              });
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
