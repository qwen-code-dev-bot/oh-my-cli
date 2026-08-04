import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import type { SessionSummary } from "../../src/session-summary.js";
import {
  orderSummariesPinnedFirst,
  sessionListRecord,
  formatSessionList,
  collectSessionSummaries,
} from "../../src/session-summary.js";
import { pinSession, unpinSession } from "../../src/session-pin.js";

const NOW = 1_786_600_000_000;

describe("pinSession / unpinSession (Issue #610)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-610u-"));
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

  it("pins with a durable timestamped marker and leaves other sidecars byte-identical", () => {
    store.writeName(id, "pinned work");
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    const transcriptBefore = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    const result = pinSession(store, id, NOW);
    expect(result.ok).toBe(true);
    expect(result.pinnedAt).toBe(NOW);
    expect(result.alreadyPinned).toBe(false);
    expect(store.readPinned(id)).toEqual({ pinned: true, at: NOW });

    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);

    const unpinned = unpinSession(store, id);
    expect(unpinned.ok).toBe(true);
    expect(unpinned.alreadyUnpinned).toBe(false);
    expect(store.readPinned(id)).toBeNull();
    expect(fs.existsSync(store.pinnedPath(id))).toBe(false);
  });

  it("is idempotent: re-pinning preserves the original timestamp", () => {
    expect(pinSession(store, id, NOW).ok).toBe(true);
    const again = pinSession(store, id, NOW + 999_999);
    expect(again.ok).toBe(true);
    expect(again.alreadyPinned).toBe(true);
    expect(again.pinnedAt).toBe(NOW);
    expect(store.readPinned(id)).toEqual({ pinned: true, at: NOW });

    const noop = unpinSession(store, id);
    expect(noop.ok).toBe(true);
    expect(unpinSession(store, id).alreadyUnpinned).toBe(true);
    expect(noop.alreadyUnpinned).toBe(false);
  });

  it("fails closed for a missing session", () => {
    expect(pinSession(store, "no-such-session", NOW).ok).toBe(false);
    expect(unpinSession(store, "no-such-session").ok).toBe(false);
  });

  it("pins a corrupt session (integrity-agnostic metadata)", () => {
    const corruptId = "corrupt-610";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const result = pinSession(store, corruptId, NOW);
    expect(result.ok).toBe(true);
    expect(store.readPinned(corruptId)).toEqual({ pinned: true, at: NOW });
  });
});

describe("pin-first ordering and listing (Issue #610)", () => {
  const mk = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
    id,
    messageCount: 1,
    userTurns: 1,
    assistantTurns: 0,
    toolCalls: 0,
    totalChars: 10,
    approxTokens: 3,
    createdAt: 0,
    lastModified: 0,
    ageMs: 0,
    corrupt: false,
    archived: false,
    pinned: false,
    ...over,
  });

  it("orders the pinned block first, preserving recency within each block", () => {
    // Input order is recency (what collectSessionSummaries produces).
    const summaries = [
      mk("newest"),
      mk("old-pinned", { pinned: true, pinnedAt: 5 }),
      mk("middle"),
      mk("older-pinned", { pinned: true, pinnedAt: 1 }),
      mk("oldest"),
    ];
    const ordered = orderSummariesPinnedFirst(summaries);
    expect(ordered.map((s) => s.id)).toEqual([
      "old-pinned",
      "older-pinned",
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("reports pinned counts and entry flags in the list record", () => {
    const summaries = [
      mk("a", { pinned: true, pinnedAt: 7 }),
      mk("b"),
    ];
    const rec = sessionListRecord(summaries);
    expect(rec.pinned).toBe(1);
    const a = rec.sessions.find((s) => s.id === "a");
    expect(a?.pinned).toBe(true);
    expect(a?.pinnedAt).toBe(7);
    const b = rec.sessions.find((s) => s.id === "b");
    expect(b?.pinned).toBeUndefined();
    expect(b?.pinnedAt).toBeUndefined();
  });

  it("flags pinned entries in the text listing", () => {
    const summaries = [mk("a", { pinned: true, pinnedAt: 7 }), mk("b")];
    const text = formatSessionList(summaries);
    expect(text).toContain("(pinned)");
    const pinnedLine = text.split("\n").find((l) => l.includes("(pinned)"));
    expect(pinnedLine).toContain("a");
  });
});

describe("collectSessionSummaries pinned field (Issue #610)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-610u-collect-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the pin marker with its timestamp", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    store.writePinned(id, NOW);
    const s: SessionSummary = collectSessionSummaries(store)[0];
    expect(s.pinned).toBe(true);
    expect(s.pinnedAt).toBe(NOW);

    store.clearPinned(id);
    const s2: SessionSummary = collectSessionSummaries(store)[0];
    expect(s2.pinned).toBe(false);
    expect(s2.pinnedAt).toBeUndefined();
  });
});
