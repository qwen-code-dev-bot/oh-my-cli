import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionJournal,
  buildSessionJournalCount,
  formatSessionJournalCount,
} from "../../src/session-journal.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalCount } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("journal count (Issue #642)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-642u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "count fodder" }], {
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

  function countJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const counted = buildSessionJournalCount(store, id, opts);
    if ("error" in counted) throw new Error(counted.error);
    return counted.count;
  }

  it("matches the full render's kept-set size and counts across compositions", () => {
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
      const counted = countJournal(combo);
      expect(counted.count).toBe(full.entries.length);
      expect(counted.elided).toBe(full.elided);
      expect(counted.skipped).toBe(full.skipped);
      expect(counted.sessionId).toBe(full.sessionId);
      expect(counted.integrity).toBe(full.integrity);
    }
  });

  it("carries counts only — never entry contents", () => {
    const counted = countJournal();
    expect(counted.schema).toBe("oh-my-cli.session-journal-count");
    expect(counted.v).toBe(1);
    expect(counted.count).toBe(9);
    const json = JSON.stringify(counted);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("mission");
  });

  it("reports an honest zero count for a matching-nothing filter", () => {
    const counted = countJournal({ kinds: new Set(["archived"]) });
    expect(counted.count).toBe(0);
    expect(counted.elided).toBe(0);
    expect(counted.skipped).toBe(0);
    const text = formatSessionJournalCount(counted).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("caps an over-skip at the filtered size", () => {
    const counted = countJournal({ skip: 100 });
    expect(counted.count).toBe(0);
    expect(counted.skipped).toBe(9);
    expect(counted.elided).toBe(0);
  });

  it("renders the truthful count line with elided/skipped notes", () => {
    const counted = countJournal({ skip: 2, limit: 3 });
    expect(counted.count).toBe(3);
    expect(counted.elided).toBe(4);
    expect(counted.skipped).toBe(2);
    const text = formatSessionJournalCount(counted).join("\n");
    expect(text).toBe("3 event(s). (+4 older event(s) not shown) (+2 newer event(s) skipped)");
  });

  it("returns the same error as the full render for a missing session", () => {
    const counted = buildSessionJournalCount(store, "no-such-session");
    expect("error" in counted).toBe(true);
  });

  it("matches the workspace full render's counts and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    const counted = buildWorkspaceJournalCount(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    expect(counted.schema).toBe("oh-my-cli.workspace-journal-count");
    expect(counted.v).toBe(1);
    expect(counted.count).toBe(full.entries.length);
    expect(counted.elided).toBe(full.elided);
    expect(counted.skipped).toBe(full.skipped);
    expect(counted.sessionsScanned).toBe(full.sessionsScanned);
    expect(counted.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(counted.workspace).toBe(full.workspace);
    const json = JSON.stringify(counted);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
  });

  it("keeps the store byte-identical through count reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalCount(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalCount(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
