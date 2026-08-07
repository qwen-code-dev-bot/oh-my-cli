// Advisory session locks (Issue #741). Nothing previously stopped two
// processes from writing one session at once: appends interleave and the
// full-rewrite paths (undo/redo, resume-heal) can silently wipe a concurrent
// writer's messages. An advisory lock makes concurrent opens fail fast and
// honestly: the second opener learns the holder's pid and the remediation,
// and stale locks (dead holders) self-heal instead of blocking forever.
//
// The lock is advisory and single-machine: it contains only pid + timestamp
// (never store content), and a determined writer can ignore or remove it —
// manual removal of the lock file is the documented human override.

import fs from "node:fs";
import path from "node:path";

export interface SessionLockInfo {
  pid: number;
  lockedAt: number;
}

export type SessionLockAcquire =
  | { acquired: true }
  | { acquired: false; holder: SessionLockInfo };

export function sessionLockPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.lock`);
}

// Liveness probe: signal 0 checks existence without delivering. EPERM means
// the process exists but belongs to another user. PID reuse is a documented
// advisory limitation (a reused pid reads as alive); manual lock removal is
// the remediation.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readSessionLock(lockPath: string): SessionLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      lockedAt?: unknown;
    };
    if (typeof parsed.pid === "number" && typeof parsed.lockedAt === "number") {
      return { pid: parsed.pid, lockedAt: parsed.lockedAt };
    }
    return null;
  } catch {
    // Missing or unparseable — no verifiable holder.
    return null;
  }
}

export interface SessionLock {
  readonly filePath: string;
  readonly pid: number;
  acquire(): SessionLockAcquire;
  // Removes the lock only when it holds our own pid; a foreign lock is left
  // untouched.
  release(): void;
}

export function openSessionLock(lockPath: string, pid: number = process.pid): SessionLock {
  const writeLock = (): void => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid, lockedAt: Date.now() }), { flag: "wx" });
  };

  const acquire = (): SessionLockAcquire => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      writeLock();
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = readSessionLock(lockPath);
      if (info !== null && isPidAlive(info.pid)) {
        return { acquired: false, holder: info };
      }
      // Stale (dead holder) or unverifiable holder: take over, once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
      try {
        writeLock();
        return { acquired: true };
      } catch (retryErr) {
        // Lost the takeover race: whoever won now holds it.
        const retryInfo = readSessionLock(lockPath);
        if (retryInfo !== null && isPidAlive(retryInfo.pid)) {
          return { acquired: false, holder: retryInfo };
        }
        throw retryErr;
      }
    }
  };

  const release = (): void => {
    const info = readSessionLock(lockPath);
    if (info !== null && info.pid === pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  };

  return { filePath: lockPath, pid, acquire, release };
}
