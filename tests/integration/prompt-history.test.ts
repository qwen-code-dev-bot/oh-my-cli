import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openPromptHistoryStore } from "../../src/prompt-history.js";

// Durable workspace prompt history (Issue #711) is an interactive-composer
// feature: headless `-p` runs must neither read nor write the store. These
// runs are spawned with piped stdio (never a TTY), so the shell is never
// selected — the assertions guard exactly that boundary.
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

describe("Integration: prompt history headless exclusion (Issue #711)", () => {
  let server: FakeServer;
  let homeDir: string;
  let workspace: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-711-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omc-711-ws-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const historyDir = (): string => path.join(homeDir, ".oh-my-cli", "prompt-history");

  it("a headless -p run never creates the prompt-history store", async () => {
    server.setResponse({ type: "text", content: "headless answer" });
    const r = await runCli(["-p", "a headless prompt", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("headless answer");
    expect(fs.existsSync(historyDir())).toBe(false);
  });

  it("a headless resumed turn leaves an existing store byte-identical", async () => {
    server.setResponse({ type: "text", content: "first turn" });
    const first = await runCli(
      ["-p", "seed a session", "--workspace", workspace, "--output", "json"],
      baseEnv,
    );
    expect(first.code).toBe(0);
    const list = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(list.code).toBe(0);
    const record = JSON.parse(list.stdout);
    const sessionId = record.sessions[0].id;

    // An interactive run of this workspace previously recorded a prompt.
    const store = openPromptHistoryStore({ workspacePath: workspace, historyDir: historyDir() });
    store.append("a prompt submitted interactively long ago");
    const before = fs.readFileSync(store.filePath);

    server.setResponse({ type: "text", content: "resumed turn" });
    const resumed = await runCli(
      ["-p", "a headless follow-up", "--workspace", workspace, "--resume", sessionId],
      baseEnv,
    );
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("resumed turn");

    // The headless turn neither appended to nor rewrote the durable record.
    const after = fs.readFileSync(store.filePath);
    expect(after.equals(before)).toBe(true);
  });
});
