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

describe("Integration: store bundles (--bundle-store / --restore-store, Issue #706)", () => {
  let homeA: string;
  let homeB: string;
  let wsDir: string;
  let envA: Record<string, string>;
  let envB: Record<string, string>;
  let storeA: SessionStore;
  let bundlePath: string;
  let seededIds: string[];

  function sessionsA(): string {
    return path.join(homeA, ".oh-my-cli", "sessions");
  }

  function sessionsB(): string {
    return path.join(homeB, ".oh-my-cli", "sessions");
  }

  function checkpoint(id: string, turnIndex: number): TurnCheckpoint {
    return {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId: id,
      turnIndex,
      head: null,
      messageCountBefore: 0,
      messageCountAfter: 1,
      messages: [{ role: "user", content: "fixture" }],
      files: [],
      digest: "0".repeat(64),
    };
  }

  function seedSession(content: string, withExtras: boolean): string {
    const id = storeA.newId();
    storeA.checkpoint(
      id,
      [{ role: "user", content }],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
    if (withExtras) {
      appendSessionNote(storeA, id, "a note", CREATED_AT + 1000);
      storeA.writePinned(id, CREATED_AT + 2000);
      appendCheckpoint(storeA, id, checkpoint(id, 0));
    }
    return id;
  }

  beforeAll(() => {
    homeA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-706i-homeA-"));
    homeB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-706i-homeB-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-706i-ws-"));
    envA = { HOME: homeA };
    envB = { HOME: homeB };
    bundlePath = path.join(homeA, "store-bundle.json");
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
    seededIds = [
      seedSession("first", true),
      seedSession("second", false),
      seedSession("third", true),
    ];
  });

  it("round-trips a multi-session store byte-identically into an empty store", async () => {
    const bundle = await runCli(["--bundle-store", "--bundle-file", bundlePath], envA);
    expect(bundle.code).toBe(0);
    expect(bundle.stdout).toContain("Bundled store (3 session(s))");

    const restore = await runCli(["--restore-store", bundlePath], envB);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain("Restored 3 session(s) from store bundle");

    const restoredIds = fs
      .readdirSync(sessionsB())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
    expect(restoredIds).toHaveLength(3);
    for (const rid of restoredIds) {
      expect(seededIds).not.toContain(rid);
    }

    // Byte-identity per session, matched by transcript content.
    const sortedSeeded = [...seededIds].sort((a, b) =>
      fs.readFileSync(path.join(sessionsA(), `${a}.jsonl`), "utf-8").localeCompare(
        fs.readFileSync(path.join(sessionsA(), `${b}.jsonl`), "utf-8"),
      ),
    );
    const sortedRestored = [...restoredIds].sort((a, b) =>
      fs.readFileSync(path.join(sessionsB(), `${a}.jsonl`), "utf-8").localeCompare(
        fs.readFileSync(path.join(sessionsB(), `${b}.jsonl`), "utf-8"),
      ),
    );
    for (let i = 0; i < sortedSeeded.length; i++) {
      const src = sortedSeeded[i];
      const dst = sortedRestored[i];
      expect(fs.readFileSync(path.join(sessionsB(), `${dst}.jsonl`), "utf-8")).toBe(
        fs.readFileSync(path.join(sessionsA(), `${src}.jsonl`), "utf-8"),
      );
      for (const suffix of [".notes.json", ".pinned.json"]) {
        const srcHas = fs.existsSync(path.join(sessionsA(), `${src}${suffix}`));
        const dstHas = fs.existsSync(path.join(sessionsB(), `${dst}${suffix}`));
        expect(dstHas).toBe(srcHas);
        if (srcHas) {
          expect(fs.readFileSync(path.join(sessionsB(), `${dst}${suffix}`), "utf-8")).toBe(
            fs.readFileSync(path.join(sessionsA(), `${src}${suffix}`), "utf-8"),
          );
        }
      }
      const srcTurn = path.join(sessionsA(), `${src}.turn.json`);
      const dstTurn = path.join(sessionsB(), `${dst}.turn.json`);
      expect(fs.existsSync(dstTurn)).toBe(fs.existsSync(srcTurn));
      if (fs.existsSync(srcTurn)) {
        const turn = JSON.parse(fs.readFileSync(dstTurn, "utf-8"));
        expect(turn.checkpoints[0].sessionId).toBe(dst);
      }
    }
  });

  it("bundles an empty store as an honest zero state", async () => {
    fs.rmSync(sessionsA(), { recursive: true, force: true });
    const res = await runCli(["--bundle-store"], envA);
    expect(res.code).toBe(0);
    const record = JSON.parse(res.stdout);
    expect(record.schema).toBe("oh-my-cli.store-bundle");
    expect(record.v).toBe(1);
    expect(record.sessionCount).toBe(0);
    expect(record.sessions).toEqual([]);
  });

  it("leaves the source store byte-identical through bundling", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsA())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsA(), f), "utf-8"));
    }
    const res = await runCli(["--bundle-store", "--bundle-file", bundlePath], envA);
    expect(res.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsA(), f), "utf-8")).toBe(content);
    }
  });

  it("never touches existing sessions when restoring into a populated store", async () => {
    await runCli(["--bundle-store", "--bundle-file", bundlePath], envA);

    // Restore once to populate homeB (a populated target store).
    await runCli(["--restore-store", bundlePath], envB);
    const before = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsB())) {
      before.set(f, fs.readFileSync(path.join(sessionsB(), f), "utf-8"));
    }

    // Restore again: 3 more sessions; every pre-existing file untouched.
    const second = await runCli(["--restore-store", bundlePath], envB);
    expect(second.code).toBe(0);
    for (const [f, content] of before) {
      expect(fs.readFileSync(path.join(sessionsB(), f), "utf-8")).toBe(content);
    }
    expect(
      fs.readdirSync(sessionsB()).filter((f) => f.endsWith(".jsonl")),
    ).toHaveLength(6);
  });

  it("exits 2 on invalid JSON without writing anything", async () => {
    fs.mkdirSync(sessionsB(), { recursive: true });
    fs.writeFileSync(bundlePath, "{ not json");
    const res = await runCli(["--restore-store", bundlePath], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid JSON");
    expect(fs.readdirSync(sessionsB())).toEqual([]);
  });

  it("exits 2 on a wrong-schema bundle without writing anything", async () => {
    fs.mkdirSync(sessionsB(), { recursive: true });
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({ schema: "oh-my-cli.other", v: 1, sessionCount: 0, sessions: [] }),
    );
    const res = await runCli(["--restore-store", bundlePath], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid store bundle");
    expect(fs.readdirSync(sessionsB())).toEqual([]);
  });

  it("exits 2 on a bundle with a malformed contained session entry", async () => {
    fs.mkdirSync(sessionsB(), { recursive: true });
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({
        schema: "oh-my-cli.store-bundle",
        v: 1,
        sessionCount: 1,
        sessions: [{ schema: "oh-my-cli.session-bundle", v: 99, transcriptLines: [], sidecars: {}, sourceSessionId: "x" }],
      }),
    );
    const res = await runCli(["--restore-store", bundlePath], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid store bundle");
    expect(fs.readdirSync(sessionsB())).toEqual([]);
  });

  it("exits 2 for a missing bundle file", async () => {
    const res = await runCli(["--restore-store", path.join(homeA, "missing.json")], envB);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("cannot read store bundle");
  });
});
