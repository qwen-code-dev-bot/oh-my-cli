import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";

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

describe("Integration: session health inspection (--inspect-session, Issue #600)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_200_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snap.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    return snap;
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-600i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-600i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(opts: { goal?: boolean; name?: string } = {}): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: wsDir, createdAt: NOW });
    store.append(id, { role: "user", content: "inspect me" });
    store.append(id, { role: "assistant", content: "inspected" });
    if (opts.goal) {
      runGoalCommand(store, id, "the inspect mission", NOW + 1);
      runGoalCommand(store, id, "title Inspect", NOW + 2);
    }
    if (opts.name !== undefined) store.writeName(id, opts.name);
    return id;
  }

  it("renders the health card with truthful verdict and inventory (text + JSON agree)", async () => {
    const id = seed({ goal: true, name: "inspected work" });
    const text = await runCli(["--inspect-session", id], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("integrity:  ok · 2 message(s) · 0 bad line(s)");
    expect(text.stdout).toContain('name:       "inspected work"');
    expect(text.stdout).toContain("goal:       active · revision 1 · history 2 entries");
    expect(text.stdout).toContain(`next:       resume: oh-my-cli --resume ${id} -p "<prompt>"`);

    const json = await runCli(["--inspect-session", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-inspect");
    expect(record.v).toBe(1);
    expect(record.sessionId).toBe(id);
    expect(record.name).toBe("inspected work");
    expect(record.integrity).toEqual({ status: "ok", messageCount: 2, badLines: 0 });
    expect(record.meta.workspace).toBe(wsDir);
    expect(record.sidecars.name).toBe(true);
    expect(record.sidecars.goal).toBe(true);
    expect(record.sidecars.goalStatus).toBe("active");
    expect(record.sidecars.goalHistory).toBe(2);
    expect(record.sidecars.archived).toBe(false);
    expect(record.sidecars.compact).toBe(false);
    expect(record.sidecars.tasks).toBe(false);
    expect(record.sidecars.turnLog).toBe(false);
    expect(record.sidecars.failures).toBe(false);
    // Counts agree between the two modes.
    expect(record.integrity.messageCount).toBe(2);
  });

  it("is strictly read-only: the store stays byte-identical across text + JSON inspections", async () => {
    const id = seed({ goal: true });
    store.writeArchived(id, NOW);
    const before = dirSnapshot();
    const a = await runCli(["--inspect-session", id], baseEnv);
    const b = await runCli(["--inspect-session", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(dirSnapshot()).toEqual(before);
  });

  it("inspects a corrupt session without quarantining it and hints salvage", async () => {
    const id = "corrupt-600i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const before = fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8");
    const r = await runCli(["--inspect-session", id], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("integrity:  corrupt");
    expect(r.stdout).toContain("--salvage-session");
    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(before);
    expect(fs.readdirSync(sessionsDir()).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("inspects by user-owned name", async () => {
    const id = seed({ name: "named target" });
    const r = await runCli(["--inspect-session", "named target", "--output", "json"], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim()).sessionId).toBe(id);
  });

  it("fails closed on unknown targets and bad formats before any output", async () => {
    const unknown = await runCli(["--inspect-session", "no-such-session"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot inspect");
    expect(unknown.stdout).toBe("");

    const id = seed();
    const badFormat = await runCli(["--inspect-session", id, "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });
});
