import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bucketEntriesByDay,
  buildSessionJournal,
  buildSessionJournalByDay,
  formatSessionJournalByDay,
} from "../../src/session-journal.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalByDay } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z
const CREATED_DAY = "2023-12-03";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("bucketEntriesByDay (Issue #646)", () => {
  it("buckets by UTC day, chronological, present days only", () => {
    const entries = [
      { at: Date.UTC(2023, 11, 4, 5) },
      { at: Date.UTC(2023, 11, 3, 23) },
      { at: Date.UTC(2023, 11, 4, 6) },
    ];
    expect(bucketEntriesByDay(entries)).toEqual([
      { day: "2023-12-03", count: 1 },
      { day: "2023-12-04", count: 2 },
    ]);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketEntriesByDay([])).toEqual([]);
  });
});

describe("journal by-day (Issue #646)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-646u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "by-day fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: CREATED_AT,
    });
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: CREATED_AT + 100, updatedAt: CREATED_AT + 100 },
      history: [
        { revision: 1, kind: "set", objective: "mission", status: "active", at: CREATED_AT + 100 },
      ],
    });
    for (let i = 0; i < 5; i++) {
      expect(appendSessionNote(store, id, `note ${i}`, CREATED_AT + 200 + i * 10).ok).toBe(true);
    }
    store.writePinned(id, CREATED_AT + 900);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Fixture: created, goal, 5 notes, pinned (all 2023-12-03), then
  // last-activity (live transcript mtime = today) — 9 entries, 2 days.

  function fullJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  function byDayJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const grouped = buildSessionJournalByDay(store, id, opts);
    if ("error" in grouped) throw new Error(grouped.error);
    return grouped.byDay;
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
      { kinds: new Set(["note", "goal"]) },
      { window: { since: CREATED_AT + 150 } },
      { skip: 2 },
      { skip: 2, limit: 3 },
      { kinds: new Set(["note"]), skip: 1, limit: 2 },
      { window: { since: CREATED_AT + 150 }, kinds: new Set(["note"]), skip: 1, limit: 2 },
    ];
    for (const combo of combos) {
      const full = fullJournal(combo);
      const grouped = byDayJournal(combo);
      expect(grouped.count).toBe(full.entries.length);
      expect(grouped.elided).toBe(full.elided);
      expect(grouped.skipped).toBe(full.skipped);
      expect(grouped.byDay).toEqual(bucketEntriesByDay(full.entries));
      const bucketSum = grouped.byDay.reduce((a, b) => a + b.count, 0);
      expect(bucketSum).toBe(grouped.count);
      expect(grouped.sessionId).toBe(full.sessionId);
      expect(grouped.integrity).toBe(full.integrity);
    }
  });

  it("renders the chronological day breakdown with the exact shape", () => {
    const grouped = byDayJournal();
    expect(grouped.schema).toBe("oh-my-cli.session-journal-by-day");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(9);
    expect(grouped.byDay).toEqual([
      { day: CREATED_DAY, count: 8 },
      { day: todayUtc(), count: 1 },
    ]);
    const lines = formatSessionJournalByDay(grouped);
    expect(lines[0]).toBe("9 event(s) across 2 day(s).");
    expect(lines[1]).toBe(`  ${CREATED_DAY} ×8`);
    expect(lines[2]).toBe(`  ${todayUtc()} ×1`);
  });

  it("carries day buckets only — never entry contents", () => {
    const grouped = byDayJournal();
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("mission");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = byDayJournal({ kinds: new Set(["archived"]) });
    expect(grouped.count).toBe(0);
    expect(grouped.byDay).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatSessionJournalByDay(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the truthful skipped note on an over-skip zero grouping", () => {
    const grouped = byDayJournal({ skip: 100 });
    expect(grouped.count).toBe(0);
    expect(grouped.skipped).toBe(9);
    const text = formatSessionJournalByDay(grouped).join("\n");
    expect(text).toBe("0 event(s). (+9 newer event(s) skipped)");
  });

  it("returns the same error as the full render for a missing session", () => {
    const grouped = buildSessionJournalByDay(store, "no-such-session");
    expect("error" in grouped).toBe(true);
  });

  it("matches the workspace full render's buckets and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    const grouped = buildWorkspaceJournalByDay(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-day");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(full.entries.length);
    expect(grouped.elided).toBe(full.elided);
    expect(grouped.skipped).toBe(full.skipped);
    expect(grouped.byDay).toEqual(bucketEntriesByDay(full.entries));
    expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
    expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(grouped.workspace).toBe(full.workspace);
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
  });

  it("keeps the store byte-identical through by-day reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalByDay(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalByDay(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
