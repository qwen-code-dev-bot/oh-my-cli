import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/session.js";
import {
  collectSessionSummaries,
  filterSessionSummaries,
  formatSessionList,
  formatSessionAge,
  pickContinueSession,
  sessionListRecord,
} from "../../src/session-summary.js";
import type { SessionSummary } from "../../src/session-summary.js";
import { workspaceTrustKey } from "../../src/folder-trust.js";
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

  it("carries user-owned session names from the store (Issue #530)", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "hi" });
    store.writeName(id, "auth refactor");
    const s = collectSessionSummaries(store).find((x) => x.id === id)!;
    expect(s.name).toBe("auth refactor");
  });

  it("leaves unnamed sessions without a name field", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "hi" });
    const s = collectSessionSummaries(store).find((x) => x.id === id)!;
    expect(s.name).toBeUndefined();
  });

  it("corrupt transcripts still carry their name sidecar (Issue #530)", () => {
    const id = "named-corrupt";
    fs.writeFileSync(path.join(tmpDir, `${id}.jsonl`), "{broken}\n{still broken}\n");
    store.writeName(id, "old experiment");
    const s = collectSessionSummaries(store).find((x) => x.id === id)!;
    expect(s.corrupt).toBe(true);
    expect(s.name).toBe("old experiment");
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
    expect(out).toContain("corrupt — salvage with --salvage-session");
    expect(out).toContain("model fake-model");
    expect(out).toContain("repo /srv/proj");
    expect(out).toContain("model unknown");
    expect(out).toContain("repo unknown");
    expect(out).toMatch(/Summary: 1 resumable, 1 corrupt \(2 total\)/);
    expect(out).toContain("--resume");
  });

  it("renders the user-owned name next to the id (Issue #530)", () => {
    const out = formatSessionList([mk({ id: "abc", name: "auth refactor" })]);
    expect(out).toContain('✓ abc  "auth refactor"');
  });

  it("renders unnamed sessions exactly as before (Issue #530)", () => {
    const out = formatSessionList([mk({ id: "abc" })]);
    expect(out).toContain("✓ abc");
    expect(out).not.toContain('abc  "');
  });

  it("redacts secret-shaped session names (Issue #530)", () => {
    const token = ["ghp", "_", "b".repeat(24)].join("");
    const out = formatSessionList([mk({ id: "abc", name: `release ${token}` })]);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("shows a corrupt session's name alongside the corrupt flag (Issue #530)", () => {
    const out = formatSessionList([mk({ id: "def", name: "old run", corrupt: true })]);
    expect(out).toContain('✗ def  "old run"  (corrupt — salvage with --salvage-session)');
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

describe("session summary: pickContinueSession (Issue #513)", () => {
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

  // Deterministic injected identity: sessions match when their declared
  // workspace carries the same injected key.
  const keyOf = (p: string): string => (p.startsWith("/ws-a") ? "key-a" : `key:${p}`);

  it("picks the most recent healthy session declared for the current workspace", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "other-ws", workspace: "/srv/elsewhere" }),
        mk({ id: "target", workspace: "/ws-a/project", model: "fake-model" }),
        mk({ id: "older-same-ws", workspace: "/ws-a/project" }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({
      ok: true,
      sessionId: "target",
      workspace: "/ws-a/project",
      model: "fake-model",
    });
  });

  it("never resumes another workspace's session", () => {
    const picked = pickContinueSession(
      [mk({ id: "elsewhere", workspace: "/srv/elsewhere" })],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "no-session" });
  });

  it("skips corrupt matches and still selects an older healthy one", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "corrupt-new", workspace: "/ws-a/project", corrupt: true }),
        mk({ id: "healthy-old", workspace: "/ws-a/project" }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({
      ok: true,
      sessionId: "healthy-old",
      workspace: "/ws-a/project",
      model: "m",
    });
  });

  it("fails closed naming corruption when only corrupt sessions match", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "corrupt-1", workspace: "/ws-a/project", corrupt: true }),
        mk({ id: "corrupt-2", workspace: "/ws-a/project", corrupt: true }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "only-corrupt" });
  });

  it("excludes sessions without workspace metadata", () => {
    const picked = pickContinueSession(
      [mk({ id: "legacy", workspace: undefined })],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "no-session" });
  });

  it("reports no-session for an empty list", () => {
    expect(pickContinueSession([], "key-a", keyOf)).toEqual({ ok: false, reason: "no-session" });
  });

  it("matches a symlink alias of the current workspace via canonical identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continue-alias-"));
    const realWs = path.join(root, "project");
    const aliasWs = path.join(root, "alias");
    fs.mkdirSync(realWs);
    fs.symlinkSync(realWs, aliasWs);
    try {
      // A session declared for the alias must match when continuing from the
      // real path: both collapse to one canonical workspace identity.
      const summaries = [mk({ id: "s1", workspace: aliasWs })];
      const picked = pickContinueSession(summaries, workspaceTrustKey(realWs));
      expect(picked.ok).toBe(true);
      if (picked.ok) expect(picked.sessionId).toBe("s1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session summary: pickContinueSession discovery semantics (Issue #616)", () => {
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
    archived: false,
    pinned: false,
    ...over,
  });

  const keyOf = (p: string): string => (p.startsWith("/ws-a") ? "key-a" : `key:${p}`);

  it("never picks an archived session, even the newest match", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "archived-newest", workspace: "/ws-a/project", archived: true }),
        mk({ id: "healthy-old", workspace: "/ws-a/project" }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({
      ok: true,
      sessionId: "healthy-old",
      workspace: "/ws-a/project",
      model: "m",
    });
  });

  it("reports no-session when the only match is archived", () => {
    const picked = pickContinueSession(
      [mk({ id: "only-archived", workspace: "/ws-a/project", archived: true })],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "no-session" });
  });

  it("unarchiving restores eligibility", () => {
    const archived = mk({ id: "s", workspace: "/ws-a/project", archived: true });
    expect(pickContinueSession([archived], "key-a", keyOf).ok).toBe(false);
    const restored = mk({ id: "s", workspace: "/ws-a/project", archived: false });
    const picked = pickContinueSession([restored], "key-a", keyOf);
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe("s");
  });

  it("prefers a pinned older session over a newer unpinned one", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "newer-unpinned", workspace: "/ws-a/project" }),
        mk({ id: "older-pinned", workspace: "/ws-a/project", pinned: true }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe("older-pinned");
  });

  it("among several pinned candidates the most recently modified wins", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "pinned-newest", workspace: "/ws-a/project", pinned: true }),
        mk({ id: "pinned-older", workspace: "/ws-a/project", pinned: true }),
        mk({ id: "unpinned", workspace: "/ws-a/project" }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe("pinned-newest");
  });

  it("unpinning restores pure recency", () => {
    const summaries = [
      mk({ id: "newer", workspace: "/ws-a/project" }),
      mk({ id: "older", workspace: "/ws-a/project" }),
    ];
    const picked = pickContinueSession(summaries, "key-a", keyOf);
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe("newer");
  });

  it("archive prevails over pinning", () => {
    const picked = pickContinueSession(
      [
        mk({ id: "pinned-but-archived", workspace: "/ws-a/project", pinned: true, archived: true }),
        mk({ id: "plain", workspace: "/ws-a/project" }),
      ],
      "key-a",
      keyOf,
    );
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe("plain");
  });

  it("a corrupt-and-archived session counts toward neither pick nor only-corrupt", () => {
    const picked = pickContinueSession(
      [mk({ id: "corrupt-archived", workspace: "/ws-a/project", corrupt: true, archived: true })],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "no-session" });
  });

  it("pinning never overrides workspace scope", () => {
    const picked = pickContinueSession(
      [mk({ id: "foreign-pinned", workspace: "/srv/elsewhere", pinned: true })],
      "key-a",
      keyOf,
    );
    expect(picked).toEqual({ ok: false, reason: "no-session" });
  });
});

describe("session summary: sessionListRecord (Issue #542)", () => {
  const mk = (over: Partial<SessionSummary>): SessionSummary => ({
    id: "01234567-89ab-cdef-0123-456789abcdef",
    messageCount: 4,
    userTurns: 2,
    assistantTurns: 2,
    toolCalls: 1,
    totalChars: 40,
    approxTokens: 10,
    model: "fake-model",
    workspace: "/srv/proj",
    createdAt: 0,
    lastModified: 1000,
    ageMs: 5000,
    corrupt: false,
    ...over,
  });

  it("wraps summaries in the versioned oh-my-cli.sessions record with totals", () => {
    const rec = sessionListRecord([
      mk({ id: "a" }),
      mk({ id: "b", corrupt: true }),
    ]);
    expect(rec.schema).toBe("oh-my-cli.sessions");
    expect(rec.v).toBe(1);
    expect(rec.total).toBe(2);
    expect(rec.resumable).toBe(1);
    expect(rec.corrupt).toBe(1);
    expect(rec.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    const a = rec.sessions[0];
    expect(a.messageCount).toBe(4);
    expect(a.userTurns).toBe(2);
    expect(a.assistantTurns).toBe(2);
    expect(a.toolCalls).toBe(1);
    expect(a.approxTokens).toBe(10);
    expect(a.lastModified).toBe(1000);
    expect(a.ageMs).toBe(5000);
    expect(a.corrupt).toBe(false);
    expect(rec.sessions[1].corrupt).toBe(true);
  });

  it("redacts secret-shaped names and models, and collapses home in workspaces", () => {
    const nameSecret = ["ghp", "_", "d".repeat(24)].join("");
    const modelSecret = ["ghp", "_", "e".repeat(24)].join("");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sessions-rec-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const rec = sessionListRecord([
        mk({
          id: "x",
          name: `release ${nameSecret}`,
          model: modelSecret,
          workspace: path.join(home, "proj"),
        }),
      ]);
      const entry = rec.sessions[0];
      expect(JSON.stringify(entry)).not.toContain(nameSecret);
      expect(JSON.stringify(entry)).not.toContain(modelSecret);
      expect(entry.name).toContain("[REDACTED]");
      expect(entry.model).toContain("[REDACTED]");
      expect(entry.workspace).toBe("~/proj");
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits name when unset and reports unknown provenance like the text view", () => {
    const rec = sessionListRecord([mk({ id: "y", model: undefined, workspace: undefined })]);
    const entry = rec.sessions[0];
    expect(entry.name).toBeUndefined();
    expect(entry.model).toBe("unknown");
    expect(entry.workspace).toBe("unknown");
  });

  it("serializes an empty store as an empty record", () => {
    const rec = sessionListRecord([]);
    expect(rec.total).toBe(0);
    expect(rec.resumable).toBe(0);
    expect(rec.corrupt).toBe(0);
    expect(rec.sessions).toEqual([]);
    const parsed = JSON.parse(JSON.stringify(rec));
    expect(parsed).toEqual(rec);
  });
});

describe("session summary: filterSessionSummaries (Issue #548)", () => {
  const mk = (over: Partial<SessionSummary>): SessionSummary => ({
    id: "00000000-0000-0000-0000-000000000000",
    messageCount: 1,
    userTurns: 1,
    assistantTurns: 0,
    toolCalls: 0,
    totalChars: 10,
    approxTokens: 3,
    model: "fake-model",
    workspace: "/srv/proj",
    createdAt: 0,
    lastModified: 1000,
    ageMs: 5000,
    corrupt: false,
    ...over,
  });

  const alpha = mk({ id: "alpha-1111", name: "Auth Refactor", model: "model-a", workspace: "/srv/alpha" });
  const beta = mk({ id: "beta-2222", name: "Docs Pass", model: "model-b", workspace: "/srv/beta" });

  it("passes everything through on an empty or blank query", () => {
    expect(filterSessionSummaries([alpha, beta], "")).toEqual([alpha, beta]);
    expect(filterSessionSummaries([alpha, beta], "   ")).toEqual([alpha, beta]);
  });

  it("matches by name, id, model, and workspace (case-insensitive substring)", () => {
    expect(filterSessionSummaries([alpha, beta], "auth").map((s) => s.id)).toEqual(["alpha-1111"]);
    expect(filterSessionSummaries([alpha, beta], "AUTH").map((s) => s.id)).toEqual(["alpha-1111"]);
    expect(filterSessionSummaries([alpha, beta], "beta-22").map((s) => s.id)).toEqual(["beta-2222"]);
    expect(filterSessionSummaries([alpha, beta], "model-b").map((s) => s.id)).toEqual(["beta-2222"]);
    expect(filterSessionSummaries([alpha, beta], "/srv/alpha").map((s) => s.id)).toEqual(["alpha-1111"]);
  });

  it("preserves order and returns multiple matches", () => {
    const both = filterSessionSummaries([alpha, beta], "model-");
    expect(both.map((s) => s.id)).toEqual(["alpha-1111", "beta-2222"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterSessionSummaries([alpha, beta], "zzz-no-match")).toEqual([]);
  });

  it("handles summaries with missing optional fields", () => {
    const bare = mk({ id: "bare-3333", name: undefined, model: undefined, workspace: undefined });
    expect(filterSessionSummaries([bare], "bare-3333").map((s) => s.id)).toEqual(["bare-3333"]);
    expect(filterSessionSummaries([bare], "anything-else")).toEqual([]);
  });
});

// --- formatSessionAge negative-elapsed clamp (Issue #810) -------------------

describe("formatSessionAge negative-elapsed clamp (Issue #810)", () => {
  it("renders a non-negative age for negative elapsed ms (clock skew)", () => {
    expect(formatSessionAge(-5000)).toBe("0s ago");
    expect(formatSessionAge(-1)).toBe("0s ago");
  });

  it("leaves positive age output unchanged (regression)", () => {
    expect(formatSessionAge(0)).toBe("0s ago");
    expect(formatSessionAge(5000)).toBe("5s ago");
    expect(formatSessionAge(95000)).toBe("1m ago");
  });
});
