import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  openSessionLock,
  sessionLockPath,
  readSessionLock,
  isPidAlive,
} from "../../src/session-lock.js";

describe("session lock (Issue #741)", () => {
  const tmpDirs: string[] = [];
  const makeDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-741-"));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("computes a sibling lock path per session", () => {
    expect(sessionLockPath("/x/sessions", "abc")).toBe(path.join("/x/sessions", "abc.lock"));
  });

  it("acquires exclusively and records pid + timestamp", () => {
    const dir = makeDir();
    const lock = openSessionLock(sessionLockPath(dir, "s1"));
    expect(lock.acquire()).toEqual({ acquired: true });
    const info = readSessionLock(lock.filePath);
    expect(info?.pid).toBe(process.pid);
    expect(typeof info?.lockedAt).toBe("number");
    lock.release();
  });

  it("reports a live holder instead of acquiring", () => {
    const dir = makeDir();
    const lockPath = sessionLockPath(dir, "s1");
    const holder = openSessionLock(lockPath, process.pid);
    expect(holder.acquire()).toEqual({ acquired: true });
    // A second opener is denied while the recorded holder is alive; the
    // second handle's own pid is irrelevant to the decision.
    const secondResult = openSessionLock(lockPath, process.pid + 1).acquire();
    expect(secondResult.acquired).toBe(false);
    if (!secondResult.acquired) {
      expect(secondResult.holder.pid).toBe(process.pid);
    }
    holder.release();
  });

  it("takes over a stale lock whose recorded pid is dead", () => {
    const dir = makeDir();
    const lockPath = sessionLockPath(dir, "s1");
    // A pid that cannot exist (larger than any real pid_max).
    const deadPid = 4_194_300;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, lockedAt: Date.now() - 9999 }));
    expect(isPidAlive(deadPid)).toBe(false);
    const lock = openSessionLock(lockPath);
    expect(lock.acquire()).toEqual({ acquired: true });
    expect(readSessionLock(lockPath)?.pid).toBe(process.pid);
    lock.release();
  });

  it("takes over an unparseable lock (no verifiable holder)", () => {
    const dir = makeDir();
    const lockPath = sessionLockPath(dir, "s1");
    fs.writeFileSync(lockPath, "{ corrupt lock");
    const lock = openSessionLock(lockPath);
    expect(lock.acquire()).toEqual({ acquired: true });
    expect(readSessionLock(lockPath)?.pid).toBe(process.pid);
    lock.release();
  });

  it("release removes only our own lock", () => {
    const dir = makeDir();
    const lockPath = sessionLockPath(dir, "s1");
    const ours = openSessionLock(lockPath);
    expect(ours.acquire()).toEqual({ acquired: true });
    // A foreign lock handle (different pid) must not remove our lock.
    const foreign = openSessionLock(lockPath, process.pid + 1);
    foreign.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    ours.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("release on a missing lock is a no-op", () => {
    const dir = makeDir();
    const lock = openSessionLock(sessionLockPath(dir, "s1"));
    expect(() => lock.release()).not.toThrow();
  });

  it("isPidAlive rejects non-positive and non-integer pids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});
