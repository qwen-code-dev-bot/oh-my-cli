#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { Workspace } from "./workspace.js";
import { SessionStore } from "./session.js";
import { runAgent } from "./agent.js";
import type { ApprovalMode } from "./approval.js";
import type { SessionMessage } from "./session.js";

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
  .action(async (opts) => {
    try {
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

        process.stderr.write(`Session: ${sessionId}\n`);

        const prompt = () => {
          rl.question("> ", async (answer) => {
            if (!answer.trim()) {
              prompt();
              return;
            }
            if (answer.trim() === "/exit" || answer.trim() === "/quit") {
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
