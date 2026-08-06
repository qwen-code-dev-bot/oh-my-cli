import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildSessionJournal, parseJournalTimestamp } from "../../src/session-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const DAY = 86_400_000;
// 2026-08-05T15:30:00Z — a mid-day reference.
const MID_DAY = Date.UTC(2026, 7, 5, 15, 30);
// 2026-08-05T00:00:00Z — exactly midnight.
const MIDNIGHT = Date.UTC(2026, 7, 5, 0, 0, 0);

describe("parseJournalTimestamp calendar words (Issue #654)", () => {
  it("resolves today to the current UTC day, start or end per bound", () => {
    expect(parseJournalTimestamp("today", "since", MID_DAY)).toBe(Date.UTC(2026, 7, 5));
    expect(parseJournalTimestamp("today", "until", MID_DAY)).toBe(Date.UTC(2026, 7, 5) + DAY - 1);
  });

  it("resolves yesterday to the preceding UTC day, start or end per bound", () => {
    expect(parseJournalTimestamp("yesterday", "since", MID_DAY)).toBe(Date.UTC(2026, 7, 4));
    expect(parseJournalTimestamp("yesterday", "until", MID_DAY)).toBe(
      Date.UTC(2026, 7, 4) + DAY - 1,
    );
  });

  it("stays correct at exactly midnight", () => {
    expect(parseJournalTimestamp("today", "since", MIDNIGHT)).toBe(MIDNIGHT);
    expect(parseJournalTimestamp("today", "until", MIDNIGHT)).toBe(MIDNIGHT + DAY - 1);
    expect(parseJournalTimestamp("yesterday", "since", MIDNIGHT)).toBe(MIDNIGHT - DAY);
    expect(parseJournalTimestamp("yesterday", "until", MIDNIGHT)).toBe(MIDNIGHT - 1);
  });

  it("rolls yesterday across month and year boundaries", () => {
    // 2026-01-01T00:30:00Z → yesterday is 2025-12-31.
    const newYear = Date.UTC(2026, 0, 1, 0, 30);
    expect(parseJournalTimestamp("yesterday", "since", newYear)).toBe(Date.UTC(2025, 11, 31));
    expect(parseJournalTimestamp("yesterday", "until", newYear)).toBe(
      Date.UTC(2025, 11, 31) + DAY - 1,
    );
    // 2026-03-01T12:00:00Z (non-leap year) → yesterday is 2026-02-28.
    const marchFirst = Date.UTC(2026, 2, 1, 12);
    expect(parseJournalTimestamp("yesterday", "since", marchFirst)).toBe(Date.UTC(2026, 1, 28));
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseJournalTimestamp(" today ", "since", MID_DAY)).toBe(Date.UTC(2026, 7, 5));
    expect(parseJournalTimestamp(" yesterday ", "until", MID_DAY)).toBe(
      Date.UTC(2026, 7, 4) + DAY - 1,
    );
  });

  it("fails closed on unknown or case-mangled words with the calendar hint", () => {
    for (const bad of ["tomorrow", "last-week", "Today", "YESTERDAY", "todays"]) {
      expect(() => parseJournalTimestamp(bad, "since", MID_DAY)).toThrow(
        /invalid --since timestamp/,
      );
    }
    expect(() => parseJournalTimestamp("tomorrow", "until", MID_DAY)).toThrow(
      /invalid --until timestamp/,
    );
    expect(() => parseJournalTimestamp("tomorrow", "since", MID_DAY)).toThrow(/today\/yesterday/);
  });

  it("keeps ISO, date, and relative semantics exactly as before", () => {
    expect(parseJournalTimestamp("2023-12-04", "since", MID_DAY)).toBe(Date.UTC(2023, 11, 4));
    expect(parseJournalTimestamp("2023-12-04", "until", MID_DAY)).toBe(
      Date.UTC(2023, 11, 4) + DAY - 1,
    );
    expect(parseJournalTimestamp("2d", "since", MID_DAY)).toBe(MID_DAY - 2 * DAY);
    expect(parseJournalTimestamp("now", "since", MID_DAY)).toBe(MID_DAY);
    expect(parseJournalTimestamp("2023-12-04T14:26:40.000Z", "since", MID_DAY)).toBe(
      Date.UTC(2023, 11, 4, 14, 26, 40),
    );
  });
});

describe("journal windowing with calendar words (Issue #654)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-654u-"));
    store = new SessionStore(dir);
    id = store.newId();
    // Created two days before the real now; the note is anchored at the
    // early current UTC day so it is always inside "today" (and never
    // "yesterday") regardless of the run's wall clock — a `now - 30m`
    // anchor crossed the day boundary between 00:00 and 00:30 UTC.
    store.checkpoint(id, [{ role: "user", content: "calendar word fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: Date.now() - 2 * DAY,
    });
    const now = new Date();
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    expect(appendSessionNote(store, id, "recent note", startOfToday + 60_000).ok).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function journal(window: { since?: number; until?: number }) {
    const built = buildSessionJournal(store, id, { window });
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("--since today keeps only entries from the current UTC day onward", () => {
    const windowed = journal({
      since: parseJournalTimestamp("today", "since"),
    });
    const kinds = windowed.entries.map((e) => e.kind);
    // The recent note and the live last-activity are inside today; the
    // two-day-old created entry is not.
    expect(kinds).toContain("note");
    expect(kinds).not.toContain("created");
  });

  it("--since yesterday --until yesterday isolates the preceding day", () => {
    const windowed = journal({
      since: parseJournalTimestamp("yesterday", "since"),
      until: parseJournalTimestamp("yesterday", "until"),
    });
    // Nothing in the fixture lives on yesterday: created is two days old,
    // the note and last-activity are today — an honest empty window.
    expect(windowed.entries).toEqual([]);
  });
});
