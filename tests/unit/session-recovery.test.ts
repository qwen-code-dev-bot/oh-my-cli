import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage, SessionMeta } from "../../src/session.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const userMsg = (content: string): SessionMessage => ({ role: "user", content });
const assistantMsg = (content: string): SessionMessage => ({ role: "assistant", content });
const fullMeta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  meta: true,
  model: "fake-model",
  workspace: "/srv/proj",
  createdAt: 1234567890,
  ...over,
});

const readLines = (fp: string): string[] =>
  fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);

describe("SessionStore.checkpoint", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-recovery-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes meta + messages as valid JSONL and is loadable", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("hi"), assistantMsg("hello")], fullMeta());

    const lines = readLines(store.filePath(id));
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ meta: true, model: "fake-model" });
    expect(store.load(id)).toEqual([userMsg("hi"), assistantMsg("hello")]);
    expect(store.readMeta(id)).toMatchObject({ model: "fake-model" });
  });

  it("fully replaces the previous checkpoint instead of appending", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a"), assistantMsg("b")], fullMeta());
    store.checkpoint(id, [userMsg("c")], fullMeta());
    expect(store.load(id)).toEqual([userMsg("c")]);
  });

  it("leaves no temp file behind after a successful write", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a")], fullMeta());
    expect(fs.existsSync(store.tempPath(id))).toBe(false);
  });

  it("writes only messages when no meta is supplied", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a")]);
    const lines = readLines(store.filePath(id));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ role: "user", content: "a" });
  });

  it("accepts both full SessionMeta and Omit shapes identically", () => {
    const id1 = store.newId();
    const id2 = store.newId();
    store.checkpoint(id1, [userMsg("a")], fullMeta());
    store.checkpoint(id2, [userMsg("a")], {
      model: "fake-model",
      workspace: "/srv/proj",
      createdAt: 1234567890,
    });
    expect(store.readMeta(id1)).toEqual(store.readMeta(id2));
  });

  it("leaves the previous checkpoint intact if interrupted before the rename", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("old")], fullMeta());
    const oldBytes = fs.readFileSync(store.filePath(id));

    // Simulate a crash after the temp was fully written but before rename:
    fs.writeFileSync(
      store.tempPath(id),
      JSON.stringify(fullMeta({ model: "new-model" })) + "\n" + JSON.stringify(userMsg("new")) + "\n",
    );

    // The canonical is still the complete old checkpoint — never half-written.
    expect(fs.readFileSync(store.filePath(id)).equals(oldBytes)).toBe(true);
    expect(store.integrity(id).status).toBe("ok");

    // Recovery yields the new complete checkpoint: old or new, never half.
    expect(store.recover(id).action).toBe("promoted-temp");
    expect(store.load(id)).toEqual([userMsg("new")]);
    expect(store.integrity(id).status).toBe("ok");
  });
});

describe("SessionStore.integrity", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-integrity-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports missing for an absent session", () => {
    expect(store.integrity("nope")).toEqual({ status: "missing", messageCount: 0, badLines: 0 });
  });

  it("reports ok for a clean checkpoint", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a"), assistantMsg("b")], fullMeta());
    expect(store.integrity(id)).toEqual({ status: "ok", messageCount: 2, badLines: 0 });
  });

  it("reports partial for a single trailing incomplete line", () => {
    const id = "trailing";
    fs.writeFileSync(
      store.filePath(id),
      JSON.stringify(userMsg("a")) + "\n" + '{"role":"assis' + "\n",
    );
    const i = store.integrity(id);
    expect(i.status).toBe("partial");
    expect(i.badLines).toBe(1);
    expect(i.messageCount).toBe(1);
  });

  it("reports corrupt for a mid-file bad line", () => {
    const id = "mid";
    fs.writeFileSync(
      store.filePath(id),
      JSON.stringify(userMsg("a")) + "\n" + "not-json" + "\n" + JSON.stringify(assistantMsg("b")) + "\n",
    );
    const i = store.integrity(id);
    expect(i.status).toBe("corrupt");
    expect(i.badLines).toBe(1);
  });
});

describe("SessionStore.recover", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-recover-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op for a healthy session", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a")], fullMeta());
    expect(store.recover(id).action).toBe("none");
    expect(store.load(id)).toEqual([userMsg("a")]);
  });

  it("promotes a complete temp left by an interrupted checkpoint", () => {
    const id = store.newId();
    fs.writeFileSync(
      store.tempPath(id),
      JSON.stringify(fullMeta()) + "\n" + JSON.stringify(userMsg("recovered")) + "\n",
    );

    const r = store.recover(id);
    expect(r.action).toBe("promoted-temp");
    expect(fs.existsSync(store.tempPath(id))).toBe(false);
    expect(fs.existsSync(store.filePath(id))).toBe(true);
    expect(store.load(id)).toEqual([userMsg("recovered")]);
  });

  it("promotes a complete temp over a corrupt canonical", () => {
    const id = store.newId();
    fs.writeFileSync(store.filePath(id), "garbage\nmore garbage\n");
    fs.writeFileSync(store.tempPath(id), JSON.stringify(userMsg("good")) + "\n");

    const r = store.recover(id);
    expect(r.action).toBe("promoted-temp");
    expect(store.load(id)).toEqual([userMsg("good")]);
    expect(fs.existsSync(store.tempPath(id))).toBe(false);
  });

  it("discards a partial temp and keeps the previous canonical", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("keep")], fullMeta());
    fs.writeFileSync(
      store.tempPath(id),
      JSON.stringify(userMsg("partial")) + "\n" + '{"role":"assis' + "\n",
    );

    const r = store.recover(id);
    expect(r.action).toBe("discarded-temp");
    expect(fs.existsSync(store.tempPath(id))).toBe(false);
    expect(store.load(id)).toEqual([userMsg("keep")]);
  });

  it("discards an empty temp without disturbing the canonical", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("keep")], fullMeta());
    fs.writeFileSync(store.tempPath(id), "");

    expect(store.recover(id).action).toBe("discarded-temp");
    expect(store.load(id)).toEqual([userMsg("keep")]);
  });

  it("quarantines a corrupt canonical without deleting it", () => {
    const id = store.newId();
    const fp = store.filePath(id);
    fs.writeFileSync(
      fp,
      JSON.stringify(userMsg("a")) + "\n" + "broken" + "\n" + JSON.stringify(assistantMsg("b")) + "\n",
    );

    const r = store.recover(id);
    expect(r.action).toBe("quarantined");
    expect(r.quarantinePath).toBeDefined();
    expect(fs.existsSync(fp)).toBe(false);
    expect(fs.existsSync(r.quarantinePath!)).toBe(true);
    // Original bytes are preserved for inspection.
    expect(fs.readFileSync(r.quarantinePath!, "utf-8")).toContain("broken");
    // The session now starts fresh.
    expect(store.load(id)).toEqual([]);
  });

  it("never touches sibling sessions when recovering a corrupt one", () => {
    const bad = store.newId();
    const good = store.newId();
    store.checkpoint(good, [userMsg("sibling")], fullMeta());
    const goodBytes = fs.readFileSync(store.filePath(good));

    fs.writeFileSync(store.filePath(bad), "x\ny\n" + JSON.stringify(userMsg("z")) + "\n");

    expect(store.recover(bad).action).toBe("quarantined");
    expect(fs.readFileSync(store.filePath(good)).equals(goodBytes)).toBe(true);
    expect(store.load(good)).toEqual([userMsg("sibling")]);
  });

  it("is idempotent: a second recover after healing is a no-op", () => {
    const id = store.newId();
    fs.writeFileSync(
      store.filePath(id),
      JSON.stringify(userMsg("a")) + "\n" + "broken" + "\n" + JSON.stringify(assistantMsg("b")) + "\n",
    );
    expect(store.recover(id).action).toBe("quarantined");
    expect(store.recover(id).action).toBe("none");
  });

  it("does not surface temp or quarantine files via listIds", () => {
    const id = store.newId();
    store.checkpoint(id, [userMsg("a")], fullMeta());
    // Leave a stray temp and a quarantine sidecar in the directory.
    fs.writeFileSync(store.tempPath(id), JSON.stringify(userMsg("temp")) + "\n");
    fs.writeFileSync(store.filePath(id) + ".corrupt-1", "junk\n");

    expect(store.listIds()).toEqual([id]);
  });
});
