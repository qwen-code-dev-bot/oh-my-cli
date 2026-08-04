import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: headless Goal control (--goal, Issue #582)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-582i-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seedSession(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp/ws", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    return id;
  }

  it("drives set → pause → resume → achieve headlessly, preserving the history", async () => {
    const id = seedSession();
    const set = await runCli(["--goal", "control me headlessly", "--session", id], baseEnv);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("Goal set (revision 1): control me headlessly");

    const pause = await runCli(["--goal", "pause", "--session", id], baseEnv);
    expect(pause.stdout).toContain("Goal paused (revision 2)");

    const resume = await runCli(["--goal", "resume", "--session", id], baseEnv);
    expect(resume.stdout).toContain("Goal resumed (revision 3)");

    const achieve = await runCli(["--goal", "achieve", "--session", id], baseEnv);
    expect(achieve.stdout).toContain("Goal achieved (revision 4)");

    const status = await runCli(["--goal-status", id], baseEnv);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("status:    achieved");
    expect(status.stdout).toContain("rev 4 · achieve");
    expect(status.stdout).toContain("rev 1 · set");
  });

  it("emits the versioned goal-control record with the post-transition checkpoint", async () => {
    const id = seedSession();
    const set = await runCli(["--goal", "json objective", "--session", id, "--output", "json"], baseEnv);
    expect(set.code).toBe(0);
    const parsed = JSON.parse(set.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.goal-control");
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.output).toContain("Goal set (revision 1)");
    expect(parsed.checkpoint.hasGoal).toBe(true);
    expect(parsed.checkpoint.goal.status).toBe("active");
    expect(parsed.checkpoint.goal.objective).toBe("json objective");
    expect(parsed.checkpoint.history.map((h: { kind: string }) => h.kind)).toEqual(["set"]);
  });

  it("fails closed (exit 2) for an unknown session, missing --session, and bad format", async () => {
    const missing = await runCli(["--goal", "status", "--session", "no-such-session"], baseEnv);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Error");

    const noSession = await runCli(["--goal", "status"], baseEnv);
    expect(noSession.code).toBe(2);
    expect(noSession.stderr).toContain("--goal requires --session");

    const id = seedSession();
    const bad = await runCli(["--goal", "status", "--session", id, "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid output format");
  });

  it("refuses to combine --goal with --side-question", async () => {
    const id = seedSession();
    const r = await runCli(
      ["--goal", "status", "--session", id, "--side-question", "what"],
      { ...baseEnv, OPENAI_API_KEY: "fake-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_MODEL: "fake-model" },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot be combined");
  });

  it("reports the honest no-goal state on a corrupt sidecar, preserving the bytes", async () => {
    const id = seedSession();
    const goalPath = path.join(homeDir, ".oh-my-cli", "sessions", `${id}.goal.json`);
    fs.writeFileSync(goalPath, "{ not json");
    const r = await runCli(["--goal", "status", "--session", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Goal: none (revision 0)");
    expect(fs.readFileSync(goalPath, "utf8")).toBe("{ not json");
  });

  it("resolves the session by user-owned name", async () => {
    const id = seedSession();
    store.writeName(id, "controlled");
    const set = await runCli(["--goal", "named goal", "--session", "controlled"], baseEnv);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("Goal set (revision 1): named goal");
  });

  it("clears headlessly and keeps the history", async () => {
    const id = seedSession();
    await runCli(["--goal", "temporary", "--session", id], baseEnv);
    const clear = await runCli(["--goal", "clear", "--session", id], baseEnv);
    expect(clear.code).toBe(0);
    expect(clear.stdout).toContain("Goal cleared (revision 2)");
    const status = await runCli(["--goal-status", id], baseEnv);
    expect(status.stdout).toContain("No goal recorded for this session.");
    expect(status.stdout).toContain("rev 2 · clear · (cleared)");
  });
});
