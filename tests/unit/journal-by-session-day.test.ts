import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bucketEntriesByDay,
} from "../../src/session-journal.js";
import {
  bucketWorkspaceEntriesBySession,
  bucketWorkspaceEntriesBySessionDay,
  buildWorkspaceJournal,
  buildWorkspaceJournalBySessionDay,
  formatWorkspaceJournalBySessionDay,
} from "../../src/workspace-journal.js";
import type {
  JournalTimeWindow,
} from "../../src/session-journal.js";
import type { SessionJournalKind } from "../../src/session-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const D1 = Date.UTC(2026, 2, 10, 10, 0); // 2026-03-10T10:00Z
const D2 = Date.UTC(2026, 2, 11, 9, 0); // 2026-03-11T09:00Z
const DAY1_KEY = "2026-03-10";
const DAY2_KEY = "2026-03-11";

describe("journal by-session-day (Issue #662)", () => {
  let dir: string;
  let store: SessionStore;
  let idA: string;
  let idB: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-662u-"));
    store = new SessionStore(dir);
    // Session A: created D1 10:00, note D1 11:00 → (D1, A) ×2, plus the
    // live last-activity on today.
    idA = store.newId();
    store.checkpoint(idA, [{ role: "user", content: "cross-tab fodder A" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: D1,
    });
    expect(appendSessionNote(store, idA, "note A", D1 + 3_600_000).ok).toBe(true);
    // Session B: note D1 15:00 → (D1, B) ×1; created D2 09:00 → (D2, B) ×1.
    idB = store.newId();
    store.checkpoint(idB, [{ role: "user", content: "cross-tab fodder B" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: D2,
    });
    expect(appendSessionNote(store, idB, "note B", D1 + 5 * 3_600_000).ok).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function shortOf(id: string): string {
    return id.split("-")[0].slice(0, 8);
  }

  function fullJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    return buildWorkspaceJournal(store, { workspace: "/srv/ws", ...opts });
  }

  it("orders pairs day ascending, sessionId ascending within a day, present pairs only", () => {
    const full = fullJournal({ kinds: new Set(["created", "note"]) });
    const pairs = bucketWorkspaceEntriesBySessionDay(full.entries);
    const expected = [
      { day: DAY1_KEY, sessionId: idA, shortId: shortOf(idA), count: 2 },
      { day: DAY1_KEY, sessionId: idB, shortId: shortOf(idB), count: 1 },
      { day: DAY2_KEY, sessionId: idB, shortId: shortOf(idB), count: 1 },
    ].sort((a, b) => a.day.localeCompare(b.day) || a.sessionId.localeCompare(b.sessionId));
    expect(pairs).toEqual(expected);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketWorkspaceEntriesBySessionDay([])).toEqual([]);
  });

  it("collapses consistently with the single-key day and session groupings", () => {
    const full = fullJournal({ kinds: new Set(["created", "note"]) });
    const pairs = bucketWorkspaceEntriesBySessionDay(full.entries);

    // Collapse by day → identical to bucketEntriesByDay.
    const byDay = new Map<string, number>();
    for (const p of pairs) {
      byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.count);
    }
    const collapsedDay = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, count]) => ({ day, count }));
    expect(collapsedDay).toEqual(bucketEntriesByDay(full.entries));

    // Collapse by session → identical to bucketWorkspaceEntriesBySession.
    const bySession = new Map<string, number>();
    for (const p of pairs) {
      bySession.set(p.sessionId, (bySession.get(p.sessionId) ?? 0) + p.count);
    }
    const collapsedSession = [...bySession.entries()]
      .map(([sessionId, count]) => ({ sessionId, count }))
      .sort((a, b) => b.count - a.count || a.sessionId.localeCompare(b.sessionId));
    expect(collapsedSession).toEqual(
      bucketWorkspaceEntriesBySession(full.entries).map(({ sessionId, count }) => ({
        sessionId,
        count,
      })),
    );
  });

  it("matches the full render's kept set across compositions", () => {
    const combos: Array<{
      kinds?: ReadonlySet<SessionJournalKind>;
      window?: JournalTimeWindow;
      skip?: number;
      limit?: number;
    }> = [
      {},
      { kinds: new Set(["note"]) },
      { kinds: new Set(["created", "note"]) },
      { window: { since: D2 } },
      { skip: 1 },
      { skip: 1, limit: 2 },
      { kinds: new Set(["note"]), skip: 1, limit: 1 },
    ];
    for (const combo of combos) {
      const full = fullJournal(combo);
      const grouped = buildWorkspaceJournalBySessionDay(store, { workspace: "/srv/ws", ...combo });
      expect(grouped.bySessionDay).toEqual(bucketWorkspaceEntriesBySessionDay(full.entries));
      expect(grouped.count).toBe(full.entries.length);
      expect(grouped.elided).toBe(full.elided);
      expect(grouped.skipped).toBe(full.skipped);
      const pairSum = grouped.bySessionDay.reduce((a, b) => a + b.count, 0);
      expect(pairSum).toBe(grouped.count);
      expect(grouped.workspace).toBe(full.workspace);
      expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
      expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    }
  });

  it("renders the cross-tab with the exact shape", () => {
    const grouped = buildWorkspaceJournalBySessionDay(store, {
      workspace: "/srv/ws",
      kinds: new Set(["created", "note"]),
    });
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-session-day");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(4);
    expect(grouped.bySessionDay.length).toBe(3);
    const lines = formatWorkspaceJournalBySessionDay(grouped);
    expect(lines[0]).toBe("4 event(s) across 3 session-day pair(s).");
    // Day-first ordering: both D1 pairs before the D2 pair; within D1 the
    // order is sessionId ascending.
    const d1Pairs = [
      { day: DAY1_KEY, sessionId: idA, count: 2 },
      { day: DAY1_KEY, sessionId: idB, count: 1 },
    ].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(lines[1]).toBe(`  ${DAY1_KEY} · ${shortOf(d1Pairs[0].sessionId)} ×${d1Pairs[0].count}`);
    expect(lines[2]).toBe(`  ${DAY1_KEY} · ${shortOf(d1Pairs[1].sessionId)} ×${d1Pairs[1].count}`);
    expect(lines[3]).toBe(`  ${DAY2_KEY} · ${shortOf(idB)} ×1`);
  });

  it("carries pair buckets only — never entry contents", () => {
    const grouped = buildWorkspaceJournalBySessionDay(store, { workspace: "/srv/ws" });
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note A");
    expect(json).not.toContain("fodder");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = buildWorkspaceJournalBySessionDay(store, {
      workspace: "/srv/ws",
      kinds: new Set(["archived"]),
    });
    expect(grouped.count).toBe(0);
    expect(grouped.bySessionDay).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatWorkspaceJournalBySessionDay(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the store byte-identical through pair reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildWorkspaceJournalBySessionDay(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
