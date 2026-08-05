import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bucketEntriesByMonth,
  buildSessionJournal,
  buildSessionJournalByMonth,
  formatSessionJournalByMonth,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalByMonth } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";

const MARCH_AT = Date.UTC(2026, 2, 15, 10, 0); // 2026-03-15T10:00Z
const JULY_AT = Date.UTC(2026, 6, 20, 9, 0); // 2026-07-20T09:00Z

describe("bucketEntriesByMonth (Issue #660)", () => {
  it("buckets by calendar month, chronological, present months only", () => {
    const entries = [
      { at: JULY_AT },
      { at: MARCH_AT },
      { at: MARCH_AT + 3_600_000 },
    ];
    expect(bucketEntriesByMonth(entries)).toEqual([
      { month: "2026-03", count: 2 },
      { month: "2026-07", count: 1 },
    ]);
  });

  it("orders month keys chronologically across year boundaries", () => {
    const entries = [
      { at: Date.UTC(2026, 0, 10, 12) }, // 2026-01
      { at: Date.UTC(2025, 11, 5, 12) }, // 2025-12
      { at: Date.UTC(2026, 0, 25, 12) }, // 2026-01
    ];
    expect(bucketEntriesByMonth(entries)).toEqual([
      { month: "2025-12", count: 1 },
      { month: "2026-01", count: 2 },
    ]);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketEntriesByMonth([])).toEqual([]);
  });
});

describe("journal by-month (Issue #660)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-660u-"));
    store = new SessionStore(dir);
    id = store.newId();
    // Created + 2 notes in 2026-03; pinned in 2026-07.
    store.checkpoint(id, [{ role: "user", content: "by-month fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: MARCH_AT,
    });
    expect(appendSessionNote(store, id, "note 0", MARCH_AT + 3_600_000).ok).toBe(true);
    expect(appendSessionNote(store, id, "note 1", MARCH_AT + 7_200_000).ok).toBe(true);
    store.writePinned(id, JULY_AT);
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

  function byMonthJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const grouped = buildSessionJournalByMonth(store, id, opts);
    if ("error" in grouped) throw new Error(grouped.error);
    return grouped.byMonth;
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
      { window: { since: JULY_AT } },
      { skip: 1 },
      { skip: 1, limit: 2 },
      { kinds: new Set(["note"]), skip: 1, limit: 1 },
    ];
    for (const combo of combos) {
      const built = fullJournal(combo);
      if ("error" in built) throw new Error(built.error);
      const grouped = byMonthJournal(combo);
      expect(grouped.byMonth).toEqual(bucketEntriesByMonth(built.journal.entries));
      expect(grouped.count).toBe(built.journal.entries.length);
      expect(grouped.elided).toBe(built.journal.elided);
      expect(grouped.skipped).toBe(built.journal.skipped);
      const bucketSum = grouped.byMonth.reduce((a, b) => a + b.count, 0);
      expect(bucketSum).toBe(grouped.count);
      expect(grouped.sessionId).toBe(built.journal.sessionId);
      expect(grouped.integrity).toBe(built.journal.integrity);
    }
  });

  it("renders the month breakdown with the exact shape", () => {
    const grouped = byMonthJournal({ kinds: new Set(["created", "note", "pinned"]) });
    expect(grouped.schema).toBe("oh-my-cli.session-journal-by-month");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(4);
    expect(grouped.byMonth).toEqual([
      { month: "2026-03", count: 3 },
      { month: "2026-07", count: 1 },
    ]);
    const lines = formatSessionJournalByMonth(grouped);
    expect(lines[0]).toBe("4 event(s) across 2 month(s).");
    expect(lines[1]).toBe("  2026-03 ×3");
    expect(lines[2]).toBe("  2026-07 ×1");
  });

  it("carries month buckets only — never entry contents", () => {
    const grouped = byMonthJournal();
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("fodder");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = byMonthJournal({ kinds: new Set(["archived"]) });
    expect(grouped.count).toBe(0);
    expect(grouped.byMonth).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatSessionJournalByMonth(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the store byte-identical through by-month reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalByMonth(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalByMonth(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("matches the workspace full render's buckets and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    const grouped = buildWorkspaceJournalByMonth(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-month");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(full.entries.length);
    expect(grouped.elided).toBe(full.elided);
    expect(grouped.skipped).toBe(full.skipped);
    expect(grouped.byMonth).toEqual(bucketEntriesByMonth(full.entries));
    expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
    expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(grouped.workspace).toBe(full.workspace);
  });
});
