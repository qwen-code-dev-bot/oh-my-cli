import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildSessionJournal, parseJournalTimestamp } from "../../src/session-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const NOW = 1_800_000_000_000; // fixed reference instant
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("parseJournalTimestamp relative specs (Issue #652)", () => {
  it("resolves every unit as N units before the reference instant", () => {
    expect(parseJournalTimestamp("30s", "since", NOW)).toBe(NOW - 30_000);
    expect(parseJournalTimestamp("45m", "since", NOW)).toBe(NOW - 45 * MIN);
    expect(parseJournalTimestamp("6h", "since", NOW)).toBe(NOW - 6 * HOUR);
    expect(parseJournalTimestamp("2d", "until", NOW)).toBe(NOW - 2 * DAY);
    expect(parseJournalTimestamp("1w", "until", NOW)).toBe(NOW - 7 * DAY);
  });

  it("resolves now and zero offsets to the reference instant", () => {
    expect(parseJournalTimestamp("now", "since", NOW)).toBe(NOW);
    expect(parseJournalTimestamp("0d", "since", NOW)).toBe(NOW);
    expect(parseJournalTimestamp("0s", "until", NOW)).toBe(NOW);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseJournalTimestamp(" 2d ", "since", NOW)).toBe(NOW - 2 * DAY);
    expect(parseJournalTimestamp(" now ", "until", NOW)).toBe(NOW);
  });

  it("fails closed on malformed specs with the relative hint", () => {
    for (const bad of ["5x", "d5", "-2h", "1.5d", "-"]) {
      expect(() => parseJournalTimestamp(bad, "since", NOW)).toThrow(/invalid --since timestamp/);
    }
    expect(() => parseJournalTimestamp("5x", "until", NOW)).toThrow(/invalid --until timestamp/);
    // The hint mentions the accepted relative forms.
    expect(() => parseJournalTimestamp("5x", "since", NOW)).toThrow(/30s\/45m\/6h\/2d\/1w\/now/);
  });

  it("keeps ISO-8601 and bare-date semantics exactly as before", () => {
    expect(parseJournalTimestamp("2023-12-04", "since", NOW)).toBe(Date.UTC(2023, 11, 4));
    expect(parseJournalTimestamp("2023-12-04", "until", NOW)).toBe(
      Date.UTC(2023, 11, 4) + DAY - 1,
    );
    expect(parseJournalTimestamp("2023-12-04T14:26:40.000Z", "since", NOW)).toBe(
      Date.UTC(2023, 11, 4, 14, 26, 40),
    );
    expect(() => parseJournalTimestamp("2023-02-30", "since", NOW)).toThrow(/no such date/);
    expect(() => parseJournalTimestamp("2023-12", "since", NOW)).toThrow(/invalid --since/);
  });
});

describe("journal windowing with relative specs (Issue #652)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-652u-"));
    store = new SessionStore(dir);
    id = store.newId();
    // Created two hours before the reference; a note thirty minutes before.
    store.checkpoint(id, [{ role: "user", content: "relative window fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: NOW - 2 * HOUR,
    });
    expect(appendSessionNote(store, id, "recent note", NOW - 30 * MIN).ok).toBe(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function journal(window: { since?: number; until?: number }) {
    const built = buildSessionJournal(store, id, { window });
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("a relative since selects the same kept set as the hand-computed absolute window", () => {
    const relative = journal({ since: parseJournalTimestamp("1h", "since", NOW) });
    const absolute = journal({ since: NOW - HOUR });
    expect(relative.entries).toEqual(absolute.entries);
    // Created (2h ago) falls out; the recent note and the live last-activity
    // (mtime ~= real now, certainly within the last hour of the fixture's
    // reference semantics) remain.
    const kinds = relative.entries.map((e) => e.kind);
    expect(kinds).toContain("note");
    expect(kinds).not.toContain("created");
  });

  it("a relative until excludes entries after the resolved bound", () => {
    // Until 1h before NOW excludes the recent note (30m before NOW); only
    // created (2h before NOW) among the controlled entries remains. The
    // live last-activity mtime is wall-clock and is filtered out of the
    // assertion so the test is deterministic whenever it runs.
    const windowed = journal({ until: parseJournalTimestamp("1h", "until", NOW) });
    const controlled = windowed.entries.filter((e) => e.kind !== "last-activity");
    expect(controlled.map((e) => e.kind)).toEqual(["created"]);
  });

  it("mixed relative and absolute bounds compose", () => {
    const windowed = journal({
      since: parseJournalTimestamp("3h", "since", NOW),
      until: parseJournalTimestamp("45m", "until", NOW),
    });
    // [NOW-3h, NOW-45m] keeps created (NOW-2h) but not the note (NOW-30m,
    // after the upper bound).
    const controlled = windowed.entries.filter((e) => e.kind !== "last-activity");
    expect(controlled.map((e) => e.kind)).toEqual(["created"]);
  });
});
