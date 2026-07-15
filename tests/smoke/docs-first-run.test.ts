import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.on("error", reject);
  });
}

// Pull every `oh-my-cli` invocation out of the guide's ```bash fences so the
// documented first-run path is what gets verified — not a hand-maintained copy.
function extractCliCommands(markdown: string): string[] {
  const commands: string[] = [];
  let fenceLang: string | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      fenceLang = fenceLang === null ? trimmed.slice(3).trim() : null;
      continue;
    }
    if (fenceLang === "bash" && trimmed.startsWith("oh-my-cli")) {
      commands.push(trimmed);
    }
  }
  return commands;
}

// Minimal shell-word splitter for documented commands (double quotes only).
function splitArgs(command: string): string[] {
  const rest = command.slice("oh-my-cli".length).trim();
  const args: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of rest) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === " " && !inQuote) {
      if (cur) { args.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

const USAGE_ERROR = /error: unknown option|error: missing required argument|error: required option|unknown command/i;

describe("smoke: first-run documentation commands", () => {
  let server: FakeServer;
  let homeDir: string;
  let commands: string[];

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-docs-smoke-"));
    const guide = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../docs/FIRST-RUN.md"),
      "utf-8",
    );
    commands = extractCliCommands(guide);
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("documents a meaningful set of verifiable commands", () => {
    // Guards against the guide being gutted: the first-run path must stay verified.
    expect(commands.length).toBeGreaterThanOrEqual(5);
  });

  it("runs every documented command without stale syntax", async () => {
    server.setResponse({ type: "text", content: "ok from smoke" });
    const env = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };

    for (const command of commands) {
      const args = splitArgs(command);
      const r = await runCli(args, env);

      // Stale syntax (a renamed/removed flag) surfaces as a commander usage error.
      expect(r.stderr, `stale syntax in documented command: ${command}\n${r.stderr}`).not.toMatch(USAGE_ERROR);
      // With a fake provider and a clean temp env, every documented command succeeds.
      expect(r.code, `non-zero exit for documented command: ${command}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    }
  });
});
