import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/session.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-sess-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and loads a session", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "hello" });
    store.append(id, { role: "assistant", content: "hi there" });

    const messages = store.load(id);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello");
    expect(messages[1].role).toBe("assistant");
  });

  it("returns empty array for non-existent session", () => {
    expect(store.load("nonexistent").length).toBe(0);
  });

  it("tolerates incomplete trailing line", () => {
    const id = "test-trailing";
    const fp = path.join(tmpDir, `${id}.jsonl`);
    fs.writeFileSync(fp,
      JSON.stringify({ role: "user", content: "ok" }) + "\n" +
      '{"role":"assistant","con' + "\n",
    );

    const messages = store.load(id);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("ok");
  });

  it("stores tool calls and tool results", () => {
    const id = store.newId();
    store.append(id, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
    });
    store.append(id, { role: "tool", content: "file content", tool_call_id: "c1" });

    const messages = store.load(id);
    expect(messages.length).toBe(2);
    expect(messages[0].tool_calls?.length).toBe(1);
    expect(messages[1].tool_call_id).toBe("c1");
  });

  it("writes and reads metadata without surfacing it as a message", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/srv/proj", createdAt: 123 });
    store.append(id, { role: "user", content: "hello" });

    const meta = store.readMeta(id);
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe("fake-model");
    expect(meta!.workspace).toBe("/srv/proj");
    expect(meta!.createdAt).toBe(123);

    // The metadata line must not appear as a conversation message.
    const messages = store.load(id);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
  });

  it("round-trips the optional model profile in metadata", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "qwen-model", profile: "qwen", workspace: "/srv/proj", createdAt: 123 });
    const meta = store.readMeta(id);
    expect(meta!.profile).toBe("qwen");
    expect(meta!.model).toBe("qwen-model");
  });

  it("returns null metadata for a session created before metadata existed", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "legacy" });
    expect(store.readMeta(id)).toBeNull();
  });

  it("returns null metadata when the metadata line is corrupt", () => {
    const id = "bad-meta";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      '{"meta":true,"model":' + "\n" + JSON.stringify({ role: "user", content: "x" }) + "\n",
    );
    expect(store.readMeta(id)).toBeNull();
  });

  it("lists session ids and ignores non-jsonl files", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "x" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "not a session");
    fs.writeFileSync(path.join(tmpDir, `${id}.meta.json`), "{}");

    const ids = store.listIds();
    expect(ids).toEqual([id]);
  });

  it("flags mid-file corruption but recovers valid lines", () => {
    const id = "corrupt-mid";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: "a" }) + "\n" +
        "{not json}\n" +
        JSON.stringify({ role: "assistant", content: "b" }) + "\n",
    );
    const diag = store.loadWithDiagnostics(id);
    expect(diag.corrupt).toBe(true);
    expect(diag.messages.length).toBe(2);
    expect(diag.badLines).toBe(1);
  });

  it("treats a single trailing incomplete line as benign", () => {
    const id = "trailing";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: "a" }) + "\n" + '{"role":"assistant","con' + "\n",
    );
    const diag = store.loadWithDiagnostics(id);
    expect(diag.corrupt).toBe(false);
    expect(diag.messages.length).toBe(1);
  });

  it("reports a missing session as empty and not corrupt", () => {
    const diag = store.loadWithDiagnostics("does-not-exist");
    expect(diag.messages.length).toBe(0);
    expect(diag.corrupt).toBe(false);
    expect(diag.meta).toBeNull();
  });
});
