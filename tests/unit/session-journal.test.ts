import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildSessionJournal, formatSessionJournal } from "../../src/session-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_700_000_000_000;

describe("buildSessionJournal (Issue #618)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-618u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "hello" }],
      { model: "fake-model", workspace: "/srv/ws", createdAt: CREATED_AT },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function entriesOf(): Array<{ at: number; kind: string; detail: string }> {
    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    return built.journal.entries;
  }

  it("assembles entries chronologically across all durable sources", () => {
    store.writeGoal(id, {
      revision: 2,
      goal: { objective: "mission", status: "paused", createdAt: CREATED_AT + 100, updatedAt: CREATED_AT + 300 },
      history: [
        { revision: 1, kind: "set", objective: "mission", status: "active", at: CREATED_AT + 100 },
        { revision: 2, kind: "pause", objective: "mission", status: "paused", at: CREATED_AT + 300 },
      ],
    });
    expect(appendSessionNote(store, id, "journal breadcrumb", CREATED_AT + 200).ok).toBe(true);
    store.writePinned(id, CREATED_AT + 400);
    store.writeArchived(id, CREATED_AT + 500);

    const entries = entriesOf();
    const kinds = entries.map((e) => e.kind);
    // Oldest first: created, goal set, note, goal pause, pinned, archived,
    // then last-activity (the transcript mtime is ~now, far after the rest).
    expect(kinds.slice(0, 6)).toEqual(["created", "goal", "note", "goal", "pinned", "archived"]);
    expect(kinds[kinds.length - 1]).toBe("last-activity");
    expect(entries.map((e) => e.at).slice(0, 6)).toEqual([
      CREATED_AT,
      CREATED_AT + 100,
      CREATED_AT + 200,
      CREATED_AT + 300,
      CREATED_AT + 400,
      CREATED_AT + 500,
    ]);
    expect(entries[1].detail).toContain("set · active · mission");
    expect(entries[2].detail).toContain("journal breadcrumb");
    expect(entries[5].detail).toContain("retired from discovery");
  });

  it("breaks equal timestamps deterministically by kind, then detail", () => {
    store.writePinned(id, CREATED_AT + 10);
    store.writeArchived(id, CREATED_AT + 10);
    const a = entriesOf().map((e) => e.kind);
    const b = entriesOf().map((e) => e.kind);
    expect(a).toEqual(b);
    // "archived" sorts before "pinned" at the same timestamp.
    const tied = a.filter((k) => k === "archived" || k === "pinned");
    expect(tied).toEqual(["archived", "pinned"]);
  });

  it("redacts secret-shaped goal objectives and note texts", () => {
    const secret = ["ghp", "_", "j".repeat(24)].join("");
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: `deploy with ${secret}`, status: "active", createdAt: CREATED_AT + 1, updatedAt: CREATED_AT + 1 },
      history: [
        { revision: 1, kind: "set", objective: `deploy with ${secret}`, status: "active", at: CREATED_AT + 1 },
      ],
    });
    expect(appendSessionNote(store, id, `note carrying ${secret}`, CREATED_AT + 2).ok).toBe(true);

    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    const rendered = formatSessionJournal(built.journal).join("\n");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("[REDACTED]");
    expect(JSON.stringify(built.journal)).not.toContain(secret);
  });

  it("unreadable goal and notes sidecars contribute nothing (honest absence)", () => {
    fs.writeFileSync(store.goalPath(id), "{not json\n");
    fs.writeFileSync(store.goalPath(id).replace(".goal.json", ".notes.json"), "{not json\n");
    store.writePinned(id, CREATED_AT + 5);

    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    const kinds = built.journal.entries.map((e) => e.kind);
    expect(kinds).not.toContain("goal");
    expect(kinds).not.toContain("note");
    expect(kinds).toContain("pinned");
  });

  it("journals a corrupt transcript with its markers and the corrupt verdict", () => {
    const corruptId = "corrupt-618";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "m", createdAt: CREATED_AT })}\n{broken mid-file\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    const store2 = new SessionStore(dir);
    store2.writeArchived(corruptId, CREATED_AT + 7);

    const built = buildSessionJournal(store2, corruptId);
    if ("error" in built) throw new Error(built.error);
    expect(built.journal.integrity).toBe("corrupt");
    const kinds = built.journal.entries.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("archived");
    expect(kinds).toContain("last-activity");
  });

  it("renders the honest minimal journal for a bare session", () => {
    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    const kinds = built.journal.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["created", "last-activity"]);
    const rendered = formatSessionJournal(built.journal).join("\n");
    expect(rendered).toContain("Session journal —");
    expect(rendered).toContain("(ok)");
    expect(rendered).toContain("session created");
    expect(rendered).toContain("2 event(s).");
  });

  it("returns an error for a missing session", () => {
    const built = buildSessionJournal(store, "no-such-session");
    expect("error" in built).toBe(true);
  });

  it("keeps the store byte-identical through a journal read", () => {
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    expect(appendSessionNote(store, id, "breadcrumb", CREATED_AT + 3).ok).toBe(true);
    store.writePinned(id, CREATED_AT + 4);

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionJournal(store, id);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
