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

describe("Integration: goal revision history (--goal-status history, Issue #580)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_785_400_000_000;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-580i-"));
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

  it("renders the full transition history newest-first in JSON and text", async () => {
    const id = seedSession();
    runGoalCommand(store, id, "land the history", NOW);
    runGoalCommand(store, id, "pause", NOW + 1000);
    runGoalCommand(store, id, "resume", NOW + 2000);
    runGoalCommand(store, id, "achieve", NOW + 3000);

    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.hasGoal).toBe(true);
    expect(parsed.goal.status).toBe("achieved");
    expect(parsed.history.map((h: { kind: string }) => h.kind)).toEqual([
      "achieve",
      "resume",
      "pause",
      "set",
    ]);
    expect(parsed.history.map((h: { revision: number }) => h.revision)).toEqual([4, 3, 2, 1]);
    expect(parsed.history.every((h: { objective: string }) => h.objective === "land the history")).toBe(true);
    expect(parsed.elidedHistory).toBe(0);

    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("history (newest first):");
    expect(text.stdout).toContain("rev 4 · achieve");
    expect(text.stdout).toContain("rev 1 · set");
    expect(text.stdout).toContain("(current)");
  });

  it("synthesizes a legacy display entry without writing it back", async () => {
    const id = seedSession();
    store.writeGoal(id, {
      revision: 2,
      goal: { objective: "legacy goal", status: "paused", createdAt: NOW, updatedAt: NOW + 5 },
    });
    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0].kind).toBe("legacy");
    expect(parsed.history[0].revision).toBe(2);
    // Still no history field on disk (display-only synthesis).
    const raw = JSON.parse(fs.readFileSync(store.goalPath(id), "utf8"));
    expect(raw.history).toBeUndefined();
  });

  it("keeps history after clear and renders the honest no-goal state with it", async () => {
    const id = seedSession();
    runGoalCommand(store, id, "temporary goal", NOW);
    runGoalCommand(store, id, "clear", NOW + 1000);
    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("No goal recorded for this session.");
    expect(text.stdout).toContain("rev 2 · clear · (cleared)");
    expect(text.stdout).toContain("rev 1 · set");
  });

  it("fails closed through the CLI on a corrupt history array", async () => {
    const id = seedSession();
    fs.writeFileSync(
      store.goalPath(id),
      JSON.stringify({
        revision: 1,
        goal: { objective: "readable", status: "active", createdAt: NOW, updatedAt: NOW },
        history: "not an array",
      }) + "\n",
    );
    const r = await runCli(["--goal-status", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No goal recorded for this session.");
    // Bytes preserved.
    expect(fs.readFileSync(store.goalPath(id), "utf8")).toContain("not an array");
  });

  it("redacts secret-shaped objectives in history through the CLI", async () => {
    const id = seedSession();
    const secret = ["ghp", "_", "i".repeat(24)].join("");
    fs.writeFileSync(
      store.goalPath(id),
      JSON.stringify({
        revision: 1,
        goal: { objective: `use ${secret}`, status: "active", createdAt: NOW, updatedAt: NOW },
        history: [{ revision: 1, kind: "set", objective: `use ${secret}`, status: "active", at: NOW }],
      }) + "\n",
    );
    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    expect(json.stdout).not.toContain(secret);
    expect(json.stdout).toContain("[REDACTED]");
    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.stdout).not.toContain(secret);
  });

  it("is read-only: the goal sidecar is byte-identical after reads", async () => {
    const id = seedSession();
    runGoalCommand(store, id, "objective", NOW);
    runGoalCommand(store, id, "pause", NOW + 1000);
    const before = fs.readFileSync(store.goalPath(id), "utf8");
    const a = await runCli(["--goal-status", id], baseEnv);
    const b = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(fs.readFileSync(store.goalPath(id), "utf8")).toBe(before);
  });
});
