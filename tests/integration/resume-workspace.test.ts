import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// --resume is workspace-bound (Issue #554): a foreign-workspace session is
// never silently resumed into another workspace; the refusal names the cause
// and a safe next action, the session stays untouched, and no provider call
// happens. Same-workspace and legacy (no recorded workspace) resumes proceed.

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

describe("Integration: workspace-bound resume (Issue #554)", () => {
  let server: FakeServer;
  let wsA: string;
  let wsB: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-554-wsA-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-554-wsB-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-554-sess-"));
    fs.writeFileSync(path.join(wsA, "a.txt"), "workspace A\n");
    fs.writeFileSync(path.join(wsB, "b.txt"), "workspace B\n");
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.setResponses([{ type: "text", content: "an answer" }]);
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function sessionIds(): string[] {
    if (!fs.existsSync(sessionsHome())) return [];
    return fs
      .readdirSync(sessionsHome())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  // Seed one completed session that belongs to workspace A.
  async function seedSessionInA(): Promise<string> {
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
    const r = await runCli(
      ["-p", "work in A", "--approval-mode", "yolo", "--workspace", wsA],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const ids = sessionIds();
    expect(ids.length).toBe(1);
    return ids[0];
  }

  it("refuses a foreign-workspace resume with cause + next action, untouched session, no provider call", async () => {
    const id = await seedSessionInA();
    const file = path.join(sessionsHome(), `${id}.jsonl`);
    const before = fs.readFileSync(file, "utf8");
    const requestsBefore = server.requests.length;

    const r = await runCli(
      ["-p", "try to resume", "--resume", id, "--approval-mode", "yolo", "--workspace", wsB],
      baseEnv,
    );

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot resume");
    expect(r.stderr).toContain("belongs to workspace");
    // Both workspaces are named (home-collapsed/redacted) and safe next
    // actions are offered.
    expect(r.stderr).toContain("Resume it from its own workspace");
    expect(r.stderr).toContain("--export-session");
    expect(r.stderr).toContain("--session-stats");
    // No provider interaction and no mutation of the session.
    expect(server.requests.length).toBe(requestsBefore);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // Read-only inspection still works from anywhere.
    const stats = await runCli(["--session-stats", id], baseEnv);
    expect(stats.code).toBe(0);
    expect(stats.stdout).toContain("Session activity");
  });

  it("refuses by name too (the name path shares the guard)", async () => {
    const id = await seedSessionInA();
    const rename = await runCli(["--rename-session", id, "--session-name", "proj-a"], baseEnv);
    expect(rename.code).toBe(0);

    const r = await runCli(
      ["-p", "try to resume", "--resume", "proj-a", "--approval-mode", "yolo", "--workspace", wsB],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot resume");
    expect(r.stderr).toContain("belongs to workspace");
  });

  it("same-workspace resume proceeds unchanged", async () => {
    const id = await seedSessionInA();
    // The seed consumed the queued response; queue the resumed turn's answer.
    server.setResponses([{ type: "text", content: "resumed answer" }]);
    const requestsBefore = server.requests.length;

    const r = await runCli(
      ["-p", "continue the work", "--resume", id, "--approval-mode", "yolo", "--workspace", wsA],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(server.requests.length).toBe(requestsBefore + 1);
    expect(r.stdout).toContain("resumed answer");
  });

  it("a legacy session without workspace metadata warns and resumes", async () => {
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
    fs.mkdirSync(sessionsHome(), { recursive: true });
    const id = "legacy-no-workspace";
    const lines = [
      JSON.stringify({ meta: true, model: "fake-model", createdAt: 1 }),
      JSON.stringify({ role: "user", content: "old turn" }),
      JSON.stringify({ role: "assistant", content: "old answer" }),
    ];
    fs.writeFileSync(path.join(sessionsHome(), `${id}.jsonl`), lines.join("\n") + "\n");

    const r = await runCli(
      ["-p", "continue", "--resume", id, "--approval-mode", "yolo", "--workspace", wsB],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no recorded workspace");
    expect(r.stderr).toContain("without a workspace binding check");
    expect(r.stdout).toContain("an answer");
  });
});
