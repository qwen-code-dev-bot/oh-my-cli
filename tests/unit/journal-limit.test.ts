import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  applyJournalLimit,
  buildSessionJournal,
  parseJournalLimit,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("parseJournalLimit (Issue #636)", () => {
  it("parses positive integers, tolerating surrounding whitespace", () => {
    expect(parseJournalLimit("1")).toBe(1);
    expect(parseJournalLimit("5")).toBe(5);
    expect(parseJournalLimit(" 42 ")).toBe(42);
  });

  it("fails closed on zero, negatives, floats, and garbage", () => {
    expect(() => parseJournalLimit("0")).toThrow(/invalid --limit value/);
    expect(() => parseJournalLimit("-1")).toThrow(/invalid --limit value/);
    expect(() => parseJournalLimit("1.5")).toThrow(/invalid --limit value/);
    expect(() => parseJournalLimit("abc")).toThrow(/invalid --limit value/);
    expect(() => parseJournalLimit("")).toThrow(/invalid --limit value/);
    expect(() => parseJournalLimit("1e3")).toThrow(/invalid --limit value/);
  });
});

describe("applyJournalLimit (Issue #636)", () => {
  const entries = [1, 2, 3, 4, 5].map((at) => ({ at, kind: "note" as const, detail: `${at}` }));

  it("keeps everything (order preserved) without a limit", () => {
    expect(applyJournalLimit(entries, undefined)).toEqual({ entries, elided: 0 });
  });

  it("keeps the newest N entries, oldest-first within the kept window", () => {
    expect(applyJournalLimit(entries, 2)).toEqual({
      entries: [entries[3], entries[4]],
      elided: 3,
    });
    expect(applyJournalLimit(entries, 5)).toEqual({ entries, elided: 0 });
    expect(applyJournalLimit(entries, 99)).toEqual({ entries, elided: 0 });
    expect(applyJournalLimit(entries, 1)).toEqual({ entries: [entries[4]], elided: 4 });
  });

  it("elides nothing for an empty sequence", () => {
    expect(applyJournalLimit([], 3)).toEqual({ entries: [], elided: 0 });
  });
});

describe("journal limit across both surfaces (Issue #636)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-636u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "limit fodder" }], {
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

  function journal(opts: { kinds?: ReadonlySet<"note" | "goal">; limit?: number } = {}) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("bounds the per-session journal to the newest N with an honest elided count", () => {
    // Fixture entries, oldest first: created, goal, 5 notes, pinned, then
    // last-activity (live transcript mtime, always newest).
    const unbounded = journal();
    expect(unbounded.entries.length).toBe(9);
    expect(unbounded.elided).toBe(0);

    const limited = journal({ limit: 3 });
    expect(limited.entries.length).toBe(3);
    expect(limited.elided).toBe(6);
    // Newest three, oldest-first within the kept window.
    expect(limited.entries.map((e) => e.kind)).toEqual(["note", "pinned", "last-activity"]);
    expect(limited.entries[0].detail).toContain("note 4");

    // A limit >= the entry count keeps everything and elides nothing.
    const wide = journal({ limit: 100 });
    expect(wide.entries.length).toBe(9);
    expect(wide.elided).toBe(0);
  });

  it("composes the limit after the kind filter", () => {
    const limited = journal({ kinds: new Set(["note"]), limit: 2 });
    expect(limited.entries.map((e) => e.kind)).toEqual(["note", "note"]);
    expect(limited.entries.map((e) => e.detail)).toEqual([
      "note added · note 3",
      "note added · note 4",
    ]);
    expect(limited.elided).toBe(3);
  });

  it("keeps the store byte-identical through limit-bounded reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id, { limit: 2 });
    buildWorkspaceJournal(store, { workspace: "/srv/ws", limit: 2 });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("lets --limit override the workspace bound in both directions", () => {
    // Tighten below the default: limit wins over a looser test bound.
    const tight = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      maxEntries: 8,
      limit: 2,
    });
    expect(tight.entries.length).toBe(2);
    expect(tight.elided).toBe(7);

    // Expand above: limit wins over a tighter test bound.
    const wide = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      maxEntries: 2,
      limit: 50,
    });
    expect(wide.entries.length).toBe(9);
    expect(wide.elided).toBe(0);

    // Without limit the test bound still applies.
    const plain = buildWorkspaceJournal(store, { workspace: "/srv/ws", maxEntries: 2 });
    expect(plain.entries.length).toBe(2);
    expect(plain.elided).toBe(7);
  });
});
