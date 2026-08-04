import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import {
  TURN_HISTORY_SCHEMA,
  TURN_HISTORY_VERSION,
  MAX_HISTORY_FILES_PER_TURN,
  buildTurnHistory,
  deriveFileChange,
  formatTurnHistory,
} from "../../src/turn-history.js";
import { appendCheckpoint } from "../../src/turn-checkpoint.js";
import type { TurnCheckpoint } from "../../src/turn-checkpoint.js";

const ANSI = /\x1b\[/;

function image(exists: boolean, content: string | null): { exists: boolean; sha256: string | null; content: string | null } {
  if (!exists) return { exists: false, sha256: null, content: null };
  return { exists: true, sha256: `sha-${content}`, content };
}

describe("deriveFileChange (Issue #568)", () => {
  it("derives created / deleted / modified and omits untouched files", () => {
    expect(
      deriveFileChange({ path: "a.ts", before: image(false, null), after: image(true, "one\ntwo") }),
    ).toEqual({ path: "a.ts", action: "created", added: 2, removed: 0 });

    expect(
      deriveFileChange({ path: "b.ts", before: image(true, "one\ntwo\nthree"), after: image(false, null) }),
    ).toEqual({ path: "b.ts", action: "deleted", added: 0, removed: 3 });

    expect(
      deriveFileChange({ path: "c.ts", before: image(true, "one\ntwo"), after: image(true, "one\nthree") }),
    ).toEqual({ path: "c.ts", action: "modified", added: 1, removed: 1 });

    // Identical content hashes mean the turn left the file untouched.
    expect(
      deriveFileChange({ path: "d.ts", before: { exists: true, sha256: "same", content: "x" }, after: { exists: true, sha256: "same", content: "x" } }),
    ).toBeNull();

    expect(deriveFileChange({ path: "e.ts", before: image(false, null), after: image(false, null) })).toBeNull();
  });

  it("counts created files with a trailing newline without an extra line", () => {
    expect(
      deriveFileChange({ path: "a.ts", before: image(false, null), after: image(true, "one\ntwo\n") }),
    ).toEqual({ path: "a.ts", action: "created", added: 2, removed: 0 });
  });

  it("computes order-independent line magnitude for modifications", () => {
    const change = deriveFileChange({
      path: "a.ts",
      before: image(true, "a\nb\nc\n"),
      after: image(true, "a\nc\nd\ne\n"),
    });
    expect(change).toEqual({ path: "a.ts", action: "modified", added: 2, removed: 1 });
  });
});

describe("buildTurnHistory (Issue #568)", () => {
  let homeDir: string;
  let store: SessionStore;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-568-"));
    store = new SessionStore(homeDir);
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function seedSession(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp/ws", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    return id;
  }

  function checkpoint(id: string, turnIndex: number, files: TurnCheckpoint["files"]): TurnCheckpoint {
    return {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId: id,
      turnIndex,
      head: "abc1234def5678",
      messageCountBefore: turnIndex,
      messageCountAfter: turnIndex + 3,
      messages: [],
      files,
      digest: `digest-${turnIndex}-0123456789ab`,
    };
  }

  it("reports 'none' when the session has no turn log", () => {
    const id = seedSession();
    const record = buildTurnHistory({ sessionId: id, store });
    expect(record.schema).toBe(TURN_HISTORY_SCHEMA);
    expect(record.v).toBe(TURN_HISTORY_VERSION);
    expect(record.logState).toBe("none");
    expect(record.entries).toEqual([]);
    expect(record.receipts).toEqual([]);
  });

  it("reports 'empty' when a turn log exists without readable checkpoints", () => {
    const id = seedSession();
    const logPath = store.filePath(id).replace(/\.jsonl$/, ".turn.json");
    fs.writeFileSync(logPath, JSON.stringify({ checkpoints: [] }) + "\n");
    const record = buildTurnHistory({ sessionId: id, store });
    expect(record.logState).toBe("empty");
  });

  it("renders per-turn provenance with derived file changes", () => {
    const id = seedSession();
    appendCheckpoint(
      store,
      id,
      checkpoint(id, 1, [
        { path: "src/a.ts", before: image(false, null), after: image(true, "one\ntwo") },
        { path: "src/b.ts", before: image(true, "x\ny"), after: image(true, "x\nz") },
        { path: "untouched.ts", before: { exists: true, sha256: "same", content: "q" }, after: { exists: true, sha256: "same", content: "q" } },
      ]),
    );
    appendCheckpoint(store, id, checkpoint(id, 2, [{ path: "src/a.ts", before: image(true, "one\ntwo"), after: image(false, null) }]));

    const record = buildTurnHistory({ sessionId: id, store });
    expect(record.logState).toBe("ok");
    expect(record.entries).toHaveLength(2);
    // Untouched files are omitted; the rest carry derived actions.
    expect(record.entries[0].files.map((f) => `${f.action}:${f.path}`)).toEqual([
      "created:src/a.ts",
      "modified:src/b.ts",
    ]);
    expect(record.entries[1].files[0]).toEqual({ path: "src/a.ts", action: "deleted", added: 0, removed: 2 });
    expect(record.entries[0].head).toBe("abc1234def5678");
    expect(record.entries[0].messagesBefore).toBe(1);
    expect(record.entries[0].messagesAfter).toBe(4);
  });

  it("bounds the file list per turn and counts the overflow", () => {
    const id = seedSession();
    const files = Array.from({ length: MAX_HISTORY_FILES_PER_TURN + 3 }, (_, i) => ({
      path: `f${String(i).padStart(2, "0")}.ts`,
      before: image(false, null),
      after: image(true, "line"),
    }));
    appendCheckpoint(store, id, checkpoint(id, 1, files));
    const record = buildTurnHistory({ sessionId: id, store });
    expect(record.entries[0].files.length).toBe(MAX_HISTORY_FILES_PER_TURN);
    expect(record.entries[0].omittedFiles).toBe(3);
  });

  it("never mutates the turn log or the session", () => {
    const id = seedSession();
    appendCheckpoint(store, id, checkpoint(id, 1, []));
    const logPath = store.filePath(id).replace(/\.jsonl$/, ".turn.json");
    const before = fs.readFileSync(logPath, "utf8") + fs.readFileSync(store.filePath(id), "utf8");
    buildTurnHistory({ sessionId: id, store });
    const after = fs.readFileSync(logPath, "utf8") + fs.readFileSync(store.filePath(id), "utf8");
    expect(after).toBe(before);
  });
});

describe("formatTurnHistory (Issue #568)", () => {
  let homeDir: string;
  let store: SessionStore;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-568f-"));
    store = new SessionStore(homeDir);
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function seedWithTurn(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp/ws", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    appendCheckpoint(store, id, {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId: id,
      turnIndex: 1,
      head: null,
      messageCountBefore: 1,
      messageCountAfter: 4,
      messages: [],
      files: [{ path: "a.ts", before: image(false, null), after: image(true, "TOP-SECRET-CONTENT-XYZ") }],
      digest: "digest-1-0123456789ab",
    });
    return id;
  }

  it("renders the explicit no-checkpoints state", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "m", workspace: "/w", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    const text = formatTurnHistory(buildTurnHistory({ sessionId: id, store })).join("\n");
    expect(text).toContain("No turn checkpoints recorded");
  });

  it("renders provenance lines without ANSI and deterministically", () => {
    const id = seedWithTurn();
    const once = formatTurnHistory(buildTurnHistory({ sessionId: id, store }));
    const twice = formatTurnHistory(buildTurnHistory({ sessionId: id, store }));
    expect(once.join("\n")).toBe(twice.join("\n"));
    const text = once.join("\n");
    expect(text).not.toMatch(ANSI);
    expect(text).toContain("Turn 1");
    expect(text).toContain("no git head");
    expect(text).toContain("messages 1 → 4");
    expect(text).toContain("[created]  a.ts (+1 lines)");
    expect(text).toContain("Undo state: none");
    expect(text).toContain("Receipts: none");
    // Provenance only — never file content.
    expect(text).not.toContain("TOP-SECRET-CONTENT-XYZ");
  });
});
