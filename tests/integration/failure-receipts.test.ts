import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
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

describe("Integration: shell failure receipts (--failures, Issue #574)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-574i-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-574i-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
    for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function singleSessionId(): string {
    const ids = fs.readdirSync(sessionsHome()).filter((f) => f.endsWith(".jsonl"));
    expect(ids.length).toBe(1);
    return ids[0].slice(0, -".jsonl".length);
  }

  function sidecarPath(id: string): string {
    return path.join(sessionsHome(), `${id}.failures.json`);
  }

  // One turn with a failing shell command (exit 3) and a passing one.
  async function runMixedTurn(): Promise<string> {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [
          { id: "f1", name: "shell", arguments: JSON.stringify({ command: "echo about-to-fail; exit 3" }) },
          { id: "f2", name: "shell", arguments: JSON.stringify({ command: "echo passing" }) },
        ],
      },
      { type: "text", content: "DONE_MARK" },
    ]);
    const r = await runCli(
      ["-p", "run the commands", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    return singleSessionId();
  }

  it("records exactly one receipt for the failing shell run, none for the passing one", async () => {
    const id = await runMixedTurn();
    expect(fs.existsSync(sidecarPath(id))).toBe(true);
    const log = JSON.parse(fs.readFileSync(sidecarPath(id), "utf8"));
    expect(log.schema).toBe("oh-my-cli.failures");
    expect(log.v).toBe(1);
    expect(log.receipts).toHaveLength(1);
    const receipt = log.receipts[0];
    expect(receipt.seq).toBe(1);
    expect(receipt.status).toBe(3);
    expect(receipt.exitState).toBe("nonzero");
    expect(receipt.command).toContain("about-to-fail");
    expect(receipt.command).not.toContain("passing");
    expect(receipt.stdoutTail).toContain("about-to-fail");
  });

  it("renders the receipts newest-first with revision context (text and json)", async () => {
    const id = await runMixedTurn();
    const text = await runCli(["--failures", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Failure receipts");
    expect(text.stdout).toContain("#1");
    expect(text.stdout).toContain("exit code 3");
    expect(text.stdout).toContain("about-to-fail");
    expect(text.stdout).not.toContain("No recorded failures");
    expect(text.stdout).not.toMatch(/\x1b\[/);

    const json = await runCli(["--failures", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.failures");
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.receipts).toHaveLength(1);
    expect(parsed.receipts[0].exitState).toBe("nonzero");
  });

  it("is strictly read-only: sidecar and session are byte-identical after reads", async () => {
    const id = await runMixedTurn();
    const before =
      fs.readFileSync(sidecarPath(id), "utf8") +
      fs.readFileSync(path.join(sessionsHome(), `${id}.jsonl`), "utf8");
    const a = await runCli(["--failures", id], baseEnv);
    const b = await runCli(["--failures", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const after =
      fs.readFileSync(sidecarPath(id), "utf8") +
      fs.readFileSync(path.join(sessionsHome(), `${id}.jsonl`), "utf8");
    expect(after).toBe(before);
  });

  it("shows the explicit empty state for a session without failures", async () => {
    server.setResponses([{ type: "text", content: "just an answer" }]);
    const r0 = await runCli(["-p", "hello", "--approval-mode", "yolo", "--workspace", tmpDir], baseEnv);
    expect(r0.code).toBe(0);
    const id = singleSessionId();
    const r = await runCli(["--failures", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No recorded failures for this session.");
  });

  it("fails closed (exit 2) for an unknown session and a bad format", async () => {
    const missing = await runCli(["--failures", "no-such-session"], baseEnv);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Error");

    const id = await runMixedTurn();
    const bad = await runCli(["--failures", id, "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid output format");
  });
});
