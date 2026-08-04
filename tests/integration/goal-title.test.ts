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

describe("Integration: goal title (--goal title, Issue #586)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-586i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-586i-home-"));
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

  function seedSession(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: tmpDir, createdAt: 1 });
    store.append(id, { role: "user", content: "earlier turn" });
    store.append(id, { role: "assistant", content: "earlier answer" });
    return id;
  }

  it("sets and renders a title through the headless surfaces", async () => {
    const id = seedSession();
    const set = await runCli(["--goal", "migrate the storage layer", "--session", id], baseEnv);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("Goal set (revision 1)");

    const titled = await runCli(["--goal", "title Storage migration", "--session", id], baseEnv);
    expect(titled.code).toBe(0);
    expect(titled.stdout).toContain("Goal titled (revision 1): Storage migration");

    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.goal.title).toBe("Storage migration");
    expect(parsed.goal.objective).toBe("migrate the storage layer");
    expect(parsed.goal.revision).toBe(1);
    // The title entry is recorded in the history at the same revision.
    expect(parsed.history.map((h: { kind: string }) => h.kind)).toEqual(["title", "set"]);
    expect(parsed.history.map((h: { revision: number }) => h.revision)).toEqual([1, 1]);

    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.stdout).toContain("title:     Storage migration");
  });

  it("clears a title headlessly", async () => {
    const id = seedSession();
    await runCli(["--goal", "objective", "--session", id], baseEnv);
    await runCli(["--goal", "title A label", "--session", id], baseEnv);
    const cleared = await runCli(["--goal", "title", "--session", id], baseEnv);
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toContain("Goal title cleared (revision 1)");
    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.goal.title).toBeUndefined();
  });

  it("renders the resume summary title-first on --resume", async () => {
    const id = seedSession();
    await runCli(["--goal", "a long objective about migrating storage", "--session", id], baseEnv);
    await runCli(["--goal", "title Storage migration", "--session", id], baseEnv);
    const r = await runCli(
      ["-p", "keep going", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      "Goal: active (Storage migration) · a long objective about migrating storage · rev 1 · updated",
    );
    expect(r.stdout).toContain("resumed answer");
  });

  it("refuses to title without a goal, headlessly", async () => {
    const id = seedSession();
    const r = await runCli(["--goal", "title Anything", "--session", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Goal: nothing to title");
  });

  it("keeps the goal sidecar byte-intact through title reads", async () => {
    const id = seedSession();
    await runCli(["--goal", "objective", "--session", id], baseEnv);
    await runCli(["--goal", "title Label", "--session", id], baseEnv);
    const goalPath = path.join(homeDir, ".oh-my-cli", "sessions", `${id}.goal.json`);
    const before = fs.readFileSync(goalPath, "utf8");
    const r1 = await runCli(["--goal-status", id], baseEnv);
    const r2 = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(fs.readFileSync(goalPath, "utf8")).toBe(before);
  });
});
