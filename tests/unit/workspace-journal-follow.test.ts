import { describe, it, expect } from "vitest";
import {
  journalEntryIdentity,
  diffNewEntries,
  workspaceJournalEntryLine,
  type WorkspaceJournalEntry,
} from "../../src/workspace-journal.js";
import { parseJournalPollMs, JOURNAL_FOLLOW_DEFAULT_POLL_MS } from "../../src/session-journal.js";

function entry(overrides: Partial<WorkspaceJournalEntry> = {}): WorkspaceJournalEntry {
  return {
    at: 1000,
    kind: "note",
    detail: "note saved",
    sessionId: "session-a",
    shortId: "short-a",
    ...overrides,
  };
}

describe("journalEntryIdentity (Issue #684)", () => {
  it("is stable for identical entries", () => {
    expect(journalEntryIdentity(entry())).toBe(journalEntryIdentity(entry()));
  });

  it("distinguishes every identity field", () => {
    const base = journalEntryIdentity(entry());
    expect(journalEntryIdentity(entry({ sessionId: "session-b" }))).not.toBe(base);
    expect(journalEntryIdentity(entry({ at: 2000 }))).not.toBe(base);
    expect(journalEntryIdentity(entry({ kind: "goal" }))).not.toBe(base);
    expect(journalEntryIdentity(entry({ detail: "other detail" }))).not.toBe(base);
  });

  it("does not conflate field-boundary collisions", () => {
    const a = entry({ sessionId: "a\u0000b", kind: "note", detail: "d" });
    const b = entry({ sessionId: "a", kind: "note", detail: "d" });
    expect(journalEntryIdentity(a)).not.toBe(journalEntryIdentity(b));
  });
});

describe("diffNewEntries (Issue #684)", () => {
  it("returns nothing when the chronology is unchanged", () => {
    const entries = [entry(), entry({ at: 2000, detail: "second" })];
    const seen = new Set(entries.map(journalEntryIdentity));
    expect(diffNewEntries(seen, entries)).toEqual([]);
  });

  it("returns appended entries in chronological order", () => {
    const existing = entry();
    const seen = new Set([journalEntryIdentity(existing)]);
    const newer = entry({ at: 2000, detail: "pinned to the top of discovery" });
    const newest = entry({ at: 3000, detail: "note saved" });
    expect(diffNewEntries(seen, [existing, newer, newest])).toEqual([newer, newest]);
  });

  it("returns nothing when re-polled with the same state", () => {
    const seen = new Set<string>();
    const current = [entry(), entry({ at: 2000, detail: "second" })];
    const first = diffNewEntries(seen, current);
    for (const e of first) seen.add(journalEntryIdentity(e));
    expect(diffNewEntries(seen, current)).toEqual([]);
  });

  it("never re-emits vanished entries", () => {
    const gone = entry({ detail: "archived" });
    const seen = new Set([journalEntryIdentity(gone)]);
    expect(diffNewEntries(seen, [])).toEqual([]);
  });
});

describe("workspaceJournalEntryLine (Issue #684)", () => {
  it("renders the canonical line with a plain stamp", () => {
    const line = workspaceJournalEntryLine(entry({ detail: "note saved" }), () => "STAMP");
    expect(line).toBe("  STAMP · short-a · note · note saved");
  });

  it("appends the integrity verdict when present", () => {
    const line = workspaceJournalEntryLine(
      entry({ integrity: "corrupt", detail: "session created" }),
      () => "STAMP",
    );
    expect(line).toBe("  STAMP · short-a (corrupt) · note · session created");
  });
});

describe("parseJournalPollMs (Issue #684)", () => {
  it("accepts integers at and above the minimum", () => {
    expect(parseJournalPollMs("50")).toBe(50);
    expect(parseJournalPollMs("1000")).toBe(1000);
  });

  it("rejects values below the minimum", () => {
    expect(() => parseJournalPollMs("49")).toThrow(/invalid --poll-ms value/);
    expect(() => parseJournalPollMs("0")).toThrow(/invalid --poll-ms value/);
  });

  it("rejects non-integers and garbage", () => {
    expect(() => parseJournalPollMs("abc")).toThrow(/invalid --poll-ms value/);
    expect(() => parseJournalPollMs("1.5")).toThrow(/invalid --poll-ms value/);
    expect(() => parseJournalPollMs("-100")).toThrow(/invalid --poll-ms value/);
  });

  it("defaults to 1000ms", () => {
    expect(JOURNAL_FOLLOW_DEFAULT_POLL_MS).toBe(1000);
  });
});
