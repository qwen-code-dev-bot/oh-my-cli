import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";
import {
  bucketWorkspaceEntriesBySession,
  buildWorkspaceJournal,
  buildWorkspaceJournalBySession,
  formatWorkspaceJournalBySession,
} from "../../src/workspace-journal.js";
import type { WorkspaceJournalEntry } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

function wsEntry(sessionId: string, count: number): WorkspaceJournalEntry {
  return {
    at: CREATED_AT + count,
    kind: "note",
    detail: `detail ${count}`,
    sessionId,
    shortId: sessionId.slice(0, 8),
  };
}

describe("bucketWorkspaceEntriesBySession (Issue #648)", () => {
  it("orders buckets count descending, ties by full sessionId ascending", () => {
    const entries = [
      wsEntry("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb", 1),
      wsEntry("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa", 2),
      wsEntry("cccccccc-cccc-cccc-cccc-cccccccc", 3),
      wsEntry("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa", 4),
    ];
    const tied = bucketWorkspaceEntriesBySession([
      wsEntry("cccccccc-cccc-cccc-cccc-cccccccc", 10),
      wsEntry("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa", 10),
    ]);
    expect(tied.map((b) => b.sessionId)).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa",
      "cccccccc-cccc-cccc-cccc-cccccccc",
    ]);

    // a… has 2 entries; b… and c… have 1 each — the tie breaks by
    // sessionId ascending.
    const buckets = bucketWorkspaceEntriesBySession(entries);
    expect(buckets.map((b) => b.sessionId)).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccc",
    ]);
    expect(buckets.map((b) => b.count)).toEqual([2, 1, 1]);
    expect(buckets[0].shortId).toBe("aaaaaaaa");
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketWorkspaceEntriesBySession([])).toEqual([]);
  });
});

describe("workspace journal by-session (Issue #648)", () => {
  let dir: string;
  let store: SessionStore;
  let idA: string;
  let idB: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-648u-"));
    store = new SessionStore(dir);
    // Session A: created, 3 notes, live last-activity = 5 kept entries.
    idA = store.newId();
    store.checkpoint(idA, [{ role: "user", content: "by-session fodder A" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: CREATED_AT,
    });
    for (let i = 0; i < 3; i++) {
      expect(appendSessionNote(store, idA, `note A${i}`, CREATED_AT + 100 + i * 10).ok).toBe(true);
    }
    // Session B: created, 1 note, live last-activity = 3 kept entries.
    idB = store.newId();
    store.checkpoint(idB, [{ role: "user", content: "by-session fodder B" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: CREATED_AT + 50,
    });
    expect(appendSessionNote(store, idB, "note B0", CREATED_AT + 200).ok).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fullJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    return buildWorkspaceJournal(store, { workspace: "/srv/ws", ...opts });
  }

  function bySessionJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    return buildWorkspaceJournalBySession(store, { workspace: "/srv/ws", ...opts });
  }

  it("matches the full render's kept-set buckets across compositions", () => {
    const combos: Array<{
      kinds?: ReadonlySet<SessionJournalKind>;
      window?: JournalTimeWindow;
      skip?: number;
      limit?: number;
    }> = [
      {},
      { kinds: new Set(["note"]) },
      { kinds: new Set(["note", "created"]) },
      { window: { since: CREATED_AT + 75 } },
      { skip: 2 },
      { skip: 2, limit: 3 },
      { kinds: new Set(["note"]), skip: 1, limit: 2 },
    ];
    for (const combo of combos) {
      const full = fullJournal(combo);
      const grouped = bySessionJournal(combo);
      expect(grouped.count).toBe(full.entries.length);
      expect(grouped.elided).toBe(full.elided);
      expect(grouped.skipped).toBe(full.skipped);
      expect(grouped.bySession).toEqual(bucketWorkspaceEntriesBySession(full.entries));
      const bucketSum = grouped.bySession.reduce((a, b) => a + b.count, 0);
      expect(bucketSum).toBe(grouped.count);
      expect(grouped.workspace).toBe(full.workspace);
      expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
      expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    }
  });

  it("renders the session breakdown count-desc with the exact shape", () => {
    const grouped = bySessionJournal();
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-session");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(8);
    expect(grouped.sessionsScanned).toBe(2);
    expect(grouped.bySession.map((b) => b.count)).toEqual([5, 3]);
    expect(grouped.bySession.map((b) => b.sessionId)).toEqual([idA, idB]);
    const lines = formatWorkspaceJournalBySession(grouped);
    expect(lines[0]).toBe("8 event(s) across 2 session(s).");
    expect(lines[1]).toBe(`  ${idA.slice(0, 8)} ×5`);
    expect(lines[2]).toBe(`  ${idB.slice(0, 8)} ×3`);
  });

  it("carries session buckets only — never entry contents", () => {
    const grouped = bySessionJournal();
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note A0");
    expect(json).not.toContain("fodder");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = bySessionJournal({ kinds: new Set(["archived"]) });
    expect(grouped.count).toBe(0);
    expect(grouped.bySession).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatWorkspaceJournalBySession(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the truthful skipped note on an over-skip zero grouping", () => {
    const grouped = bySessionJournal({ skip: 100 });
    expect(grouped.count).toBe(0);
    expect(grouped.skipped).toBe(8);
    const text = formatWorkspaceJournalBySession(grouped).join("\n");
    expect(text).toBe("0 event(s). (+8 newer event(s) skipped)");
  });

  it("keeps the store byte-identical through by-session reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildWorkspaceJournalBySession(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
