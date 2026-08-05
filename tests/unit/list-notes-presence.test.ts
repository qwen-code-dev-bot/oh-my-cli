import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { collectSessionSummaries, sessionListRecord, formatSessionList } from "../../src/session-summary.js";
import { appendSessionNote } from "../../src/session-notes.js";

const NOW = 1_700_700_000_000;

describe("list notes presence (Issue #624)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-624u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "notes fodder" }],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts durable notes and reports zero without notes", () => {
    expect(collectSessionSummaries(store)[0].noteCount).toBe(0);
    expect(appendSessionNote(store, id, "first note", NOW).ok).toBe(true);
    expect(appendSessionNote(store, id, "second note", NOW + 1).ok).toBe(true);
    expect(collectSessionSummaries(store)[0].noteCount).toBe(2);
  });

  it("reports honest absence for an unreadable notes sidecar", () => {
    fs.writeFileSync(path.join(dir, `${id}.notes.json`), "{not json\n");
    expect(collectSessionSummaries(store)[0].noteCount).toBe(0);
  });

  it("shows notes presence for a corrupt transcript session", () => {
    const corruptId = "corrupt-624";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "m", createdAt: 1 })}\n{broken mid-file\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "note on corrupt", NOW).ok).toBe(true);
    const summary = collectSessionSummaries(store).find((s) => s.id === corruptId)!;
    expect(summary.corrupt).toBe(true);
    expect(summary.noteCount).toBe(1);
  });

  it("includes noteCount in the record only when notes exist", () => {
    expect(appendSessionNote(store, id, "a note", NOW).ok).toBe(true);
    const withNotes = sessionListRecord(collectSessionSummaries(store));
    expect(withNotes.sessions[0].noteCount).toBe(1);

    const otherId = store.newId();
    store.checkpoint(otherId, [{ role: "user", content: "bare" }], { model: "m", createdAt: 1 });
    const bare = sessionListRecord(collectSessionSummaries(store));
    const bareEntry = bare.sessions.find((s) => s.id === otherId)!;
    expect(bareEntry.noteCount).toBeUndefined();
  });

  it("flags note-carrying sessions in the text listing", () => {
    expect(appendSessionNote(store, id, "one", NOW).ok).toBe(true);
    expect(appendSessionNote(store, id, "two", NOW + 1).ok).toBe(true);
    const summaries = collectSessionSummaries(store);
    expect(formatSessionList(summaries)).toContain("(2 notes)");
    expect(formatSessionList(summaries)).not.toContain("(2 note)");

    // Singular form.
    const oneDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-624u-one-"));
    try {
      const oneStore = new SessionStore(oneDir);
      const oneId = oneStore.newId();
      oneStore.checkpoint(oneId, [{ role: "user", content: "x" }], { model: "m", createdAt: 1 });
      expect(appendSessionNote(oneStore, oneId, "single", NOW).ok).toBe(true);
      expect(formatSessionList(collectSessionSummaries(oneStore))).toContain("(1 note)");
    } finally {
      fs.rmSync(oneDir, { recursive: true, force: true });
    }
  });

  it("keeps the store byte-identical through listing with notes", () => {
    expect(appendSessionNote(store, id, "breadcrumb", NOW).ok).toBe(true);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    collectSessionSummaries(store);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
