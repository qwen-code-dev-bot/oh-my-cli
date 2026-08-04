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

describe("Integration: salvage corrupt sessions (--salvage-session, Issue #546)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  function sessionsDir(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function sessionIds(dir: string): string[] {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  }

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-salvage-ws-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-salvage-sess-"));
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
  });

  it("salvages a corrupt session and resumes the salvaged history", async () => {
    // Seed a real session.
    server.setResponses([{ type: "text", content: "seed answer" }]);
    const seed = await runCli(["-p", "seed question", "--workspace", tmpDir], baseEnv);
    expect(seed.code).toBe(0);
    const ids = sessionIds(sessionsDir());
    const id = ids[ids.length - 1];

    // Corrupt it mid-file (a torn line between parseable messages; a merely
    // trailing torn line would be "partial" and resumable without salvage).
    const fp = path.join(sessionsDir(), `${id}.jsonl`);
    const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
    lines.splice(Math.max(1, lines.length - 1), 0, "{torn write — not json");
    fs.writeFileSync(fp, lines.join("\n") + "\n");
    const before = fs.readFileSync(fp, "utf-8");

    // Salvage by id.
    const salvage = await runCli(["--salvage-session", id], baseEnv);
    expect(salvage.code, `stderr: ${salvage.stderr}`).toBe(0);
    expect(salvage.stdout).toContain("Salvaged");
    expect(salvage.stdout).toMatch(/skipped 1 corrupt line\(s\)/);
    const newId = /into new session (\S+)/.exec(salvage.stdout)?.[1];
    expect(newId).toBeTruthy();

    // The source checkpoint is byte-identical.
    expect(fs.readFileSync(fp, "utf-8")).toBe(before);

    // The salvaged session resumes and carries the salvaged history.
    server.setResponses([{ type: "text", content: "resumed answer" }]);
    const resumed = await runCli(["--resume", newId!, "-p", "continue", "--workspace", tmpDir], baseEnv);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("resumed answer");
    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("seed question");
    expect(contents).toContain("seed answer");
    expect(contents).toContain("continue");
  });

  it("refuses a healthy session with an actionable reason", async () => {
    server.setResponses([{ type: "text", content: "healthy answer" }]);
    const seed = await runCli(["-p", "healthy seed", "--workspace", tmpDir], baseEnv);
    expect(seed.code).toBe(0);
    const ids = sessionIds(sessionsDir());
    const id = ids[ids.length - 1];
    const r = await runCli(["--salvage-session", id], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nothing to salvage");
  });

  it("fails closed for an unknown session value", async () => {
    const r = await runCli(["--salvage-session", "no-such-session"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cannot salvage");
  });
});
