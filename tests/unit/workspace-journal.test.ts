import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildWorkspaceJournal,
  formatWorkspaceJournal,
  WORKSPACE_JOURNAL_SCHEMA,
  WORKSPACE_JOURNAL_VERSION,
} from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";
import { workspaceTrustKey } from "../../src/folder-trust.js";

const NOW = 1_701_300_000_000;

describe("buildWorkspaceJournal (Issue #630)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-630u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(workspace: string | undefined): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "journal fodder" }], {
      model: "m",
      ...(workspace !== undefined ? { workspace } : {}),
      createdAt: 1,
    });
    return id;
  }

  it("merges workspace sessions chronologically with session tags, excluding other workspaces", () => {
    const a = seed("/srv/ws");
    const b = seed("/srv/ws");
    seed("/srv/elsewhere");
    expect(appendSessionNote(store, a, "alpha note", NOW).ok).toBe(true);
    expect(appendSessionNote(store, b, "beta note", NOW + 1000).ok).toBe(true);

    const journal = buildWorkspaceJournal(store, { workspace: "/srv/ws" });
    expect(journal.schema).toBe(WORKSPACE_JOURNAL_SCHEMA);
    expect(journal.v).toBe(WORKSPACE_JOURNAL_VERSION);
    expect(journal.workspace).toBe("/srv/ws");
    expect(journal.sessionsScanned).toBe(2);
    expect(journal.sessionsSkippedArchived).toBe(0);
    // Entries from both sessions, globally chronological, tagged per session.
    const tagged = journal.entries.filter((e) => e.kind === "note");
    expect(tagged.map((e) => e.detail)).toEqual([
      "note added · alpha note",
      "note added · beta note",
    ]);
    expect(tagged.map((e) => e.sessionId)).toEqual([a, b]);
    expect(journal.entries.every((e) => e.shortId.length === 8)).toBe(true);
    // No other-workspace entries anywhere.
    expect(journal.entries.every((e) => e.sessionId === a || e.sessionId === b)).toBe(true);
    expect(journal.elided).toBe(0);
  });

  it("matches symlink-alias workspaces through the canonical identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-630u-alias-"));
    try {
      const realWs = path.join(root, "project");
      const aliasWs = path.join(root, "alias");
      fs.mkdirSync(realWs);
      fs.symlinkSync(realWs, aliasWs);
      const id = seed(aliasWs);
      expect(appendSessionNote(store, id, "alias note", NOW).ok).toBe(true);

      // Scope targets the real path; the alias-declared session still merges.
      const journal = buildWorkspaceJournal(store, { workspace: realWs });
      expect(journal.sessionsScanned).toBe(1);
      expect(journal.entries.some((e) => e.detail === "note added · alias note")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips archived sessions and tags corrupt sessions' readable entries", () => {
    const archived = seed("/srv/ws");
    store.writeArchived(archived, NOW);
    expect(appendSessionNote(store, archived, "retired note", NOW).ok).toBe(true);

    const corruptId = "corrupt-630";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "m", workspace: "/srv/ws", createdAt: 1 })}\n` +
        `{broken mid-file}\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "corrupt note", NOW).ok).toBe(true);

    const journal = buildWorkspaceJournal(store, { workspace: "/srv/ws" });
    expect(journal.sessionsScanned).toBe(1);
    expect(journal.sessionsSkippedArchived).toBe(1);
    expect(journal.entries.some((e) => e.detail === "note added · retired note")).toBe(false);
    const corruptEntries = journal.entries.filter((e) => e.sessionId === corruptId);
    expect(corruptEntries.length).toBeGreaterThan(0);
    expect(corruptEntries.every((e) => e.integrity === "corrupt")).toBe(true);
  });

  it("bounds rendering to the newest entries with a truthful elided count", () => {
    const id = seed("/srv/ws");
    for (let i = 0; i < 8; i++) {
      expect(appendSessionNote(store, id, `note ${i}`, NOW + i * 1000).ok).toBe(true);
    }
    const journal = buildWorkspaceJournal(store, { workspace: "/srv/ws", maxEntries: 5 });
    // 8 notes + created + last-activity = 10 entries; keep newest 5, elide 5.
    expect(journal.entries).toHaveLength(5);
    expect(journal.elided).toBe(5);
    // The kept window is the newest tail (oldest elided).
    const at = journal.entries.map((e) => e.at);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(journal.entries[0].at).toBeGreaterThan(NOW + 2_000);
  });

  it("renders the honest empty state and the elision note", () => {
    const empty = buildWorkspaceJournal(store, { workspace: "/srv/ws" });
    expect(empty.sessionsScanned).toBe(0);
    expect(empty.entries).toEqual([]);
    const text = formatWorkspaceJournal(empty).join("\n");
    expect(text).toContain("Workspace journal — /srv/ws");
    expect(text).toContain("Sessions merged: 0");
    expect(text).toContain("No journal entries for this workspace.");

    const id = seed("/srv/ws");
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, id, `n${i}`, NOW + i * 1000).ok).toBe(true);
    }
    const bounded = buildWorkspaceJournal(store, { workspace: "/srv/ws", maxEntries: 3 });
    const boundedText = formatWorkspaceJournal(bounded).join("\n");
    expect(boundedText).toContain("3 event(s) shown. (+3 older event(s) not shown)");
  });

  it("redacts secret-shaped workspace paths and keeps the store byte-identical", () => {
    const secret = ["ghp", "_", "w".repeat(24)].join("");
    const ws = `/srv/${secret}`;
    const id = seed(ws);
    expect(appendSessionNote(store, id, `note with ${secret}`, NOW).ok).toBe(true);

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    const journal = buildWorkspaceJournal(store, { workspace: ws });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
    expect(journal.workspace).not.toContain(secret);
    expect(JSON.stringify(journal)).not.toContain(secret);
  });
});
