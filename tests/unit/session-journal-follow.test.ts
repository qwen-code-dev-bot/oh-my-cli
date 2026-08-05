import { describe, it, expect } from "vitest";
import {
  sessionJournalEntryIdentity,
  sessionDiffNewEntries,
  sessionJournalEntryLine,
  sessionJournalEntryJsonLine,
  SESSION_JOURNAL_SCHEMA,
  SESSION_JOURNAL_VERSION,
  type SessionJournalEntry,
} from "../../src/session-journal.js";

function entry(overrides: Partial<SessionJournalEntry> = {}): SessionJournalEntry {
  return {
    at: 1000,
    kind: "note",
    detail: "note saved",
    ...overrides,
  };
}

describe("sessionJournalEntryIdentity (Issue #688)", () => {
  it("is stable for identical entries", () => {
    expect(sessionJournalEntryIdentity(entry())).toBe(sessionJournalEntryIdentity(entry()));
  });

  it("distinguishes every identity field", () => {
    const base = sessionJournalEntryIdentity(entry());
    expect(sessionJournalEntryIdentity(entry({ at: 2000 }))).not.toBe(base);
    expect(sessionJournalEntryIdentity(entry({ kind: "goal" }))).not.toBe(base);
    expect(sessionJournalEntryIdentity(entry({ detail: "other detail" }))).not.toBe(base);
  });

  it("does not conflate field-boundary collisions", () => {
    const a = entry({ kind: "note", detail: "d" });
    const b = entry({ kind: "noted", detail: "" });
    expect(sessionJournalEntryIdentity(a)).not.toBe(sessionJournalEntryIdentity(b));
  });
});

describe("sessionDiffNewEntries (Issue #688)", () => {
  it("returns nothing when the journal is unchanged", () => {
    const entries = [entry(), entry({ at: 2000, detail: "second" })];
    const seen = new Set(entries.map(sessionJournalEntryIdentity));
    expect(sessionDiffNewEntries(seen, entries)).toEqual([]);
  });

  it("returns appended entries in chronological order", () => {
    const existing = entry();
    const seen = new Set([sessionJournalEntryIdentity(existing)]);
    const newer = entry({ at: 2000, detail: "pinned to the top of discovery" });
    const newest = entry({ at: 3000, detail: "note saved" });
    expect(sessionDiffNewEntries(seen, [existing, newer, newest])).toEqual([newer, newest]);
  });

  it("returns nothing when re-polled with the same state", () => {
    const seen = new Set<string>();
    const current = [entry(), entry({ at: 2000, detail: "second" })];
    const first = sessionDiffNewEntries(seen, current);
    for (const e of first) seen.add(sessionJournalEntryIdentity(e));
    expect(sessionDiffNewEntries(seen, current)).toEqual([]);
  });

  it("never re-emits vanished entries", () => {
    const gone = entry({ detail: "archived" });
    const seen = new Set([sessionJournalEntryIdentity(gone)]);
    expect(sessionDiffNewEntries(seen, [])).toEqual([]);
  });
});

describe("sessionJournalEntryLine (Issue #688)", () => {
  it("renders the canonical per-session line", () => {
    expect(sessionJournalEntryLine(entry(), () => "STAMP")).toBe("  STAMP · note · note saved");
  });
});

describe("sessionJournalEntryJsonLine (Issue #688)", () => {
  const ctx = { sessionId: "session-a" };

  it("emits one complete, parseable JSON value", () => {
    const line = sessionJournalEntryJsonLine(entry(), ctx);
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("tags the line with the session-journal schema identity and session", () => {
    const parsed = JSON.parse(sessionJournalEntryJsonLine(entry(), ctx));
    expect(parsed.schema).toBe(SESSION_JOURNAL_SCHEMA);
    expect(parsed.v).toBe(SESSION_JOURNAL_VERSION);
    expect(parsed.sessionId).toBe("session-a");
  });

  it("carries every entry field", () => {
    const parsed = JSON.parse(
      sessionJournalEntryJsonLine(entry({ kind: "pinned", detail: "pinned to the top of discovery" }), ctx),
    );
    expect(parsed.at).toBe(1000);
    expect(parsed.kind).toBe("pinned");
    expect(parsed.detail).toBe("pinned to the top of discovery");
  });

  it("omits integrity when absent and carries it when present", () => {
    expect(JSON.parse(sessionJournalEntryJsonLine(entry(), ctx)).integrity).toBeUndefined();
    expect(
      JSON.parse(sessionJournalEntryJsonLine(entry(), { sessionId: "s", integrity: "corrupt" }))
        .integrity,
    ).toBe("corrupt");
  });

  it("is a pure, stable serializer", () => {
    expect(sessionJournalEntryJsonLine(entry(), ctx)).toBe(
      sessionJournalEntryJsonLine(entry(), ctx),
    );
  });
});
