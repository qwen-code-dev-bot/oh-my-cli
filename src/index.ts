#!/usr/bin/env node

import { Command } from "commander";
import { resolveModelConfig, resolveSettingsPath, describeResolvedConfig } from "./settings.js";
import { Workspace } from "./workspace.js";
import { SessionStore } from "./session.js";
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
import { formatProductBanner, VERSION } from "./product-banner.js";
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
  .option("--health", "Show MCP server and extension health inventory and exit")
  .option("--settings <path>", "Unified settings file for model config and --health (default ~/.oh-my-cli/settings.json)")
  .option("--list-sessions", "List resumable sessions with a redacted usage summary and exit")
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
  .option("--base <ref>", "Base ref for --review-change and --ci-handoff (default origin/main, then HEAD)")
  .option("--ci-handoff", "Compose verify and review into a bounded, redacted, head-bound CI handoff brief and exit")
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

      const config = resolveModelConfig({
        settingsPath: resolveSettingsPath(opts.settings),
        env: process.env,
      }).config;
      const workspace = new Workspace(opts.workspace);
      const store = new SessionStore();
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

      if (opts.resume) {
        sessionId = opts.resume;
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
        });
        sealSession();
        if (opts.summary) {
          const summary = buildRunSummary({
            ok: result.ok,
            exitCode: result.ok ? 0 : 1,
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
          });
          process.stdout.write("\n" + formatRunSummary(summary) + "\n");
        }
      } else if (opts.resume) {
        // Resume mode: need a new prompt from stdin
        if (process.stdin.isTTY) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          rl.question("> ", async (answer) => {
            rl.close();
            if (!answer.trim()) {
              process.stderr.write("No prompt provided, exiting.\n");
              process.exit(0);
            }
            await runAgent(answer, existingMessages, {
              config,
              workspace,
              approvalMode,
              sessionId,
              onMessage,
              budgetUsd,
              compactThreshold,
              mutatingAllowed,
            });
          });
        } else {
          process.stderr.write("Error: --resume requires a TTY for interactive input, or use -p\n");
          process.exit(1);
        }
      } else {
        // Interactive REPL
        if (!process.stdin.isTTY) {
          process.stderr.write("Error: interactive mode requires a TTY. Use -p for non-interactive.\n");
          process.exit(1);
        }

        const useColor = colorEnabled({ noColor: opts.color === false, env: process.env });

        // Build palette commands with live context
        const paletteCommands: PaletteCommand[] = [
          ...defaultCommands(),
          { name: "/tools", description: "List available agent tools (read, write, edit, shell)", action: () => { process.stderr.write("Tools: read, write, edit, shell\n"); } },
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
            paletteCommands,
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

        const prompt = () => {
          rl.question("> ", async (answer) => {
            if (paletteOpen) return;
            if (!answer.trim()) {
              prompt();
              return;
            }
            if (answer.trim() === "/exit" || answer.trim() === "/quit") {
              process.stdin.removeListener("data", ctrlKHandler);
              rl.close();
              process.exit(0);
            }
            try {
              existingMessages = loadSessionMessages(store, sessionId);
              await runAgent(answer, existingMessages.slice(0, -1), {
                config,
                workspace,
                approvalMode,
                sessionId,
                onMessage,
                budgetUsd,
                compactThreshold,
                mutatingAllowed,
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
