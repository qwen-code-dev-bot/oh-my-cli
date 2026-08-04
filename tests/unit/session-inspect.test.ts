import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionInspectRecord,
  formatSessionInspect,
  SESSION_INSPECT_SCHEMA,
  SESSION_INSPECT_VERSION,
} from "../../src/session-inspect.js";
import { appendCheckpoint } from "../../src/turn-checkpoint.js";
import { TURN_CHECKPOINT_SCHEMA, TURN_CHECKPOINT_VERSION } from "../../src/turn-checkpoint.js";
import { saveCompaction, COMPACTION_SCHEMA, COMPACTION_VERSION } from "../../src/compaction.js";
import { createTaskSnapshot } from "../../src/task-runtime.js";
import { appendFailureReceipt } from "../../src/failure-receipts.js";
import { appendSessionNote, notesPath } from "../../src/session-notes.js";

const NOW = 1_786_200_000_000;

describe("buildSessionInspectRecord (Issue #600)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-600u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      { model: "fake-model", profile: "p1", workspace: "/srv/ws", createdAt: 42 },
    );
    return id;
  }

  it("reports the health card of a fully-equipped session and leaves the store byte-identical", () => {
    const id = seed();
    store.writeName(id, "equipped work");
    store.writeGoal(id, {
      revision: 2,
      goal: { objective: "mission", status: "active", createdAt: 10, updatedAt: 20, title: "Mission" },
      history: [
        { revision: 1, kind: "set", objective: "mission", status: "active", at: 10 },
        { revision: 2, kind: "title", objective: "Mission", status: "active", at: 20 },
      ],
    });
    store.writeArchived(id, NOW);
    saveCompaction(store.compactPath(id), {
      schema: COMPACTION_SCHEMA,
      version: COMPACTION_VERSION,
      sourceDigest: "digest",
      messageCount: 2,
      activeTask: "task",
      decisions: [],
      pendingSteps: [],
      fileChanges: [],
      failures: [],
      receipts: [],
    });
    store.writeTasks(id, createTaskSnapshot({ sessionId: id, workspaceKey: "wk" }));
    appendCheckpoint(store, id, {
      schema: TURN_CHECKPOINT_SCHEMA,
      v: TURN_CHECKPOINT_VERSION,
      sessionId: id,
      turnIndex: 0,
      head: null,
      messageCountBefore: 1,
      messageCountAfter: 2,
      messages: [],
      files: [],
      digest: "d",
    });
    appendFailureReceipt(store, id, {
      command: "make build",
      status: 2,
      timedOut: false,
      stdout: "",
      stderr: "boom",
      cwd: "/srv/ws",
    });

    const snapshot = dirSnapshot();
    const record = buildSessionInspectRecord(store, id);

    // The inspection is read-only: nothing in the store changed.
    expect(dirSnapshot()).toEqual(snapshot);

    expect(record.schema).toBe(SESSION_INSPECT_SCHEMA);
    expect(record.v).toBe(SESSION_INSPECT_VERSION);
    expect(record.sessionId).toBe(id);
    expect(record.name).toBe("equipped work");
    expect(record.integrity).toEqual({ status: "ok", messageCount: 2, badLines: 0 });
    expect(record.meta).toEqual({
      model: "fake-model",
      profile: "p1",
      workspace: "/srv/ws",
      createdAt: 42,
    });
    const s = record.sidecars;
    expect(s.name).toBe(true);
    expect(s.goal).toBe(true);
    expect(s.goalStatus).toBe("active");
    expect(s.goalRevision).toBe(2);
    expect(s.goalHistory).toBe(2);
    expect(s.archived).toBe(true);
    expect(s.archivedAt).toBe(NOW);
    expect(s.compact).toBe(true);
    expect(s.tasks).toBe(true);
    expect(s.turnLog).toBe(true);
    expect(s.turnCheckpoints).toBe(1);
    expect(s.undoneTurn).toBe(false);
    expect(s.failures).toBe(true);
    expect(s.failureReceipts).toBe(1);
    expect(s.failuresCorrupt).toBe(false);
    // Verdict-derived hints: ok resume + unarchive.
    expect(record.hints.some((h) => h.startsWith(`resume: oh-my-cli --resume ${id}`))).toBe(true);
    expect(record.hints.some((h) => h.includes("--unarchive-session"))).toBe(true);
  });

  it("reports absent sidecars honestly as absent", () => {
    const id = seed();
    const record = buildSessionInspectRecord(store, id);
    expect(record.name).toBeUndefined();
    const s = record.sidecars;
    expect(s.name).toBe(false);
    expect(s.goal).toBe(false);
    expect(s.goalStatus).toBeUndefined();
    expect(s.archived).toBe(false);
    expect(s.archivedAt).toBeUndefined();
    expect(s.compact).toBe(false);
    expect(s.tasks).toBe(false);
    expect(s.turnLog).toBe(false);
    expect(s.turnCheckpoints).toBeUndefined();
    expect(s.failures).toBe(false);
    expect(s.failureReceipts).toBeUndefined();
    expect(record.hints).toEqual([`resume: oh-my-cli --resume ${id} -p "<prompt>"`]);
  });

  it("reports a corrupt session with its verdict, a salvage hint, and no quarantine", () => {
    const id = "corrupt-600";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const before = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");
    const record = buildSessionInspectRecord(store, id);
    expect(record.integrity.status).toBe("corrupt");
    expect(record.integrity.badLines).toBe(1);
    expect(record.integrity.messageCount).toBe(2);
    expect(record.hints.some((h) => h.includes("--salvage-session"))).toBe(true);
    // Inspecting never quarantines.
    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("reports a partial session with a heal-on-write hint", () => {
    const id = "partial-600";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{trailing torn line`,
    );
    const record = buildSessionInspectRecord(store, id);
    expect(record.integrity.status).toBe("partial");
    expect(record.hints.some((h) => h.includes("trailing torn line is tolerated"))).toBe(true);
  });

  it("redacts secret-shaped meta values", () => {
    const id = store.newId();
    const secret = ["ghp", "_", "m".repeat(24)].join("");
    store.checkpoint(id, [{ role: "user", content: "hi" }], {
      model: secret,
      workspace: "/srv/ws",
      createdAt: 1,
    });
    const record = buildSessionInspectRecord(store, id);
    expect(record.meta.model).not.toContain(secret);
    expect(record.meta.model).toContain("[REDACTED]");
  });

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snap.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    return snap;
  }
});

describe("formatSessionInspect (Issue #600)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-600u-fmt-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders the card with integrity, provenance, inventory, and hints", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 42,
    });
    store.writeName(id, "rendered work");
    const lines = formatSessionInspect(buildSessionInspectRecord(store, id));
    const text = lines.join("\n");
    expect(text).toContain("Session inspect —");
    expect(text).toContain("integrity:  ok · 1 message(s) · 0 bad line(s)");
    expect(text).toContain('name:       "rendered work"');
    expect(text).toContain("model fake-model");
    expect(text).toContain("repo /srv/ws");
    expect(text).toContain("sidecars:   name ✓ · goal ✗ · archived ✗ · compact ✗ · tasks ✗ · turn-log ✗ · failures ✗ · notes ✗");
    expect(text).toContain(`next:       resume: oh-my-cli --resume ${id} -p "<prompt>"`);
  });

  it("renders goal, archived, and failure details when present", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "paused", createdAt: 1, updatedAt: 2 },
    });
    store.writeArchived(id, NOW);
    appendFailureReceipt(store, id, {
      command: "npm test",
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "fail",
      cwd: "/srv/ws",
    });
    const text = formatSessionInspect(buildSessionInspectRecord(store, id)).join("\n");
    expect(text).toContain("goal:       paused · revision 1 · history 0 entries");
    expect(text).toContain("archived:   since");
    expect(text).toContain("failures ✓ (1 receipt(s))");
    expect(text).toContain("--unarchive-session");
  });

  it("renders notes presence with the exact entry count (Issue #608)", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    expect(appendSessionNote(store, id, "first note", NOW).ok).toBe(true);
    expect(appendSessionNote(store, id, "second note", NOW + 1000).ok).toBe(true);

    const record = buildSessionInspectRecord(store, id);
    expect(record.sidecars.notes).toBe(true);
    expect(record.sidecars.noteCount).toBe(2);
    expect(record.sidecars.notesCorrupt).toBe(false);

    const text = formatSessionInspect(record).join("\n");
    expect(text).toContain("notes ✓ (2 entries)");
  });

  it("renders an unreadable notes sidecar honestly and preserves it (Issue #608)", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    fs.writeFileSync(notesPath(store, id), "{not json\n");
    const before = fs.readFileSync(notesPath(store, id), "utf-8");

    const record = buildSessionInspectRecord(store, id);
    expect(record.sidecars.notes).toBe(true);
    expect(record.sidecars.noteCount).toBe(0);
    expect(record.sidecars.notesCorrupt).toBe(true);

    const text = formatSessionInspect(record).join("\n");
    expect(text).toContain("notes ✓ (unreadable sidecar)");
    // The unreadable sidecar is preserved untouched by the inspection.
    expect(fs.readFileSync(notesPath(store, id), "utf-8")).toBe(before);
  });
});
