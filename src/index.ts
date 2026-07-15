#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { Workspace } from "./workspace.js";
import { SessionStore } from "./session.js";
import { runAgent } from "./agent.js";
import type { ApprovalMode } from "./approval.js";
import type { SessionMessage } from "./session.js";
import { runPalette, defaultCommands } from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { runPreflight, formatPreflight } from "./preflight.js";
import { collectSandboxDiagnostic, formatDiagnostic } from "./sandbox-diag.js";
import { collectHealthInventory, formatHealthInventory } from "./health-inventory.js";
import { collectSessionSummaries, formatSessionList } from "./session-summary.js";
import path from "node:path";

const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

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
  .action(async (opts) => {
    try {
      if (opts.listSessions) {
        const store = new SessionStore();
        const summaries = collectSessionSummaries(store);
        process.stdout.write(formatSessionList(summaries) + "\n");
        process.exit(0);
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

      if (opts.prompt) {
        // Non-interactive mode
        await runAgent(opts.prompt, existingMessages, {
          config,
          workspace,
          approvalMode,
          sessionId,
          onMessage,
        });
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
            runPalette(paletteCommands, process.stdin, process.stdout).then(async (result) => {
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
