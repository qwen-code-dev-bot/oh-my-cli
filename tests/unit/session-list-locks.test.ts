import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/session.js";
import {
  collectSessionSummaries,
  formatSessionList,
  sessionListRecord,
} from "../../src/session-summary.js";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Write a lock sidecar the way a holder process would leave it (advisory
// JSON; a stale lock is exactly this file left behind by a dead process).
function writeLock(store: SessionStore, id: string, pid: number): void {
  const lockPath = store.lockPath(id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid, lockedAt: Date.now() }, null, 2));
}

function snapshotDir(dir: string): string {
  const entries: string[] = [];
  if (!fs.existsSync(dir)) return "absent";
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    entries.push(`${name}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
  }
  return entries.join("\n");
}

describe("session listing lock state (Issue #793)", () => {
  let tmpDir: string;
  let store: SessionStore;
  let sleeper: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-listlock-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    if (sleeper && !sleeper.killed) sleeper.kill("SIGKILL");
    sleeper = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const seedSession = (): string => {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/srv/proj", createdAt: 1000 });
    store.append(id, { role: "user", content: "hello" });
    return id;
  };

  it("reports unlocked sessions with locked:false and no lock fields", () => {
    const id = seedSession();
    const summaries = collectSessionSummaries(store, [id]);
    expect(summaries[0].locked).toBe(false);
    expect(summaries[0].lockPid).toBeUndefined();
    expect(summaries[0].lockStale).toBeUndefined();
  });

  it("reports a live holder: locked, holder pid, not stale", () => {
    const id = seedSession();
    sleeper = spawn("sleep", ["30"]);
    writeLock(store, id, sleeper.pid as number);

    const summaries = collectSessionSummaries(store, [id]);
    expect(summaries[0].locked).toBe(true);
    expect(summaries[0].lockPid).toBe(sleeper.pid);
    expect(summaries[0].lockStale).toBe(false);
  });

  it("reports a dead holder: locked and stale", () => {
    const id = seedSession();
    const deadPid = spawnSync("true").pid as number;
    writeLock(store, id, deadPid);

    const summaries = collectSessionSummaries(store, [id]);
    expect(summaries[0].locked).toBe(true);
    expect(summaries[0].lockPid).toBe(deadPid);
    expect(summaries[0].lockStale).toBe(true);
  });

  it("is strictly read-only: listing never creates, removes, or heals lock sidecars", () => {
    const id = seedSession();
    const deadPid = spawnSync("true").pid as number;
    writeLock(store, id, deadPid);

    const sessionsDir = path.dirname(store.lockPath(id));
    const before = snapshotDir(sessionsDir);
    collectSessionSummaries(store, [id]);
    const after = snapshotDir(sessionsDir);
    // The stale sidecar must survive untouched — healing stays on open (#741).
    expect(after).toBe(before);
    expect(fs.existsSync(store.lockPath(id))).toBe(true);
  });

  it("renders the text marker for live and stale holders, none when unlocked", () => {
    const unlockedId = seedSession();
    const liveId = seedSession();
    const staleId = seedSession();
    sleeper = spawn("sleep", ["30"]);
    writeLock(store, liveId, sleeper.pid as number);
    const deadPid = spawnSync("true").pid as number;
    writeLock(store, staleId, deadPid);

    const summaries = collectSessionSummaries(store, [unlockedId, liveId, staleId]);
    const text = formatSessionList(summaries, undefined, false);
    expect(text).toContain(`(locked by pid ${sleeper.pid})`);
    expect(text).toContain(`(locked by pid ${deadPid} — stale)`);
    // The unlocked session's line carries no lock marker.
    const unlockedLine = text.split("\n").find((l) => l.includes(unlockedId));
    expect(unlockedLine).toBeDefined();
    expect(unlockedLine).not.toContain("locked");
  });

  it("carries lock fields in the versioned JSON record", () => {
    const unlockedId = seedSession();
    const liveId = seedSession();
    sleeper = spawn("sleep", ["30"]);
    writeLock(store, liveId, sleeper.pid as number);

    const record = sessionListRecord(
      collectSessionSummaries(store, [unlockedId, liveId]),
      undefined,
      false,
    );
    const byId = new Map(record.sessions.map((s) => [s.id, s]));
    expect(byId.get(unlockedId)?.locked).toBe(false);
    expect(byId.get(unlockedId)?.lockPid).toBeUndefined();
    expect(byId.get(liveId)?.locked).toBe(true);
    expect(byId.get(liveId)?.lockPid).toBe(sleeper.pid);
    expect(byId.get(liveId)?.lockStale).toBe(false);
  });
});
