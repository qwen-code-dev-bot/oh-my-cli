import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bucketEntriesByWeek,
  buildSessionJournal,
  buildSessionJournalByWeek,
  formatSessionJournalByWeek,
  isoWeekKey,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalByWeek } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";

const WEEK30_AT = Date.UTC(2026, 6, 20, 10, 0); // 2026-07-20T10:00Z (Mon, 2026-W30)
const WEEK32_AT = Date.UTC(2026, 7, 3, 9, 0); // 2026-08-03T09:00Z (Mon, 2026-W32)

describe("isoWeekKey (Issue #658)", () => {
  it("keys mid-year dates with the calendar year", () => {
    expect(isoWeekKey(WEEK30_AT)).toBe("2026-W30");
    expect(isoWeekKey(WEEK32_AT)).toBe("2026-W32");
    expect(isoWeekKey(Date.UTC(2026, 0, 1, 12))).toBe("2026-W01"); // Thu
  });

  it("handles year boundaries per ISO-8601 (week-year, not calendar year)", () => {
    // 2026-01-01 is a Thursday; its week (Mon 2025-12-29 … Sun 2026-01-04)
    // is week 1 of 2026.
    expect(isoWeekKey(Date.UTC(2025, 11, 29, 12))).toBe("2026-W01"); // Mon
    // The day before that week still belongs to 2025 (week 52).
    expect(isoWeekKey(Date.UTC(2025, 11, 28, 12))).toBe("2025-W52"); // Sun
    // 2023-12-31 (Sunday) sits in 2023-W52.
    expect(isoWeekKey(Date.UTC(2023, 11, 31, 12))).toBe("2023-W52");
    // 2021-01-01 (Friday) belongs to the last ISO week of 2020 (W53).
    expect(isoWeekKey(Date.UTC(2021, 0, 1, 12))).toBe("2020-W53");
    expect(isoWeekKey(Date.UTC(2020, 11, 31, 12))).toBe("2020-W53"); // Thu
  });

  it("is stable across every day of a single week", () => {
    // Mon 2026-07-20 … Sun 2026-07-26 are all 2026-W30.
    for (let i = 0; i < 7; i++) {
      expect(isoWeekKey(Date.UTC(2026, 6, 20 + i, 15))).toBe("2026-W30");
    }
  });
});

describe("bucketEntriesByWeek (Issue #658)", () => {
  it("buckets by ISO week, chronological, present weeks only", () => {
    const entries = [
      { at: WEEK32_AT },
      { at: WEEK30_AT },
      { at: WEEK30_AT + 3_600_000 },
    ];
    expect(bucketEntriesByWeek(entries)).toEqual([
      { week: "2026-W30", count: 2 },
      { week: "2026-W32", count: 1 },
    ]);
  });

  it("orders week-year keys chronologically across year boundaries", () => {
    const entries = [
      { at: Date.UTC(2026, 0, 2, 12) }, // 2026-W01 (Fri)
      { at: Date.UTC(2025, 11, 30, 12) }, // 2026-W01 (Tue)
      { at: Date.UTC(2025, 11, 28, 12) }, // 2025-W52 (Sun)
    ];
    expect(bucketEntriesByWeek(entries).map((b) => b.week)).toEqual([
      "2025-W52",
      "2026-W01",
    ]);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketEntriesByWeek([])).toEqual([]);
  });
});

describe("journal by-week (Issue #658)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-658u-"));
    store = new SessionStore(dir);
    id = store.newId();
    // Created + 2 notes in 2026-W30; pinned in 2026-W32.
    store.checkpoint(id, [{ role: "user", content: "by-week fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: WEEK30_AT,
    });
    expect(appendSessionNote(store, id, "note 0", WEEK30_AT + 3_600_000).ok).toBe(true);
    expect(appendSessionNote(store, id, "note 1", WEEK30_AT + 7_200_000).ok).toBe(true);
    store.writePinned(id, WEEK32_AT);
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
    return buildSessionJournal(store, id, opts);
  }

  function byWeekJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const grouped = buildSessionJournalByWeek(store, id, opts);
    if ("error" in grouped) throw new Error(grouped.error);
    return grouped.byWeek;
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
      { kinds: new Set(["note", "created", "pinned"]) },
      { window: { since: WEEK32_AT } },
      { skip: 1 },
      { skip: 1, limit: 2 },
      { kinds: new Set(["note"]), skip: 1, limit: 1 },
    ];
    for (const combo of combos) {
      const built = fullJournal(combo);
      if ("error" in built) throw new Error(built.error);
      const grouped = byWeekJournal(combo);
      expect(grouped.byWeek).toEqual(bucketEntriesByWeek(built.journal.entries));
      expect(grouped.count).toBe(built.journal.entries.length);
      expect(grouped.elided).toBe(built.journal.elided);
      expect(grouped.skipped).toBe(built.journal.skipped);
      const bucketSum = grouped.byWeek.reduce((a, b) => a + b.count, 0);
      expect(bucketSum).toBe(grouped.count);
      expect(grouped.sessionId).toBe(built.journal.sessionId);
      expect(grouped.integrity).toBe(built.journal.integrity);
    }
  });

  it("renders the week breakdown with the exact shape", () => {
    const grouped = byWeekJournal({ kinds: new Set(["created", "note", "pinned"]) });
    expect(grouped.schema).toBe("oh-my-cli.session-journal-by-week");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(4);
    expect(grouped.byWeek).toEqual([
      { week: "2026-W30", count: 3 },
      { week: "2026-W32", count: 1 },
    ]);
    const lines = formatSessionJournalByWeek(grouped);
    expect(lines[0]).toBe("4 event(s) across 2 week(s).");
    expect(lines[1]).toBe("  2026-W30 ×3");
    expect(lines[2]).toBe("  2026-W32 ×1");
  });

  it("carries week buckets only — never entry contents", () => {
    const grouped = byWeekJournal();
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("fodder");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = byWeekJournal({ kinds: new Set(["archived"]) });
    expect(grouped.count).toBe(0);
    expect(grouped.byWeek).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatSessionJournalByWeek(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the store byte-identical through by-week reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalByWeek(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalByWeek(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("matches the workspace full render's buckets and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    const grouped = buildWorkspaceJournalByWeek(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-week");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(full.entries.length);
    expect(grouped.elided).toBe(full.elided);
    expect(grouped.skipped).toBe(full.skipped);
    expect(grouped.byWeek).toEqual(bucketEntriesByWeek(full.entries));
    expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
    expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(grouped.workspace).toBe(full.workspace);
  });
});
