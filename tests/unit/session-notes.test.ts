import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  appendSessionNote,
  readSessionNotes,
  buildSessionNotesRecord,
  formatSessionNotes,
  notesPath,
  SESSION_NOTES_MAX,
  SESSION_NOTE_MAX_CHARS,
} from "../../src/session-notes.js";

const NOW = 1_786_300_000_000;

describe("appendSessionNote (Issue #602)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-602u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 42 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends timestamped entries newest-first, preserving prior entries exactly", () => {
    const first = appendSessionNote(store, id, "first note", NOW);
    expect(first.ok).toBe(true);
    expect(first.recorded).toBe(1);
    expect(first.droppedNow).toBe(0);

    const second = appendSessionNote(store, id, "second note", NOW + 1000);
    expect(second.ok).toBe(true);
    expect(second.recorded).toBe(2);

    const load = readSessionNotes(store, id);
    expect(load.corrupt).toBe(false);
    expect(load.dropped).toBe(0);
    expect(load.notes).toEqual([
      { at: NOW + 1000, text: "second note" },
      { at: NOW, text: "first note" },
    ]);
  });

  it("bounds the ledger to the newest entries with a truthful dropped count", () => {
    for (let i = 0; i < SESSION_NOTES_MAX; i++) {
      expect(appendSessionNote(store, id, `note ${i}`, NOW + i).ok).toBe(true);
    }
    const overflow = appendSessionNote(store, id, "note overflow", NOW + 999);
    expect(overflow.ok).toBe(true);
    expect(overflow.recorded).toBe(SESSION_NOTES_MAX);
    expect(overflow.droppedNow).toBe(1);

    const load = readSessionNotes(store, id);
    expect(load.notes).toHaveLength(SESSION_NOTES_MAX);
    expect(load.dropped).toBe(1);
    // Newest kept; the oldest ("note 0") fell off.
    expect(load.notes[0].text).toBe("note overflow");
    expect(load.notes[SESSION_NOTES_MAX - 1].text).toBe("note 1");
    expect(load.notes.some((n) => n.text === "note 0")).toBe(false);
  });

  it("redacts secret-shaped text before persistence", () => {
    const secret = ["ghp", "_", "n".repeat(24)].join("");
    const result = appendSessionNote(store, id, `token ${secret} here`, NOW);
    expect(result.ok).toBe(true);
    const raw = fs.readFileSync(notesPath(store, id), "utf-8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    expect(readSessionNotes(store, id).notes[0].text).toContain("[REDACTED]");
  });

  it("sanitizes control characters and bounds long text", () => {
    const long = "x".repeat(SESSION_NOTE_MAX_CHARS + 100);
    const result = appendSessionNote(store, id, `a\u001b[31m ${long}`, NOW);
    expect(result.ok).toBe(true);
    const text = readSessionNotes(store, id).notes[0].text;
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThanOrEqual(SESSION_NOTE_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });

  it("rejects notes that sanitize to nothing", () => {
    const result = appendSessionNote(store, id, "   \u0000  ", NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("empty");
    expect(fs.existsSync(notesPath(store, id))).toBe(false);
  });

  it("fails closed for a missing session", () => {
    const result = appendSessionNote(store, "no-such-session", "hi", NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("was not found");
  });

  it("never overwrites an unreadable sidecar", () => {
    fs.writeFileSync(notesPath(store, id), "{not json\n");
    const before = fs.readFileSync(notesPath(store, id), "utf-8");
    const result = appendSessionNote(store, id, "hi", NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unreadable");
    expect(fs.readFileSync(notesPath(store, id), "utf-8")).toBe(before);
  });

  it("leaves transcript, goal, and name bytes untouched", () => {
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    store.writeName(id, "annotated work");
    const transcriptBefore = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    expect(appendSessionNote(store, id, "a note", NOW).ok).toBe(true);

    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);
  });

  it("annotates a corrupt session (integrity-agnostic metadata)", () => {
    const corruptId = "corrupt-602";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n`,
    );
    const result = appendSessionNote(store, corruptId, "note on corrupt", NOW);
    expect(result.ok).toBe(true);
    expect(readSessionNotes(store, corruptId).notes[0].text).toBe("note on corrupt");
  });
});

describe("buildSessionNotesRecord / formatSessionNotes (Issue #602)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-602u-view-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders entries newest-first with ISO timestamps and truthful counts", () => {
    appendSessionNote(store, id, "older note", NOW);
    appendSessionNote(store, id, "newer note", NOW + 5000);
    const record = buildSessionNotesRecord(store, id);
    expect(record.schema).toBe("oh-my-cli.session-notes");
    expect(record.v).toBe(1);
    expect(record.sessionId).toBe(id);
    expect(record.notes.map((n) => n.text)).toEqual(["newer note", "older note"]);
    expect(record.notes[0].at).toBe(new Date(NOW + 5000).toISOString());
    expect(record.dropped).toBe(0);
    expect(record.sidecarCorrupt).toBe(false);

    const text = formatSessionNotes(record).join("\n");
    expect(text).toContain("Session notes —");
    expect(text).toContain("newer note");
    expect(text.indexOf("newer note")).toBeLessThan(text.indexOf("older note"));
    expect(text).toContain("2 note(s).");
  });

  it("renders the honest empty state", () => {
    const record = buildSessionNotesRecord(store, id);
    expect(record.notes).toEqual([]);
    expect(record.sidecarCorrupt).toBe(false);
    expect(formatSessionNotes(record).join("\n")).toContain("No notes recorded for this session.");
  });

  it("reports an unreadable sidecar honestly without showing entries", () => {
    fs.writeFileSync(notesPath(store, id), "{not json\n");
    const record = buildSessionNotesRecord(store, id);
    expect(record.notes).toEqual([]);
    expect(record.sidecarCorrupt).toBe(true);
    expect(formatSessionNotes(record).join("\n")).toContain("unreadable");
  });
});
