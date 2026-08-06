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

const CREATED_AT = 1_700_000_000_000;

describe("Integration: bundle verification (--verify-bundle, Issue #708)", () => {
  let homeDir: string;
  let env: Record<string, string>;
  let store: SessionStore;
  let bundlePath: string;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-708i-home-"));
    env = { HOME: homeDir };
    bundlePath = path.join(homeDir, "bundle.json");
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    fs.rmSync(bundlePath, { force: true });
    store = new SessionStore(sessionsDir());
    sessionId = store.newId();
    store.checkpoint(
      sessionId,
      [{ role: "user", content: "verify fodder" }],
      { model: "fake-model", workspace: "/srv/ws", createdAt: CREATED_AT },
    );
  });

  it("verifies a freshly bundled session healthy, exit 0", async () => {
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Bundle kind: session; 1 session(s) checked.");
    expect(res.stdout).toContain("Verdict: healthy.");
  });

  it("verifies a tampered bundle damaged, exit 1, with the damage line", async () => {
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8"));
    bundle.transcriptLines.push("{torn injected");
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));

    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("damaged (1 torn transcript line(s))");
    expect(res.stdout).toContain("Verdict: damaged.");
  });

  it("reports a torn sidecar carried raw from a damaged store", async () => {
    fs.writeFileSync(store.goalPath(sessionId), "{torn goal");
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("torn sidecars: goal");
  });

  it("verifies a healthy session with every sidecar present (raw carriage is not torn)", async () => {
    // Regression for the dogfood false positive: sidecars ride as raw
    // stored text by construction; parseable raw text is healthy.
    const { appendSessionNote } = await import("../../src/session-notes.js");
    const { appendCheckpoint } = await import("../../src/turn-checkpoint.js");
    appendSessionNote(store, sessionId, "a note", CREATED_AT + 1000);
    store.writePinned(sessionId, CREATED_AT + 2000);
    appendCheckpoint(store, sessionId, {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId,
      turnIndex: 0,
      head: null,
      messageCountBefore: 0,
      messageCountAfter: 1,
      messages: [{ role: "user", content: "fixture" }],
      files: [],
      digest: "0".repeat(64),
    });
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Verdict: healthy.");
  });

  it("verifies store bundles per session", async () => {
    const second = store.newId();
    store.checkpoint(second, [{ role: "user", content: "second" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: CREATED_AT,
    });
    const storeBundlePath = path.join(homeDir, "store.json");
    await runCli(["--bundle-store", "--bundle-file", storeBundlePath], env);

    const clean = await runCli(["--verify-bundle", storeBundlePath], env);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("Bundle kind: store; 2 session(s) checked.");
    expect(clean.stdout).toContain("Verdict: healthy.");

    // Damage one contained session.
    const bundle = JSON.parse(fs.readFileSync(storeBundlePath, "utf-8"));
    bundle.sessions[0].transcriptLines.push("{torn");
    fs.writeFileSync(storeBundlePath, JSON.stringify(bundle));
    const damaged = await runCli(["--verify-bundle", storeBundlePath], env);
    expect(damaged.code).toBe(1);
    expect(damaged.stdout).toContain("Verdict: damaged.");
  });

  it("emits the versioned json record", async () => {
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const res = await runCli(["--verify-bundle", bundlePath, "--output", "json"], env);
    expect(res.code).toBe(0);
    const record = JSON.parse(res.stdout);
    expect(record.schema).toBe("oh-my-cli.bundle-verify");
    expect(record.v).toBe(1);
    expect(record.kind).toBe("session");
    expect(record.sessionCount).toBe(1);
    expect(record.verdict).toBe("healthy");
    expect(record.sessions[0].sourceSessionId).toBe(sessionId);
    expect(record.sessions[0].tornTranscriptLines).toBe(0);
  });

  it("exits 2 on an unreadable file with empty stdout", async () => {
    const res = await runCli(["--verify-bundle", path.join(homeDir, "missing.json")], env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("cannot read bundle file");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on invalid JSON with empty stdout", async () => {
    fs.writeFileSync(bundlePath, "{ not json");
    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid JSON");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on an unknown schema with empty stdout", async () => {
    fs.writeFileSync(bundlePath, JSON.stringify({ schema: "oh-my-cli.other", v: 1 }));
    const res = await runCli(["--verify-bundle", bundlePath], env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown bundle schema");
    expect(res.stdout).toBe("");
  });

  it("never writes: bundle and store are byte-identical after verification", async () => {
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], env);
    const bundleBefore = fs.readFileSync(bundlePath, "utf-8");
    const storeBefore = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      storeBefore.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    await runCli(["--verify-bundle", bundlePath], env);
    await runCli(["--verify-bundle", bundlePath, "--output", "json"], env);
    expect(fs.readFileSync(bundlePath, "utf-8")).toBe(bundleBefore);
    const filesAfter = fs.readdirSync(sessionsDir());
    expect(filesAfter.sort()).toEqual([...storeBefore.keys()].sort());
    for (const [f, content] of storeBefore) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
