import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: immediate Goal status summary on resume (Issue #584)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-584i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-584i-home-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.setResponses([{ type: "text", content: "resumed answer" }]);
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seedSession(withGoal: boolean): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: tmpDir, createdAt: 1 });
    store.append(id, { role: "user", content: "earlier turn" });
    store.append(id, { role: "assistant", content: "earlier answer" });
    if (withGoal) {
      store.writeGoal(id, {
        revision: 2,
        goal: { objective: "finish the migration", status: "active", createdAt: 1000, updatedAt: 2000 },
      });
    }
    return id;
  }

  it("surfaces the goal summary on --resume before the new turn", async () => {
    const id = seedSession(true);
    const r = await runCli(
      ["-p", "keep going", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Goal: active · finish the migration · rev 2 · updated");
    // The new turn still ran.
    expect(r.stdout).toContain("resumed answer");
  });

  it("surfaces the summary on --continue for the workspace's most recent session", async () => {
    const id = seedSession(true);
    const r = await runCli(
      ["-p", "keep going", "--continue", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`Continuing session ${id.slice(0, 8)}`);
    expect(r.stderr).toContain("Goal: active · finish the migration · rev 2 · updated");
    expect(r.stdout).toContain("resumed answer");
  });

  it("stays silent when the resumed session has no goal", async () => {
    const id = seedSession(false);
    const r = await runCli(
      ["-p", "keep going", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Goal:");
    expect(r.stdout).toContain("resumed answer");
  });

  it("resumes silently with a corrupt goal sidecar, preserving the bytes", async () => {
    const id = seedSession(false);
    const goalPath = path.join(homeDir, ".oh-my-cli", "sessions", `${id}.goal.json`);
    fs.writeFileSync(goalPath, "{ not json");
    const r = await runCli(
      ["-p", "keep going", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Goal:");
    expect(r.stdout).toContain("resumed answer");
    expect(fs.readFileSync(goalPath, "utf8")).toBe("{ not json");
  });

  it("never mutates the goal sidecar on resume", async () => {
    const id = seedSession(true);
    const goalPath = path.join(homeDir, ".oh-my-cli", "sessions", `${id}.goal.json`);
    const before = fs.readFileSync(goalPath, "utf8");
    const r = await runCli(
      ["-p", "keep going", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(fs.readFileSync(goalPath, "utf8")).toBe(before);
  });
});
