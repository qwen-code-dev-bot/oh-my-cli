import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionJournal,
  filterEntriesByKind,
  JOURNAL_KINDS,
} from "../../src/session-journal.js";
import type { SessionJournalEntry } from "../../src/session-journal.js";
import { buildWorkspaceJournal, formatWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const NOW = 1_701_600_000_000;

describe("filterEntriesByKind (Issue #632)", () => {
  const entry = (kind: SessionJournalEntry["kind"], at: number): SessionJournalEntry => ({
    at,
    kind,
    detail: `${kind} detail`,
  });
  const entries = [
    entry("created", 1),
    entry("goal", 2),
    entry("note", 3),
    entry("pinned", 4),
  ];

  it("returns all entries (order preserved) without a filter", () => {
    expect(filterEntriesByKind(entries, undefined).map((e) => e.kind)).toEqual([
      "created",
      "goal",
      "note",
      "pinned",
    ]);
    expect(filterEntriesByKind(entries, new Set()).map((e) => e.kind)).toEqual([
      "created",
      "goal",
      "note",
      "pinned",
    ]);
  });

  it("filters to the requested kinds, preserving order", () => {
    expect(filterEntriesByKind(entries, new Set(["goal"])).map((e) => e.kind)).toEqual(["goal"]);
    expect(
      filterEntriesByKind(entries, new Set(["note", "created"])).map((e) => e.kind),
    ).toEqual(["created", "note"]);
  });

  it("exposes the full taxonomy", () => {
    expect(JOURNAL_KINDS).toEqual([
      "created",
      "goal",
      "note",
      "pinned",
      "archived",
      "last-activity",
    ]);
  });
});

describe("journal kind filtering across both surfaces (Issue #632)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-632u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "filter fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    expect(appendSessionNote(store, id, "filter note", NOW).ok).toBe(true);
    store.writePinned(id, NOW + 1000);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("filters the per-session journal to the requested kinds", () => {
    const unfiltered = buildSessionJournal(store, id);
    if ("error" in unfiltered) throw new Error(unfiltered.error);
    const unfilteredKinds = unfiltered.journal.entries.map((e) => e.kind);
    expect(unfilteredKinds).toContain("goal");
    expect(unfilteredKinds).toContain("note");
    expect(unfilteredKinds).toContain("pinned");

    const goalOnly = buildSessionJournal(store, id, { kinds: new Set(["goal"]) });
    if ("error" in goalOnly) throw new Error(goalOnly.error);
    expect(goalOnly.journal.entries.every((e) => e.kind === "goal")).toBe(true);
    expect(goalOnly.journal.entries.length).toBeGreaterThan(0);

    const multi = buildSessionJournal(store, id, { kinds: new Set(["note", "pinned"]) });
    if ("error" in multi) throw new Error(multi.error);
    expect(multi.journal.entries.every((e) => e.kind === "note" || e.kind === "pinned")).toBe(true);

    const empty = buildSessionJournal(store, id, { kinds: new Set(["archived"]) });
    if ("error" in empty) throw new Error(empty.error);
    expect(empty.journal.entries).toEqual([]);
  });

  it("composes the filter with workspace scoping and the bound post-filter", () => {
    // Add many goal entries so the unfiltered journal exceeds the bound but
    // the goal-only filtered set does not.
    for (let i = 0; i < 6; i++) {
      expect(appendSessionNote(store, id, `note ${i}`, NOW + 2000 + i * 10).ok).toBe(true);
    }
    const journal = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      maxEntries: 5,
      kinds: new Set(["goal"]),
    });
    // Only goal entries survive the filter; fewer than the bound, so nothing
    // is elided even though the unfiltered journal would exceed the bound.
    expect(journal.entries.every((e) => e.kind === "goal")).toBe(true);
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(journal.elided).toBe(0);

    // Without the filter the same store elides.
    const unfiltered = buildWorkspaceJournal(store, { workspace: "/srv/ws", maxEntries: 5 });
    expect(unfiltered.elided).toBeGreaterThan(0);
  });

  it("renders the honest empty state for a filter that matches nothing", () => {
    const journal = buildWorkspaceJournal(store, {
      workspace: "/srv/ws",
      kinds: new Set(["archived"]),
    });
    expect(journal.entries).toEqual([]);
    const text = formatWorkspaceJournal(journal).join("\n");
    expect(text).toContain("Sessions merged: 1");
    expect(text).toContain("No journal entries for this workspace.");
  });

  it("keeps the store byte-identical through filtered reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id, { kinds: new Set(["goal", "note"]) });
    buildWorkspaceJournal(store, { workspace: "/srv/ws", kinds: new Set(["note"]) });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
