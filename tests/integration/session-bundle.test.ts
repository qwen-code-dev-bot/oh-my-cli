import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";
import { appendCheckpoint, type TurnCheckpoint } from "../../src/turn-checkpoint.js";

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

describe("Integration: session bundles (--bundle-session / --restore-session, Issue #704)", () => {
  let homeA: string;
  let homeB: string;
  let wsDir: string;
  let envA: Record<string, string>;
  let envB: Record<string, string>;
  let storeA: SessionStore;
  let sessionId: string;
  let bundlePath: string;

  function sessionsA(): string {
    return path.join(homeA, ".oh-my-cli", "sessions");
  }

  function sessionsB(): string {
    return path.join(homeB, ".oh-my-cli", "sessions");
  }

  function checkpoint(turnIndex: number): TurnCheckpoint {
    return {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId,
      turnIndex,
      head: null,
      messageCountBefore: 0,
      messageCountAfter: 1,
      messages: [{ role: "user", content: "fixture" }],
      files: [],
      digest: "0".repeat(64),
    };
  }

  beforeAll(() => {
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-704i-homeA-"));
    homeB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-704i-homeB-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-704i-ws-"));
    envA = { HOME: homeA };
    envB = { HOME: homeB };
    bundlePath = path.join(homeA, "bundle.json");
  });

  afterAll(() => {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsA(), { recursive: true, force: true });
    fs.rmSync(sessionsB(), { recursive: true, force: true });
    fs.rmSync(bundlePath, { force: true });
    storeA = new SessionStore(sessionsA());
    sessionId = storeA.newId();
    storeA.checkpoint(
      sessionId,
      [{ role: "user", content: "bundle fodder" }],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
    appendSessionNote(storeA, sessionId, "a note", CREATED_AT + 1000);
    storeA.writePinned(sessionId, CREATED_AT + 2000);
    appendCheckpoint(storeA, sessionId, checkpoint(0));
  });

  it("round-trips a session byte-identically into a fresh store", async () => {
    const bundle = await runCli(
      ["--bundle-session", sessionId, "--bundle-file", bundlePath],
      envA,
    );
    expect(bundle.code).toBe(0);

    const restore = await runCli(["--restore-session", bundlePath], envB);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain("Restored session");

    const restoredFiles = fs.readdirSync(sessionsB());
    const restoredId = restoredFiles
      .find((f) => f.endsWith(".jsonl"))!
      .replace(/\.jsonl$/, "");
    expect(restoredId).not.toBe(sessionId);

    // Transcript and every sidecar byte-identical under the new id.
    expect(fs.readFileSync(path.join(sessionsB(), `${restoredId}.jsonl`), "utf-8")).toBe(
      fs.readFileSync(path.join(sessionsA(), `${sessionId}.jsonl`), "utf-8"),
    );
    for (const suffix of [".notes.json", ".pinned.json"]) {
      expect(fs.readFileSync(path.join(sessionsB(), `${restoredId}${suffix}`), "utf-8")).toBe(
        fs.readFileSync(path.join(sessionsA(), `${sessionId}${suffix}`), "utf-8"),
      );
    }
    // Turn log rewritten to the new session id.
    const turnRestored = JSON.parse(
      fs.readFileSync(path.join(sessionsB(), `${restoredId}.turn.json`), "utf-8"),
    );
    expect(turnRestored.checkpoints[0].sessionId).toBe(restoredId);
  });

  it("leaves the source store byte-identical through bundling", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsA())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsA(), f), "utf-8"));
    }
    const res = await runCli(["--bundle-session", sessionId], envA);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).sourceSessionId).toBe(sessionId);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsA(), f), "utf-8")).toBe(content);
    }
  });

  it("never touches existing sessions when restoring into a populated store", async () => {
    const existingId = storeA.newId();
    storeA.checkpoint(existingId, [{ role: "user", content: "resident" }], {
      model: "fake-model",
      workspace: wsDir,
      createdAt: CREATED_AT,
    });
    // Populate homeB with the resident session via a bundle of it.
    const residentBundle = path.join(homeA, "resident.json");
    await runCli(["--bundle-session", existingId, "--bundle-file", residentBundle], envA);
    await runCli(["--restore-session", residentBundle], envB);
    const before = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsB())) {
      before.set(f, fs.readFileSync(path.join(sessionsB(), f), "utf-8"));
    }

    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], envA);
    const restore = await runCli(["--restore-session", bundlePath], envB);
    expect(restore.code).toBe(0);

    for (const [f, content] of before) {
      expect(fs.readFileSync(path.join(sessionsB(), f), "utf-8")).toBe(content);
    }
  });

  it("restoring the same bundle twice yields two distinct sessions", async () => {
    await runCli(["--bundle-session", sessionId, "--bundle-file", bundlePath], envA);
    const first = await runCli(["--restore-session", bundlePath], envB);
    expect(first.code).toBe(0);
    const second = await runCli(["--restore-session", bundlePath], envB);
    expect(second.code).toBe(0);
    const transcripts = fs.readdirSync(sessionsB()).filter((f) => f.endsWith(".jsonl"));
    expect(transcripts).toHaveLength(2);
  });

  it("exits 2 for an unknown bundle target", async () => {
    const res = await runCli(["--bundle-session", "no-such-session"], envA);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('no session named "no-such-session" was found');
    expect(res.stdout).toBe("");
  });

  it("exits 2 on invalid JSON without writing anything", async () => {
    fs.mkdirSync(sessionsB(), { recursive: true });
    fs.writeFileSync(bundlePath, "{ not json");
    const res = await runCli(["--restore-session", bundlePath], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid JSON");
    expect(fs.readdirSync(sessionsB())).toEqual([]);
  });

  it("exits 2 on a wrong-schema bundle without writing anything", async () => {
    fs.mkdirSync(sessionsB(), { recursive: true });
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({ schema: "oh-my-cli.other", v: 1, transcriptLines: [], sidecars: {}, sourceSessionId: "x" }),
    );
    const res = await runCli(["--restore-session", bundlePath], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid session bundle");
    expect(fs.readdirSync(sessionsB())).toEqual([]);
  });

  it("exits 2 for a missing bundle file", async () => {
    const res = await runCli(["--restore-session", path.join(homeA, "missing.json")], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("cannot read bundle file");
  });
});
