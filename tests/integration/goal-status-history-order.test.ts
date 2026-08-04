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

describe("Integration: --goal-status text history ordering (Issue #588)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_785_960_000_000;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-588i-"));
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

  it("renders text history newest-first with one current marker on the newest entry", async () => {
    const id = seedSession();
    runGoalCommand(store, id, "migrate storage", NOW);
    runGoalCommand(store, id, "title Storage migration", NOW + 1000);
    runGoalCommand(store, id, "pause", NOW + 2000);

    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.code).toBe(0);
    const entryLines = text.stdout.split("\n").filter((l) => l.trimStart().startsWith("rev "));
    expect(entryLines).toHaveLength(3);
    expect(entryLines[0]).toContain("rev 2 · pause");
    expect(entryLines[1]).toContain("rev 1 · title · Storage migration");
    expect(entryLines[2]).toContain("rev 1 · set · migrate storage");
    expect(text.stdout.match(/\(current\)/g)).toHaveLength(1);
    expect(entryLines[0]).toContain("(current)");

    // The text ordering matches the JSON ordering.
    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.history.map((h: { kind: string }) => h.kind)).toEqual(["pause", "title", "set"]);
  });

  it("keeps the goal sidecar byte-identical through repeated text reads", async () => {
    const id = seedSession();
    runGoalCommand(store, id, "objective", NOW);
    runGoalCommand(store, id, "title Label", NOW + 1000);
    const before = fs.readFileSync(store.goalPath(id), "utf8");
    const a = await runCli(["--goal-status", id], baseEnv);
    const b = await runCli(["--goal-status", id], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(fs.readFileSync(store.goalPath(id), "utf8")).toBe(before);
  });
});
