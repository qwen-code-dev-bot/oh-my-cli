import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionJournal,
  buildSessionJournalSummary,
  formatSessionJournalSummary,
  tallyEntriesByKind,
} from "../../src/session-journal.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalSummary } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("tallyEntriesByKind (Issue #644)", () => {
  it("tallies in fixed taxonomy order with present kinds only", () => {
    const entries = [
      { kind: "note" as const },
      { kind: "created" as const },
      { kind: "note" as const },
      { kind: "pinned" as const },
    ];
    const tally = tallyEntriesByKind(entries);
    expect(Object.keys(tally)).toEqual(["created", "note", "pinned"]);
    expect(tally.note).toBe(2);
    expect(tally.created).toBe(1);
    expect(tally.pinned).toBe(1);
  });

  it("returns an empty map for an empty sequence", () => {
    expect(tallyEntriesByKind([])).toEqual({});
  });
});

describe("journal summary (Issue #644)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-644u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "summary fodder" }], {
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

  // Fixture: created, goal, 5 notes, pinned, last-activity (live mtime) = 9.

  function fullJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  function summaryJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const summarized = buildSessionJournalSummary(store, id, opts);
    if ("error" in summarized) throw new Error(summarized.error);
    return summarized.summary;
  }

  it("matches the full render's kept-set tallies across compositions", () => {
    const combos: Array<{
      kinds?: ReadonlySet<SessionJournalKind>;
      window?: JournalTimeWindow;
      skip?: number;
      limit?: number;
    }> = [
      {},
      { kinds: new Set(["note"]) },
      { kinds: new Set(["note", "goal"]) },
      { window: { since: CREATED_AT + 150 } },
      { skip: 2 },
      { skip: 2, limit: 3 },
      { kinds: new Set(["note"]), skip: 1, limit: 2 },
      { window: { since: CREATED_AT + 150 }, kinds: new Set(["note"]), skip: 1, limit: 2 },
    ];
    for (const combo of combos) {
      const full = fullJournal(combo);
      const summary = summaryJournal(combo);
      expect(summary.count).toBe(full.entries.length);
      expect(summary.elided).toBe(full.elided);
      expect(summary.skipped).toBe(full.skipped);
      expect(summary.byKind).toEqual(tallyEntriesByKind(full.entries));
      const tallySum = Object.values(summary.byKind).reduce((a, b) => a + b, 0);
      expect(tallySum).toBe(summary.count);
      expect(summary.sessionId).toBe(full.sessionId);
      expect(summary.integrity).toBe(full.integrity);
    }
  });

  it("renders the breakdown in taxonomy order with the exact shape", () => {
    const summary = summaryJournal();
    expect(summary.schema).toBe("oh-my-cli.session-journal-summary");
    expect(summary.v).toBe(1);
    expect(summary.count).toBe(9);
    expect(Object.keys(summary.byKind)).toEqual(["created", "goal", "note", "pinned", "last-activity"]);
    const text = formatSessionJournalSummary(summary).join("\n");
    expect(text).toBe(
      "9 event(s): created ×1, goal ×1, note ×5, pinned ×1, last-activity ×1.",
    );
    // archived is not present in the fixture and must be omitted.
    expect(text).not.toContain("archived");
  });

  it("carries tallies only — never entry contents", () => {
    const summary = summaryJournal();
    const json = JSON.stringify(summary);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("mission");
  });

  it("reports an honest zero summary for a matching-nothing filter", () => {
    const summary = summaryJournal({ kinds: new Set(["archived"]) });
    expect(summary.count).toBe(0);
    expect(summary.byKind).toEqual({});
    expect(summary.elided).toBe(0);
    expect(summary.skipped).toBe(0);
    const text = formatSessionJournalSummary(summary).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the truthful skipped note on an over-skip zero summary", () => {
    const summary = summaryJournal({ skip: 100 });
    expect(summary.count).toBe(0);
    expect(summary.skipped).toBe(9);
    const text = formatSessionJournalSummary(summary).join("\n");
    expect(text).toBe("0 event(s). (+9 newer event(s) skipped)");
  });

  it("returns the same error as the full render for a missing session", () => {
    const summarized = buildSessionJournalSummary(store, "no-such-session");
    expect("error" in summarized).toBe(true);
  });

  it("matches the workspace full render's tallies and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    const summary = buildWorkspaceJournalSummary(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    expect(summary.schema).toBe("oh-my-cli.workspace-journal-summary");
    expect(summary.v).toBe(1);
    expect(summary.count).toBe(full.entries.length);
    expect(summary.elided).toBe(full.elided);
    expect(summary.skipped).toBe(full.skipped);
    expect(summary.byKind).toEqual(tallyEntriesByKind(full.entries));
    expect(summary.sessionsScanned).toBe(full.sessionsScanned);
    expect(summary.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(summary.workspace).toBe(full.workspace);
    const json = JSON.stringify(summary);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
  });

  it("keeps the store byte-identical through summary reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalSummary(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalSummary(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
