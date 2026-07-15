#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
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
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
import { collectRepoReadiness, formatRepoReadiness } from "./repo-readiness.js";
import {
  readRecoveryCheckpoint,
  readEvidenceFile,
  currentRepoHead,
  evaluateRecovery,
  formatRecoveryPlan,
} from "./run-recovery.js";
import type { RecoveryContext } from "./run-recovery.js";
import {
  createWorktreeLease,
  cleanWorktreeLease,
  formatWorktreeLeaseResult,
} from "./worktree-lease.js";
import { HeadlessWriter, createHeadlessSink, startEvent } from "./headless-protocol.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { buildRunSummary, formatRunSummary } from "./run-summary.js";
import {
  readRunSummaryFile,
  compareRunSummaries,
  formatScorecard,
  parseScorecardThresholds,
} from "./run-scorecard.js";
import type { RegressionThresholds } from "./run-scorecard.js";
import type { RunSummary } from "./run-summary.js";
import { colorEnabled, createColorPalette } from "./color.js";
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
  .option("--health", "Show MCP server and extension health inventory and exit")
  .option("--settings <path>", "Integrations settings file for --health (default <workspace>/.oh-my-cli/settings.json)")
  .option("--list-sessions", "List resumable sessions with a redacted usage summary and exit")
  .option("--doctor", "Run read-only installation and platform readiness checks and exit")
  .option("--readiness", "Inspect repository readiness for a blocked task (read-only) and exit")
  .option("--expected-branch <name>", "Expected branch for the --readiness branch check")
  .option("--remote <name>", "Git remote to probe for --readiness (default origin)", "origin")
  .option("--recover", "Resume an interrupted task from a recovery checkpoint (read-only) and exit")
  .option("--checkpoint <file>", "Recovery checkpoint file for --recover")
  .option("--task-identity <id>", "Stable task identity (used by --recover and worktree leases)")
  .option("--evidence <file>", "Current evidence file (JSON stepId -> digest) for --recover")
  .option("--create-worktree", "Create a leased git worktree for a mutating delegated agent and exit")
  .option("--clean-worktree", "Clean a leased git worktree after verified completion and exit")
  .option("--agent-identity <id>", "Stable agent identity for a leased worktree (with --create-worktree/--clean-worktree)")
  .option("--worktree-root <dir>", "Directory where leased worktrees live (default <workspace>/.oh-my-cli/worktrees)")
  .option(
    "--output <format>",
    "Output format for -p mode: text (default) or json (versioned NDJSON event stream)",
    "text",
  )
  .option("--no-color", "Disable ANSI color output (also honors the NO_COLOR env var)")
  .option("--summary", "Print a privacy-safe execution summary for the run (unattended use)")
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

      if (opts.doctor) {
        const report = collectDoctorReport();
        process.stdout.write(formatDoctorReport(report) + "\n");
        process.exit(report.ok ? 0 : 1);
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
        const settingsPath =
          opts.settings ?? path.join(opts.workspace, ".oh-my-cli", "settings.json");
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

      if (opts.preflight) {
        const config = loadConfig();
        const result = await runPreflight(config);
        process.stdout.write(formatPreflight(result) + "\n");
        process.exit(result.ok ? 0 : 1);
      }

      const config = loadConfig();
      const workspace = new Workspace(opts.workspace);
      const store = new SessionStore();
      const approvalMode = opts.approvalMode as ApprovalMode;

      if (!["default", "auto-edit", "yolo"].includes(approvalMode)) {
        process.stderr.write(`Error: invalid approval mode "${approvalMode}"\n`);
        process.exit(1);
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
        existingMessages = store.load(sessionId);
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
                toolCalls: result.stats.toolCalls,
                toolFailures: result.stats.toolFailures,
                tokens: result.tokens,
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
        });
        sealSession();
        if (opts.summary) {
          const summary = buildRunSummary({
            ok: result.ok,
            exitCode: result.ok ? 0 : 1,
            reason: result.reason,
            elapsedMs: Date.now() - startedAt,
            rounds: result.rounds,
            toolCalls: result.stats.toolCalls,
            toolFailures: result.stats.toolFailures,
            tokens: result.tokens,
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
        const { bold: BOLD, dim: DIM, reset: RESET } = createColorPalette(useColor);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

        // Build palette commands with live context
        const paletteCommands: PaletteCommand[] = [
          ...defaultCommands(),
          { name: "/tools", description: "List available agent tools (read, write, edit, shell)", action: () => { process.stderr.write("Tools: read, write, edit, shell\n"); } },
        ];

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
              existingMessages = store.load(sessionId);
              await runAgent(answer, existingMessages.slice(0, -1), {
                config,
                workspace,
                approvalMode,
                sessionId,
                onMessage,
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
