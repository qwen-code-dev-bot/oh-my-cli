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

describe("Integration: session comparison (--diff-sessions, Issue #622)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-622i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(contents: string[], name?: string): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: 1_700_600_000_000 });
    for (const content of contents) {
      store.append(id, { role: "user", content });
    }
    if (name !== undefined) store.writeName(id, name);
    return id;
  }

  it("diffs a fork against its origin end-to-end with text/JSON agreement", async () => {
    const origin = seed(["base work"], "origin work");
    const forkProbe = await runCli(["--fork-session", origin, "--output", "json"], baseEnv);
    expect(forkProbe.code, `stderr: ${forkProbe.stderr}`).toBe(0);
    const fork = (JSON.parse(forkProbe.stdout.trim()) as { newSessionId: string }).newSessionId;
    store.append(fork, { role: "user", content: "fork-only exploration" });

    const text = await runCli(["--diff-sessions", origin, fork], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("shared:     1 leading message(s) identical");
    expect(text.stdout).toContain("provenance: B is a fork of A");
    expect(text.stdout).toContain("first divergence B: fork-only exploration");

    const json = await runCli(["--diff-sessions", origin, fork, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-diff");
    expect(record.a.sessionId).toBe(origin);
    expect(record.b.sessionId).toBe(fork);
    expect(record.forkRelationship).toBe("b-forked-from-a");
    expect(record.sharedPrefix).toBe(1);
    expect(record.aBeyond).toBe(0);
    expect(record.bBeyond).toBe(1);
    expect(record.bFirstDivergence).toBe("fork-only exploration");
    // Counts agree between the two modes.
    expect(text.stdout).toContain(`${record.sharedPrefix} leading message(s) identical`);
  });

  it("resolves both targets by user-owned name", async () => {
    seed(["same history"], "first work");
    seed(["same history"], "second work");
    const r = await runCli(["--diff-sessions", "first work", "second work", "--output", "json"], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.sharedPrefix).toBe(1);
    expect(record.aBeyond).toBe(0);
    expect(record.bBeyond).toBe(0);
    expect(record.a.name).toBe("first work");
    expect(record.b.name).toBe("second work");
  });

  it("fails closed on wrong arity and unknown targets before any output", async () => {
    const only = seed(["one"]);
    const one = await runCli(["--diff-sessions", only], baseEnv);
    expect(one.code).toBe(2);
    expect(one.stderr).toContain("exactly two");

    const three = await runCli(["--diff-sessions", only, only, only], baseEnv);
    expect(three.code).toBe(2);
    expect(three.stderr).toContain("exactly two");

    const unknown = await runCli(["--diff-sessions", only, "no-such-session"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot diff");

    const badFormat = await runCli(["--diff-sessions", only, only, "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("keeps the store byte-identical through comparisons", async () => {
    const a = seed(["alpha"]);
    const b = seed(["beta"]);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const r1 = await runCli(["--diff-sessions", a, b], baseEnv);
    const r2 = await runCli(["--diff-sessions", a, b, "--output", "json"], baseEnv);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
