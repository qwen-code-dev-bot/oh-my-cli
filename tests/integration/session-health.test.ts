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

const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });

describe("Integration: session health report (--health-report, Issue #666)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let okId1: string;
  let okId2: string;
  const partialId = "partial-cli";
  const corruptId = "corrupt-cli";

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function writeTranscript(id: string, lines: string[]): void {
    fs.writeFileSync(path.join(sessionsDir(), `${id}.jsonl`), lines.join("\n") + "\n");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-666i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    okId1 = store.newId();
    store.checkpoint(okId1, [{ role: "user", content: "healthy one" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    okId2 = store.newId();
    store.checkpoint(okId2, [{ role: "user", content: "healthy two" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 2,
    });
    writeTranscript(partialId, [
      META,
      JSON.stringify({ role: "user", content: "before the tear" }),
      "{torn trailing write",
    ]);
    writeTranscript(corruptId, [
      META,
      "{torn middle write",
      JSON.stringify({ role: "user", content: "after the damage" }),
    ]);
  });

  it("reports worst-first health with rollups in text and JSON, exit 0 despite damage", async () => {
    const text = await runCli(["--health-report"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Session health report");
    expect(text.stdout).toContain("4 session(s): 2 ok, 1 partial, 1 corrupt.");

    const json = await runCli(["--health-report", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-health");
    expect(record.v).toBe(1);
    expect(record.sessionCount).toBe(4);
    expect(record.counts).toEqual({ ok: 2, partial: 1, corrupt: 1 });
    expect(record.sessions.map((s: { integrity: string }) => s.integrity)).toEqual([
      "corrupt",
      "partial",
      "ok",
      "ok",
    ]);
    const byId = new Map(record.sessions.map((s: { sessionId: string; integrity: string }) => [s.sessionId, s.integrity]));
    expect(byId.get(corruptId)).toBe("corrupt");
    expect(byId.get(partialId)).toBe("partial");
    expect(byId.get(okId1)).toBe("ok");
    expect(byId.get(okId2)).toBe("ok");
    const oks = record.sessions
      .filter((s: { integrity: string }) => s.integrity === "ok")
      .map((s: { sessionId: string }) => s.sessionId);
    expect(oks).toEqual([okId1, okId2].sort((a, b) => a.localeCompare(b)));
  });

  it("reports an empty store honestly", async () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    const text = await runCli(["--health-report"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("0 session(s): 0 ok, 0 partial, 0 corrupt.");

    const json = await runCli(["--health-report", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.sessionCount).toBe(0);
    expect(record.counts).toEqual({ ok: 0, partial: 0, corrupt: 0 });
    expect(record.sessions).toEqual([]);
  });

  it("fails closed on a bad output format", async () => {
    const bad = await runCli(["--health-report", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("never mutates the store through report reads", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--health-report", "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
