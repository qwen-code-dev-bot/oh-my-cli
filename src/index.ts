#!/usr/bin/env node

import { Command } from "commander";
import { resolveModelConfig, resolveSettingsPath, describeResolvedConfig } from "./settings.js";
import {
  RUNTIME_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMAND_DESCRIPTORS,
  formatRuntimeSlashCommand,
  formatSlashCommandHelp,
  resolveSlashCommand,
} from "./slash-command.js";
import { resolveEffectiveSettings, formatEffectiveSettings } from "./effective-settings.js";
import { collectWorkflowList, formatWorkflowList } from "./workflow-contract.js";
import { runWorkflow, formatWorkflowStepLine } from "./workflow-runner.js";
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
import {
  createWorktreeLease,
  cleanWorktreeLease,
  formatWorktreeLeaseResult,
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

// Handle Ctrl-C gracefully — session is already persisted incrementally
process.on("SIGINT", () => {
  process.stderr.write("\nInterrupted. Session saved.\n");
  process.exit(130);
});

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
  .option("--health", "Show MCP server and extension health inventory and exit")
  .option("--settings <path>", "Unified settings file for model config and --health (default ~/.oh-my-cli/settings.json)")
  .option("--effective-settings", "Show the effective, redacted, hierarchical settings snapshot (user + trusted project, validated; read-only) and exit")
  .option("--list-workflows", "List declared workflows from user settings (read-only, redacted) and exit")
  .option("--run-workflow <name>", "Run a named workflow from user settings non-interactively (sequential headless steps) and exit")
  .option("--list-sessions", "List resumable sessions with a redacted usage summary and exit")
  .option("--browse-sessions", "Interactively browse, search, and resume a previous session (requires a terminal)")
  .option("--compact <session-id>", "Compact a session into a bounded summary sidecar (original preserved) and exit")
  .option("--compact-threshold <tokens>", "Auto-compact the in-memory transcript when the latest prompt size reaches this (env: OMC_COMPACT_THRESHOLD)")
  .option("--doctor", "Run read-only installation and platform readiness checks and exit")
  .option("--readiness", "Inspect repository readiness for a blocked task (read-only) and exit")
  .option("--expected-branch <name>", "Expected branch for the --readiness branch check")
  .option("--remote <name>", "Git remote to probe for --readiness (default origin)", "origin")
  .option("--repo-context", "Inspect a bounded, redacted repository context snapshot (read-only) and exit")
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

      // Leased-worktree mode: create or clean one isolated git worktree per
      // mutating delegated agent, offline (no provider config needed). Exits 0
      // on success (including idempotent no-ops), 1 on a safety refusal, and 2
      // on a usage error or unexpected git failure.
      if (opts.createWorktree || opts.cleanWorktree) {
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(2);
        }
        if (opts.createWorktree && opts.cleanWorktree) {
          process.stderr.write("Error: choose one of --create-worktree or --clean-worktree\n");
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
        const resolved = resolveModelConfig({
          settingsPath: resolveSettingsPath(opts.settings),
          env: process.env,
        });
        process.stderr.write(describeResolvedConfig(resolved) + "\n");
        const result = await runPreflight(resolved.config);
        process.stdout.write(formatPreflight(result) + "\n");
        process.exit(result.ok ? 0 : 1);
      }

      const settingsPath = resolveSettingsPath(opts.settings);
      const config = resolveModelConfig({
        settingsPath,
        env: process.env,
      }).config;
      const store = new SessionStore();

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
      } else {
        sessionId = store.newId();
        store.writeMeta(sessionId, {
          model: config.model,
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

      if (opts.prompt) {
        // Non-interactive mode
        const format = String(opts.output ?? "text");
        if (format !== "text" && format !== "json") {
          process.stderr.write(`Error: invalid output format "${format}"\n`);
          process.exit(1);
        }

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
          writer.emit(startEvent({ sessionId, model: config.model, prompt: opts.prompt }));
          const sink = createHeadlessSink(writer);
          const startedAt = Date.now();
          let result: AgentResult;
          try {
            result = await runAgent(opts.prompt, existingMessages, {
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
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            writer.emit({ type: "error", stage: "internal", message: redactSecrets(msg).text });
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
        const result = await runAgent(opts.prompt, existingMessages, {
          config,
          workspace,
          approvalMode,
          sessionId,
          onMessage,
          budgetUsd,
          compactThreshold,
          mutatingAllowed,
          images,
        });
        sealSession();
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
