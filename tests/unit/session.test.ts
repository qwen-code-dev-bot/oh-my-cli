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
});
