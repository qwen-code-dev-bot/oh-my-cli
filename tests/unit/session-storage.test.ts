import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { notesPath } from "../../src/session-notes.js";
import { appendSessionNote } from "../../src/session-notes.js";
import {
  buildSessionStorageReport,
  formatSessionStorageReport,
} from "../../src/session-storage.js";

function size(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

describe("session storage report (Issue #664)", () => {
  let dir: string;
  let store: SessionStore;
  let bigId: string;
  let smallId: string;
  let archivedId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-664u-"));
    store = new SessionStore(dir);
    // Big session: transcript + goal + note + pinned.
    bigId = store.newId();
    store.checkpoint(
      bigId,
      [
        { role: "user", content: "a".repeat(500) },
        { role: "assistant", content: "b".repeat(500) },
      ],
      { model: "m", workspace: "/srv/ws", createdAt: 1_700_000_000_000 },
    );
    store.writeGoal(bigId, {
      revision: 1,
      goal: { objective: "storage", status: "active", createdAt: 1, updatedAt: 1 },
      history: [{ revision: 1, kind: "set", objective: "storage", status: "active", at: 1 }],
    });
    expect(appendSessionNote(store, bigId, "storage note", 2).ok).toBe(true);
    store.writePinned(bigId, 3);
    // Small session: transcript only.
    smallId = store.newId();
    store.checkpoint(smallId, [{ role: "user", content: "tiny" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1_700_000_100_000,
    });
    // Archived session: transcript + archived marker.
    archivedId = store.newId();
    store.checkpoint(archivedId, [{ role: "user", content: "archived body" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1_700_000_200_000,
    });
    store.writeArchived(archivedId, 4);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("computes exact transcript and sidecar bytes from the files on disk", () => {
    const report = buildSessionStorageReport(store);
    const big = report.sessions.find((s) => s.sessionId === bigId);
    expect(big).toBeDefined();
    expect(big!.transcriptBytes).toBe(size(store.filePath(bigId)));
    const expectedSidecars =
      size(store.namePath(bigId)) +
      size(store.goalPath(bigId)) +
      size(notesPath(store, bigId)) +
      size(store.pinnedPath(bigId)) +
      size(store.archivedPath(bigId));
    expect(big!.sidecarBytes).toBe(expectedSidecars);
    expect(big!.bytes).toBe(big!.transcriptBytes + big!.sidecarBytes);
    expect(big!.archived).toBe(false);

    const archived = report.sessions.find((s) => s.sessionId === archivedId);
    expect(archived!.archived).toBe(true);
    expect(archived!.sidecarBytes).toBe(size(store.archivedPath(archivedId)));
  });

  it("ranks largest first with sessionId tie-break and exact rollups", () => {
    const report = buildSessionStorageReport(store);
    expect(report.sessionCount).toBe(3);
    expect(report.sessions[0].sessionId).toBe(bigId);
    expect(report.largestSessionId).toBe(bigId);
    expect(report.totalBytes).toBe(report.sessions.reduce((a, s) => a + s.bytes, 0));
    const bytes = report.sessions.map((s) => s.bytes);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
  });

  it("breaks exact-size ties by full sessionId ascending", () => {
    // Two sessions with byte-identical transcripts and no sidecars.
    const a = store.newId();
    const b = store.newId();
    const body = [{ role: "user" as const, content: "same-size" }];
    store.checkpoint(a, body, { model: "m", workspace: "/srv/ws", createdAt: 1 });
    store.checkpoint(b, body, { model: "m", workspace: "/srv/ws", createdAt: 1 });
    const tied = buildSessionStorageReport(store)
      .sessions.filter((s) => s.sessionId === a || s.sessionId === b);
    expect(tied[0].bytes).toBe(tied[1].bytes);
    expect(tied.map((s) => s.sessionId)).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
  });

  it("counts missing sidecars as 0 bytes and undiscoverable transcripts as absent", () => {
    // The small session has no sidecars at all: 0 sidecar bytes honestly.
    const report = buildSessionStorageReport(store);
    const small = report.sessions.find((s) => s.sessionId === smallId);
    expect(small!.sidecarBytes).toBe(0);
    expect(small!.bytes).toBe(small!.transcriptBytes);

    // A session whose transcript has vanished is not discoverable (sessions
    // are discovered by their transcript file) — the report honestly omits
    // it rather than fabricating a zero-sized entry, and does not crash.
    const ghost = store.newId();
    store.checkpoint(ghost, [{ role: "user", content: "ghost" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    fs.unlinkSync(store.filePath(ghost));
    const after = buildSessionStorageReport(store);
    expect(after.sessions.find((s) => s.sessionId === ghost)).toBeUndefined();
    expect(after.sessionCount).toBe(3);
  });

  it("reports an empty store honestly", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-664u-empty-"));
    try {
      const emptyStore = new SessionStore(emptyDir);
      const report = buildSessionStorageReport(emptyStore);
      expect(report.sessionCount).toBe(0);
      expect(report.totalBytes).toBe(0);
      expect(report.largestSessionId).toBeNull();
      expect(report.sessions).toEqual([]);
      const text = formatSessionStorageReport(report).join("\n");
      expect(text).toContain("0 session(s), 0B total.");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("renders the ranked text report with totals and the largest session", () => {
    const report = buildSessionStorageReport(store);
    const lines = formatSessionStorageReport(report);
    expect(lines[0]).toBe("Session storage report");
    expect(lines.some((l) => l.startsWith("3 session(s), "))).toBe(true);
    expect(lines.some((l) => l.startsWith("Largest: "))).toBe(true);
    const archivedLine = lines.find((l) => l.includes("(archived)"));
    expect(archivedLine).toBeDefined();
    expect(archivedLine).toContain(report.sessions.find((s) => s.archived)!.shortId);
  });

  it("keeps the store byte-identical through report reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionStorageReport(store);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
