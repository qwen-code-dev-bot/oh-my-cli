import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/session.js";
import { collectSessionSummaries, formatSessionList } from "../../src/session-summary.js";
import type { SessionSummary } from "../../src/session-summary.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("session summary: collectSessionSummaries", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summary-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes a healthy session with metadata", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/srv/proj", createdAt: 1000 });
    store.append(id, { role: "system", content: "you are helpful" });
    store.append(id, { role: "user", content: "hello world" });
    store.append(id, {
      role: "assistant",
      content: "hi",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    store.append(id, { role: "tool", content: "result", tool_call_id: "c1" });

    const summaries = collectSessionSummaries(store, { now: () => 5000 });
    expect(summaries.length).toBe(1);
    const s = summaries[0];
    expect(s.id).toBe(id);
    expect(s.model).toBe("fake-model");
    expect(s.workspace).toBe("/srv/proj");
    expect(s.messageCount).toBe(4); // metadata line is not counted
    expect(s.userTurns).toBe(1);
    expect(s.assistantTurns).toBe(1);
    expect(s.toolCalls).toBe(1);
    expect(s.approxTokens).toBeGreaterThan(0);
    expect(s.corrupt).toBe(false);
  });

  it("lists a legacy session without metadata as unknown model/repo", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "legacy" });
    const s = collectSessionSummaries(store)[0];
    expect(s.model).toBeUndefined();
    expect(s.workspace).toBeUndefined();
    expect(s.createdAt).toBeNull();
    expect(s.messageCount).toBe(1);
    expect(s.corrupt).toBe(false);
  });

  it("marks a mid-file corrupt session corrupt while recovering valid lines", () => {
    const id = "corrupt-mid";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: "a" }) + "\n" +
        "{bad json}\n" +
        JSON.stringify({ role: "assistant", content: "b" }) + "\n",
    );
    const s = collectSessionSummaries(store).find((x) => x.id === id)!;
    expect(s.corrupt).toBe(true);
    expect(s.messageCount).toBe(2);
  });

  it("treats a single trailing incomplete line as benign", () => {
    const id = "trailing";
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: "a" }) + "\n" + '{"role":"assistant","con' + "\n",
    );
    const s = collectSessionSummaries(store).find((x) => x.id === id)!;
    expect(s.corrupt).toBe(false);
    expect(s.messageCount).toBe(1);
  });

  it("sorts most-recently-active first", () => {
    const older = "older-session";
    const newer = "newer-session";
    fs.writeFileSync(path.join(tmpDir, `${older}.jsonl`), JSON.stringify({ role: "user", content: "x" }) + "\n");
    fs.writeFileSync(path.join(tmpDir, `${newer}.jsonl`), JSON.stringify({ role: "user", content: "y" }) + "\n");
    const now = Date.now();
    fs.utimesSync(path.join(tmpDir, `${older}.jsonl`), new Date(now - 100_000), new Date(now - 100_000));
    fs.utimesSync(path.join(tmpDir, `${newer}.jsonl`), new Date(now), new Date(now));

    const summaries = collectSessionSummaries(store, { now: () => now });
    expect(summaries[0].id).toBe(newer);
    expect(summaries[1].id).toBe(older);
  });

  it("ignores non-jsonl files", () => {
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "ignore me");
    const id = store.newId();
    store.append(id, { role: "user", content: "hi" });
    expect(collectSessionSummaries(store).map((s) => s.id)).toEqual([id]);
  });

  it("does not modify session files while listing (read-only)", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "m", workspace: "/w", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    const fp = store.filePath(id);
    const before = fs.readFileSync(fp, "utf-8");
    const beforeMtime = fs.statSync(fp).mtimeMs;

    collectSessionSummaries(store);

    expect(fs.readFileSync(fp, "utf-8")).toBe(before);
    expect(fs.statSync(fp).mtimeMs).toBe(beforeMtime);
  });

  it("isolates one corrupt session from its healthy siblings", () => {
    const good = "good";
    const bad = "bad";
    fs.writeFileSync(path.join(tmpDir, `${good}.jsonl`), JSON.stringify({ role: "user", content: "ok" }) + "\n");
    fs.writeFileSync(path.join(tmpDir, `${bad}.jsonl`), "{totally not json}\n{still broken}\n");

    const summaries = collectSessionSummaries(store);
    expect(summaries.length).toBe(2);
    expect(summaries.find((s) => s.id === good)!.corrupt).toBe(false);
    expect(summaries.find((s) => s.id === bad)!.corrupt).toBe(true);
  });
});

describe("session summary: formatSessionList", () => {
  const mk = (over: Partial<SessionSummary>): SessionSummary => ({
    id: "x",
    messageCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    totalChars: 0,
    approxTokens: 0,
    model: "m",
    workspace: "/w",
    createdAt: 0,
    lastModified: 0,
    ageMs: 0,
    corrupt: false,
    ...over,
  });

  it("renders an empty list", () => {
    const out = formatSessionList([]);
    expect(out).toContain("Sessions");
    expect(out).toContain("No resumable sessions found.");
  });

  it("renders healthy and corrupt sessions with symbols and a summary", () => {
    const out = formatSessionList([
      mk({ id: "abc", messageCount: 4, userTurns: 1, assistantTurns: 1, toolCalls: 1, totalChars: 40, approxTokens: 10, model: "fake-model", workspace: "/srv/proj", ageMs: 5000 }),
      mk({ id: "def", messageCount: 2, userTurns: 1, assistantTurns: 1, model: undefined, workspace: undefined, ageMs: 60_000, corrupt: true }),
    ]);
    expect(out).toContain("✓ abc");
    expect(out).toContain("✗ def");
    expect(out).toContain("corrupt — partial recovery");
    expect(out).toContain("model fake-model");
    expect(out).toContain("repo /srv/proj");
    expect(out).toContain("model unknown");
    expect(out).toContain("repo unknown");
    expect(out).toMatch(/Summary: 1 resumable, 1 corrupt \(2 total\)/);
    expect(out).toContain("--resume");
  });

  it("redacts secret-like values in model and workspace", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const out = formatSessionList([mk({ model: `m ${token}`, workspace: `/srv/${token}` })]);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts the home prefix in workspace paths", () => {
    const home = process.env.HOME ?? "/root";
    const out = formatSessionList([mk({ workspace: `${home}/proj` })]);
    expect(out).not.toContain(`${home}/proj`);
    expect(out).toContain("~/proj");
  });

  it("formats age into human buckets", () => {
    expect(formatSessionList([mk({ ageMs: 5000 })])).toContain("last active 5s ago");
    expect(formatSessionList([mk({ ageMs: 5 * 60 * 1000 })])).toContain("last active 5m ago");
    expect(formatSessionList([mk({ ageMs: 5 * 60 * 60 * 1000 })])).toContain("last active 5h ago");
    expect(formatSessionList([mk({ ageMs: 5 * 24 * 60 * 60 * 1000 })])).toContain("last active 5d ago");
  });
});
