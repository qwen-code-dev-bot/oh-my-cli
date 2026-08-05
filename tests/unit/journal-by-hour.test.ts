import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bucketEntriesByHour,
  buildSessionJournal,
  buildSessionJournalByHour,
  formatSessionJournalByHour,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal, buildWorkspaceJournalByHour } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";
import type { JournalTimeWindow, SessionJournalKind } from "../../src/session-journal.js";

const CREATED_AT = Date.UTC(2023, 11, 3, 10, 40); // 2023-12-03T10:40Z
const HOUR_KEY_CREATED = "2023-12-03T10";
const HOUR_KEY_PINNED = "2023-12-03T12";

describe("bucketEntriesByHour (Issue #656)", () => {
  it("buckets by UTC hour, chronological, present hours only", () => {
    const entries = [
      { at: Date.UTC(2023, 11, 3, 12, 5) },
      { at: Date.UTC(2023, 11, 3, 10, 59) },
      { at: Date.UTC(2023, 11, 3, 12, 30) },
    ];
    expect(bucketEntriesByHour(entries)).toEqual([
      { hour: "2023-12-03T10", count: 1 },
      { hour: "2023-12-03T12", count: 2 },
    ]);
  });

  it("returns an empty array for an empty sequence", () => {
    expect(bucketEntriesByHour([])).toEqual([]);
  });
});

describe("journal by-hour (Issue #656)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-656u-"));
    store = new SessionStore(dir);
    id = store.newId();
    // Created 10:40Z; two notes in the same hour; pinned two hours later.
    store.checkpoint(id, [{ role: "user", content: "by-hour fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: CREATED_AT,
    });
    expect(appendSessionNote(store, id, "note 0", CREATED_AT + 200_000).ok).toBe(true);
    expect(appendSessionNote(store, id, "note 1", CREATED_AT + 400_000).ok).toBe(true);
    store.writePinned(id, CREATED_AT + 2 * 3_600_000);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Fixture: created + 2 notes in the T10 bucket, pinned in the T12 bucket,
  // plus the live last-activity (wall-clock hour).

  function fullJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    return buildSessionJournal(store, id, opts);
  }

  function byHourJournal(opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {}) {
    const grouped = buildSessionJournalByHour(store, id, opts);
    if ("error" in grouped) throw new Error(grouped.error);
    return grouped.byHour;
  }

  it("matches the full render's kept-set buckets across compositions", () => {
    const combos: Array<{
      kinds?: ReadonlySet<SessionJournalKind>;
      window?: JournalTimeWindow;
      skip?: number;
      limit?: number;
    }> = [
      {},
      { kinds: new Set(["note"]) },
      { kinds: new Set(["note", "created"]) },
      { window: { since: CREATED_AT + 3_600_000 } },
      { skip: 1 },
      { skip: 1, limit: 2 },
      { kinds: new Set(["note"]), skip: 1, limit: 1 },
    ];
    for (const combo of combos) {
      const built = fullJournal(combo);
      if ("error" in built) throw new Error(built.error);
      const grouped = byHourJournal(combo);
      expect(grouped.byHour).toEqual(bucketEntriesByHour(built.journal.entries));
      expect(grouped.count).toBe(built.journal.entries.length);
      expect(grouped.elided).toBe(built.journal.elided);
      expect(grouped.skipped).toBe(built.journal.skipped);
      const bucketSum = grouped.byHour.reduce((a, b) => a + b.count, 0);
      expect(bucketSum).toBe(grouped.count);
      expect(grouped.sessionId).toBe(built.journal.sessionId);
      expect(grouped.integrity).toBe(built.journal.integrity);
    }
  });

  it("renders the hour breakdown with the exact shape", () => {
    const grouped = byHourJournal({ kinds: new Set(["created", "note", "pinned"]) });
    expect(grouped.schema).toBe("oh-my-cli.session-journal-by-hour");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(4);
    expect(grouped.byHour).toEqual([
      { hour: HOUR_KEY_CREATED, count: 3 },
      { hour: HOUR_KEY_PINNED, count: 1 },
    ]);
    const lines = formatSessionJournalByHour(grouped);
    expect(lines[0]).toBe("4 event(s) across 2 hour(s).");
    expect(lines[1]).toBe(`  ${HOUR_KEY_CREATED} ×3`);
    expect(lines[2]).toBe(`  ${HOUR_KEY_PINNED} ×1`);
  });

  it("carries hour buckets only — never entry contents", () => {
    const grouped = byHourJournal();
    const json = JSON.stringify(grouped);
    expect(json).not.toContain("entries");
    expect(json).not.toContain("detail");
    expect(json).not.toContain("note 0");
    expect(json).not.toContain("fodder");
  });

  it("reports an honest zero grouping for a matching-nothing filter", () => {
    const grouped = byHourJournal({ kinds: new Set(["archived"]) });
    expect(grouped.count).toBe(0);
    expect(grouped.byHour).toEqual([]);
    expect(grouped.elided).toBe(0);
    expect(grouped.skipped).toBe(0);
    const text = formatSessionJournalByHour(grouped).join("\n");
    expect(text).toBe("0 event(s).");
  });

  it("keeps the store byte-identical through by-hour reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournalByHour(store, id, { skip: 1, limit: 2 });
    buildWorkspaceJournalByHour(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("matches the workspace full render's buckets and identity fields", () => {
    const full = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    const grouped = buildWorkspaceJournalByHour(store, { workspace: "/srv/ws", skip: 1, limit: 2 });
    expect(grouped.schema).toBe("oh-my-cli.workspace-journal-by-hour");
    expect(grouped.v).toBe(1);
    expect(grouped.count).toBe(full.entries.length);
    expect(grouped.elided).toBe(full.elided);
    expect(grouped.skipped).toBe(full.skipped);
    expect(grouped.byHour).toEqual(bucketEntriesByHour(full.entries));
    expect(grouped.sessionsScanned).toBe(full.sessionsScanned);
    expect(grouped.sessionsSkippedArchived).toBe(full.sessionsSkippedArchived);
    expect(grouped.workspace).toBe(full.workspace);
  });
});
