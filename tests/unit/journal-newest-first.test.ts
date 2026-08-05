import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildSessionJournal, formatSessionJournal, JOURNAL_ORDERS } from "../../src/session-journal.js";
import { buildWorkspaceJournal, formatWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("journal newest-first across both surfaces (Issue #640)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-640u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "order fodder" }], {
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

  function journal(opts: {
    kinds?: ReadonlySet<"note">;
    skip?: number;
    limit?: number;
    newestFirst?: boolean;
  } = {}) {
    const built = buildSessionJournal(store, id, opts);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("exposes the closed order taxonomy", () => {
    expect(JOURNAL_ORDERS).toEqual(["oldest-first", "newest-first"]);
  });

  it("defaults to oldest-first with the order field always present", () => {
    const plain = journal();
    expect(plain.order).toBe("oldest-first");
    const ats = plain.entries.map((e) => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it("reverses exactly the kept sequence, keeping counts identical", () => {
    const forward = journal({ skip: 2, limit: 3 });
    const backward = journal({ skip: 2, limit: 3, newestFirst: true });

    expect(backward.order).toBe("newest-first");
    expect(backward.elided).toBe(forward.elided);
    expect(backward.skipped).toBe(forward.skipped);
    expect(backward.entries.map((e) => `${e.at}·${e.kind}·${e.detail}`)).toEqual(
      [...forward.entries].reverse().map((e) => `${e.at}·${e.kind}·${e.detail}`),
    );
    // Newest entry renders first.
    expect(backward.entries[0].at).toBe(Math.max(...backward.entries.map((e) => e.at)));
  });

  it("keeps entry-set and count equivalence across full composition", () => {
    const combos = [
      {},
      { kinds: new Set(["note"] as const) },
      { skip: 1 },
      { skip: 2, limit: 2 },
      { kinds: new Set(["note"] as const), skip: 1, limit: 2 },
    ];
    for (const combo of combos) {
      const forward = journal(combo);
      const backward = journal({ ...combo, newestFirst: true });
      expect(backward.elided).toBe(forward.elided);
      expect(backward.skipped).toBe(forward.skipped);
      expect(backward.entries.length).toBe(forward.entries.length);
      expect(new Set(backward.entries.map((e) => e.detail))).toEqual(
        new Set(forward.entries.map((e) => e.detail)),
      );
      expect(backward.entries.map((e) => e.detail)).toEqual(
        [...forward.entries].reverse().map((e) => e.detail),
      );
    }
  });

  it("renders newest-first text with unchanged count notes", () => {
    const backward = journal({ skip: 2, limit: 3, newestFirst: true });
    const lines = formatSessionJournal(backward);
    // First entry line is the newest kept entry.
    const entryLines = lines.filter((l) => l.startsWith("  "));
    expect(entryLines.length).toBe(3);
    expect(entryLines[0]).toContain("note 4");
    const tail = lines[lines.length - 1];
    expect(tail).toBe("3 event(s). (+4 older event(s) not shown) (+2 newer event(s) skipped)");
  });

  it("reports honest order and counts on the workspace surface", () => {
    const forward = buildWorkspaceJournal(store, { workspace: "/srv/ws", skip: 2, limit: 3 });
    const backward = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      skip: 2,
      limit: 3,
      newestFirst: true,
    });
    expect(forward.order).toBe("oldest-first");
    expect(backward.order).toBe("newest-first");
    expect(backward.elided).toBe(forward.elided);
    expect(backward.skipped).toBe(forward.skipped);
    expect(backward.entries.map((e) => e.detail)).toEqual(
      [...forward.entries].reverse().map((e) => e.detail),
    );
    const text = formatWorkspaceJournal(backward).join("\n");
    expect(text).toContain("3 event(s) shown. (+4 older event(s) not shown) (+2 newer event(s) skipped)");
  });

  it("keeps the store byte-identical through newest-first reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id, { newestFirst: true });
    buildWorkspaceJournal(store, { workspace: "/srv/ws", newestFirst: true });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
