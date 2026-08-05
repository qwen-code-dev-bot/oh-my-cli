import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionJournal,
  filterEntriesByWindow,
  parseJournalTimestamp,
} from "../../src/session-journal.js";
import type {
  JournalTimeWindow,
  SessionJournalEntry,
  SessionJournalKind,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z
const NOTE_AT = 1_701_700_000_000; // 2023-12-04T14:26:40Z

describe("parseJournalTimestamp (Issue #634)", () => {
  it("parses full ISO-8601 timestamps to epoch milliseconds", () => {
    expect(parseJournalTimestamp("2023-12-04T00:00:00Z", "since")).toBe(
      Date.UTC(2023, 11, 4),
    );
    expect(parseJournalTimestamp("2023-12-04T14:26:40.000Z", "until")).toBe(NOTE_AT);
    // Numeric offsets are honored too.
    expect(parseJournalTimestamp("2023-12-04T02:00:00+02:00", "since")).toBe(
      Date.UTC(2023, 11, 4),
    );
  });

  it("expands a date-only --since to start of day UTC", () => {
    expect(parseJournalTimestamp("2023-12-04", "since")).toBe(Date.UTC(2023, 11, 4));
  });

  it("expands a date-only --until to end of day UTC", () => {
    expect(parseJournalTimestamp("2023-12-04", "until")).toBe(
      Date.UTC(2023, 11, 4) + 86_400_000 - 1,
    );
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(() => parseJournalTimestamp("2023-02-30", "since")).toThrow(/no such date/);
    expect(() => parseJournalTimestamp("2023-13-01", "until")).toThrow(/no such date/);
  });

  it("fails closed on garbage, year-month, and blank values", () => {
    expect(() => parseJournalTimestamp("not-a-date", "since")).toThrow(
      /invalid --since timestamp/,
    );
    expect(() => parseJournalTimestamp("2023-12", "until")).toThrow(/invalid --until timestamp/);
    expect(() => parseJournalTimestamp("", "since")).toThrow(/must not be blank/);
    expect(() => parseJournalTimestamp("   ", "until")).toThrow(/must not be blank/);
  });
});

describe("filterEntriesByWindow (Issue #634)", () => {
  const entry = (at: number): SessionJournalEntry => ({
    at,
    kind: "note",
    detail: `note at ${at}`,
  });
  const entries = [entry(100), entry(200), entry(300)];

  it("returns all entries (order preserved) without a window", () => {
    expect(filterEntriesByWindow(entries, undefined).map((e) => e.at)).toEqual([100, 200, 300]);
    expect(filterEntriesByWindow(entries, {}).map((e) => e.at)).toEqual([100, 200, 300]);
  });

  it("bounds inclusively on both ends", () => {
    const window: JournalTimeWindow = { since: 100, until: 300 };
    expect(filterEntriesByWindow(entries, window).map((e) => e.at)).toEqual([100, 200, 300]);
    expect(filterEntriesByWindow(entries, { since: 101, until: 299 }).map((e) => e.at)).toEqual([
      200,
    ]);
    expect(filterEntriesByWindow(entries, { since: 300, until: 300 }).map((e) => e.at)).toEqual([
      300,
    ]);
  });

  it("supports one-sided windows", () => {
    expect(filterEntriesByWindow(entries, { since: 200 }).map((e) => e.at)).toEqual([200, 300]);
    expect(filterEntriesByWindow(entries, { until: 200 }).map((e) => e.at)).toEqual([100, 200]);
  });
});

describe("journal time windows across both surfaces (Issue #634)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-634u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "window fodder" }], {
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
    expect(appendSessionNote(store, id, "day-two note", NOTE_AT).ok).toBe(true);
    expect(appendSessionNote(store, id, "later note", NOTE_AT + 1000).ok).toBe(true);
    store.writePinned(id, NOTE_AT + 2000);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function journalEntries(
    opts: { kinds?: ReadonlySet<SessionJournalKind>; window?: JournalTimeWindow } = {},
  ) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal.entries;
  }

  it("bounds the per-session journal to the window, inclusively", () => {
    // A window covering only day two: created and goal (day one) fall out;
    // the live transcript mtime (far in the future of the fixture) falls out
    // through --until being in the past.
    const windowed = journalEntries({
      window: { since: NOTE_AT - 1, until: NOTE_AT + 2000 },
    });
    expect(windowed.every((e) => e.at >= NOTE_AT - 1 && e.at <= NOTE_AT + 2000)).toBe(true);
    expect(windowed.map((e) => e.kind)).toEqual(["note", "note", "pinned"]);

    // Inclusive lower bound keeps the exact-boundary entry.
    const atBound = journalEntries({ window: { since: NOTE_AT, until: NOTE_AT } });
    expect(atBound.length).toBe(1);
    expect(atBound[0].detail).toContain("day-two note");
  });

  it("composes the window with the kind filter", () => {
    const windowed = journalEntries({
      kinds: new Set(["note"]),
      window: { since: NOTE_AT, until: NOTE_AT + 1000 },
    });
    expect(windowed.map((e) => e.kind)).toEqual(["note", "note"]);

    const goalOnly = journalEntries({ kinds: new Set(["goal"]), window: { since: NOTE_AT } });
    expect(goalOnly).toEqual([]);
  });

  it("renders the honest empty state for a window matching nothing", () => {
    const empty = journalEntries({
      window: { since: NOTE_AT + 10_000_000, until: NOTE_AT + 20_000_000 },
    });
    expect(empty).toEqual([]);
  });

  it("leaves the journal unchanged without a window", () => {
    const unwindowed = journalEntries().map((e) => e.at);
    const plain = buildSessionJournal(store, id);
    if ("error" in plain) throw new Error(plain.error);
    expect(unwindowed).toEqual(plain.journal.entries.map((e) => e.at));
  });

  it("composes the window with workspace scoping and the post-filter bound", () => {
    // The window keeps only the three day-two note/pinned entries, so a bound
    // of 2 elides exactly one — counted on the windowed set, not the merge.
    const journal = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      maxEntries: 2,
      window: { since: NOTE_AT, until: NOTE_AT + 2000 },
    });
    expect(journal.entries.length).toBe(2);
    expect(journal.elided).toBe(1);
    expect(journal.entries.every((e) => e.at >= NOTE_AT)).toBe(true);
    // Newest kept, oldest of the windowed set elided.
    expect(journal.entries[0].kind).toBe("note");
    expect(journal.entries[1].kind).toBe("pinned");

    // Without the window the same store with the same bound elides more.
    const unwindowed = buildWorkspaceJournal(store, { workspace: "/srv/ws", maxEntries: 2 });
    expect(unwindowed.elided).toBeGreaterThan(1);
  });

  it("keeps the store byte-identical through windowed reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id, { window: { since: NOTE_AT, until: NOTE_AT + 2000 } });
    buildWorkspaceJournal(store, { workspace: "/srv/ws", window: { since: NOTE_AT } });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
