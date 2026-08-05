import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  applyJournalSkip,
  buildSessionJournal,
  formatSessionJournal,
  parseJournalSkip,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("parseJournalSkip (Issue #638)", () => {
  it("parses positive integers, tolerating surrounding whitespace", () => {
    expect(parseJournalSkip("1")).toBe(1);
    expect(parseJournalSkip("9")).toBe(9);
    expect(parseJournalSkip(" 27 ")).toBe(27);
  });

  it("fails closed on zero, negatives, floats, and garbage", () => {
    expect(() => parseJournalSkip("0")).toThrow(/invalid --skip value/);
    expect(() => parseJournalSkip("-2")).toThrow(/invalid --skip value/);
    expect(() => parseJournalSkip("2.5")).toThrow(/invalid --skip value/);
    expect(() => parseJournalSkip("xyz")).toThrow(/invalid --skip value/);
    expect(() => parseJournalSkip("")).toThrow(/invalid --skip value/);
    expect(() => parseJournalSkip("1e2")).toThrow(/invalid --skip value/);
  });
});

describe("applyJournalSkip (Issue #638)", () => {
  const entries = [1, 2, 3, 4, 5].map((at) => ({ at, kind: "note" as const, detail: `${at}` }));

  it("keeps everything (order preserved) without a skip", () => {
    expect(applyJournalSkip(entries, undefined)).toEqual({ entries, skipped: 0 });
  });

  it("sets aside the newest N entries, keeping the ones before them", () => {
    expect(applyJournalSkip(entries, 2)).toEqual({
      entries: [entries[0], entries[1], entries[2]],
      skipped: 2,
    });
    expect(applyJournalSkip(entries, 1)).toEqual({
      entries: [entries[0], entries[1], entries[2], entries[3]],
      skipped: 1,
    });
  });

  it("caps an over-skip at the entry count with a truthful count", () => {
    expect(applyJournalSkip(entries, 5)).toEqual({ entries: [], skipped: 5 });
    expect(applyJournalSkip(entries, 99)).toEqual({ entries: [], skipped: 5 });
    expect(applyJournalSkip([], 3)).toEqual({ entries: [], skipped: 0 });
  });
});

describe("journal skip across both surfaces (Issue #638)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-638u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "skip fodder" }], {
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

  function journal(
    opts: { kinds?: ReadonlySet<"note">; skip?: number; limit?: number } = {},
  ) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("sets aside the newest entries with an honest skipped count", () => {
    // Fixture entries, oldest first: created, goal, 5 notes, pinned, then
    // last-activity (live transcript mtime, always newest) — 9 total.
    const unskipped = journal();
    expect(unskipped.entries.length).toBe(9);
    expect(unskipped.skipped).toBe(0);

    const skipped = journal({ skip: 2 });
    expect(skipped.entries.length).toBe(7);
    expect(skipped.skipped).toBe(2);
    // The two newest (pinned, last-activity) are set aside; the kept set
    // ends at the last note, oldest-first order preserved.
    expect(skipped.entries.map((e) => e.kind)).toEqual([
      "created",
      "goal",
      "note",
      "note",
      "note",
      "note",
      "note",
    ]);
    expect(skipped.entries[6].detail).toContain("note 4");
  });

  it("composes skip before limit (backward paging)", () => {
    // Skip the newest two, then keep the newest three of the remainder.
    const page = journal({ skip: 2, limit: 3 });
    expect(page.entries.map((e) => e.kind)).toEqual(["note", "note", "note"]);
    expect(page.entries.map((e) => e.detail)).toEqual([
      "note added · note 2",
      "note added · note 3",
      "note added · note 4",
    ]);
    expect(page.skipped).toBe(2);
    expect(page.elided).toBe(4); // created, goal, note 0, note 1
  });

  it("composes skip after the kind filter", () => {
    const skipped = journal({ kinds: new Set(["note"]), skip: 1 });
    expect(skipped.entries.length).toBe(4);
    expect(skipped.entries.every((e) => e.kind === "note")).toBe(true);
    expect(skipped.entries[3].detail).toContain("note 3");
    expect(skipped.skipped).toBe(1);
    expect(skipped.elided).toBe(0);
  });

  it("renders the honest empty state with a truthful skipped note on over-skip", () => {
    const empty = journal({ skip: 100 });
    expect(empty.entries).toEqual([]);
    expect(empty.skipped).toBe(9);
    const text = formatSessionJournal(empty).join("\n");
    expect(text).toContain("No journal entries.");
    expect(text).toContain("(+9 newer event(s) skipped.)");
  });

  it("keeps the store byte-identical through skip-bounded reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id, { skip: 3, limit: 2 });
    buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 2 });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("reports honest skipped counts on the workspace surface", () => {
    const skipped = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 3 });
    expect(skipped.skipped).toBe(3);
    expect(skipped.entries.length).toBe(6);
    // Skip composes with the bound: bound applies to the skip-remainder.
    const bounded = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      maxEntries: 2,
      skip: 3,
    });
    expect(bounded.skipped).toBe(3);
    expect(bounded.entries.length).toBe(2);
    expect(bounded.elided).toBe(4);
  });
});
