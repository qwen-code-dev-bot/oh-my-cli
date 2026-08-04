import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import type { SessionSummary } from "../../src/session-summary.js";
import {
  collectSessionSummaries,
  pickContinueSession,
  sessionListRecord,
  formatSessionList,
} from "../../src/session-summary.js";
import { collectSessionPickerRows } from "../../src/session-picker.js";
import { searchSessions } from "../../src/session-search.js";
import { archiveSession, unarchiveSession, resolveArchiveTarget } from "../../src/session-archive.js";

const NOW = 1_786_100_000_000;

describe("archiveSession / unarchiveSession (Issue #598)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(opts: { goal?: boolean; name?: string } = {}): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 42 },
    );
    if (opts.goal) {
      store.writeGoal(id, {
        revision: 1,
        goal: { objective: "mission", status: "active", createdAt: 10, updatedAt: 20 },
      });
    }
    if (opts.name !== undefined) store.writeName(id, opts.name);
    return id;
  }

  it("archives with a durable timestamped marker and leaves the source byte-identical", () => {
    const id = seed({ goal: true, name: "kept work" });
    const transcriptBefore = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    const result = archiveSession(store, id, NOW);
    expect(result.ok).toBe(true);
    expect(result.archivedAt).toBe(NOW);
    expect(result.alreadyArchived).toBe(false);

    // The marker exists with its timestamp.
    expect(store.readArchived(id)).toEqual({ archived: true, at: NOW });
    // Transcript, goal, and name sidecars are untouched.
    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);
  });

  it("is idempotent: re-archiving preserves the original timestamp", () => {
    const id = seed();
    expect(archiveSession(store, id, NOW).archivedAt).toBe(NOW);
    const again = archiveSession(store, id, NOW + 999_999);
    expect(again.ok).toBe(true);
    expect(again.alreadyArchived).toBe(true);
    expect(again.archivedAt).toBe(NOW);
    expect(store.readArchived(id)).toEqual({ archived: true, at: NOW });
  });

  it("unarchives by removing the marker and is a no-op when not archived", () => {
    const id = seed();
    archiveSession(store, id, NOW);
    const restored = unarchiveSession(store, id);
    expect(restored.ok).toBe(true);
    expect(restored.alreadyUnarchived).toBe(false);
    expect(store.readArchived(id)).toBeNull();
    expect(fs.existsSync(store.archivedPath(id))).toBe(false);

    const noop = unarchiveSession(store, id);
    expect(noop.ok).toBe(true);
    expect(noop.alreadyUnarchived).toBe(true);
  });

  it("archives a corrupt session (the marker is integrity-agnostic)", () => {
    const id = "corrupt-598";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    expect(store.integrity(id).status).toBe("corrupt");
    const result = archiveSession(store, id, NOW);
    expect(result.ok).toBe(true);
    expect(store.readArchived(id)).toEqual({ archived: true, at: NOW });
  });

  it("fails closed for a missing session", () => {
    expect(archiveSession(store, "no-such-session", NOW).ok).toBe(false);
    expect(unarchiveSession(store, "no-such-session").ok).toBe(false);
  });
});

describe("discovery surfaces honor the archive marker (Issue #598)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598u-disc-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(workspace: string): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "needle content" }],
      { model: "fake-model", workspace, createdAt: 1 },
    );
    return id;
  }

  it("flags archived summaries and hides them from the picker rows", () => {
    const visible = seed("/srv/ws");
    const retired = seed("/srv/ws");
    archiveSession(store, retired, NOW);

    const summaries = collectSessionSummaries(store);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    expect(byId.get(visible)?.archived).toBe(false);
    expect(byId.get(retired)?.archived).toBe(true);

    const rows = collectSessionPickerRows(store);
    expect(rows.map((r) => r.id)).toEqual([visible]);
  });

  it("skips archived sessions in transcript search", () => {
    const visible = seed("/srv/ws");
    const retired = seed("/srv/ws");
    archiveSession(store, retired, NOW);

    const record = searchSessions(store, "needle");
    expect(record.sessionsScanned).toBe(1);
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(visible);
  });

  it("never lets --continue pick an archived session", () => {
    const retired = seed("/srv/ws");
    archiveSession(store, retired, NOW);
    // The --continue wiring filters archived summaries before picking.
    const summaries = collectSessionSummaries(store).filter((s) => !s.archived);
    expect(pickContinueSession(summaries, "K", () => "K")).toEqual({
      ok: false,
      reason: "no-session",
    });

    const active = seed("/srv/ws");
    const withActive = collectSessionSummaries(store).filter((s) => !s.archived);
    const picked = pickContinueSession(withActive, "K", () => "K");
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.sessionId).toBe(active);
  });

  it("reports hidden counts and flagged entries in the list record and text", () => {
    const visible = seed("/srv/ws");
    const retired = seed("/srv/ws");
    archiveSession(store, retired, NOW);

    const summaries = collectSessionSummaries(store);
    const visibleSummaries = summaries.filter((s) => !s.archived);
    const archivedHidden = summaries.length - visibleSummaries.length;

    // Default mode: hidden count recorded, entries not present.
    const record = sessionListRecord(visibleSummaries, undefined, archivedHidden);
    expect(record.archivedHidden).toBe(1);
    expect(record.sessions.map((s) => s.id)).toEqual([visible]);
    const text = formatSessionList(visibleSummaries, undefined, archivedHidden);
    expect(text).toContain("1 archived session(s) hidden — use --include-archived");

    // Include mode: flagged entries, no hidden count.
    const included = sessionListRecord(summaries, undefined, 0);
    expect("archivedHidden" in included).toBe(false);
    const retiredEntry = included.sessions.find((s) => s.id === retired);
    expect(retiredEntry?.archived).toBe(true);
    const includedText = formatSessionList(summaries, undefined, 0);
    expect(includedText).toContain("(archived)");
    expect(includedText).not.toContain("hidden");

    // No archived sessions: byte-compatible with today's output.
    const plain = sessionListRecord(visibleSummaries, undefined, 0);
    expect("archivedHidden" in plain).toBe(false);
    expect(formatSessionList(visibleSummaries, undefined, 0)).toBe(
      formatSessionList(visibleSummaries),
    );
  });
});

describe("SessionSummary archived field defaults (Issue #598)", () => {
  it("is false for sessions without a marker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598u-default-"));
    try {
      const store = new SessionStore(dir);
      const id = store.newId();
      store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
      const s: SessionSummary = collectSessionSummaries(store)[0];
      expect(s.archived).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveArchiveTarget (Issue #598)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598u-resolve-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeCorrupt(id: string): void {
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
  }

  it("resolves a corrupt session by exact id without quarantining it", () => {
    writeCorrupt("corrupt-target");
    const before = fs.readFileSync(path.join(dir, "corrupt-target.jsonl"), "utf-8");
    const resolved = resolveArchiveTarget("corrupt-target", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe("corrupt-target");
    // No heal side effects: the corrupt file is untouched, not quarantined.
    expect(fs.readFileSync(path.join(dir, "corrupt-target.jsonl"), "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("resolves by user-owned name, including corrupt matches", () => {
    writeCorrupt("named-corrupt");
    store.writeName("named-corrupt", "retired work");
    const healthy = store.newId();
    store.checkpoint(healthy, [{ role: "user", content: "hi" }], { createdAt: 1 });
    store.writeName(healthy, "other work");

    const resolved = resolveArchiveTarget("retired work", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe("named-corrupt");
  });

  it("fails closed on ambiguous name matches", () => {
    const a = store.newId();
    const b = store.newId();
    store.checkpoint(a, [{ role: "user", content: "a" }], { createdAt: 1 });
    store.checkpoint(b, [{ role: "user", content: "b" }], { createdAt: 1 });
    store.writeName(a, "shared");
    store.writeName(b, "shared");
    const resolved = resolveArchiveTarget("shared", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("2 sessions are named");
      expect(resolved.reason).toContain("resolve by exact session id");
    }
  });

  it("fails closed for unknown values", () => {
    const resolved = resolveArchiveTarget("no-such-thing", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("no session named");
  });
});
