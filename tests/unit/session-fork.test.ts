import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { forkSession, resolveForkTarget } from "../../src/session-fork.js";

describe("forkSession (Issue #592)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-592u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedHealthy(opts: { goal?: boolean; name?: string } = {}): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
      { model: "fake-model", profile: "p1", workspace: "/srv/ws", createdAt: 42 },
    );
    if (opts.goal) {
      store.writeGoal(id, {
        revision: 2,
        goal: {
          objective: "continue the migration",
          status: "active",
          createdAt: 10,
          updatedAt: 20,
          title: "Migration",
        },
        history: [
          { revision: 1, kind: "set", objective: "continue the migration", status: "active", at: 10 },
          { revision: 2, kind: "title", objective: "Migration", status: "active", at: 20 },
        ],
      });
    }
    if (opts.name !== undefined) store.writeName(id, opts.name);
    return id;
  }

  it("forks the transcript verbatim with forkedFrom provenance and a fresh timeline", () => {
    const id = seedHealthy();
    const result = forkSession(store, id);
    expect(result.ok).toBe(true);
    expect(result.newSessionId).toBeTruthy();
    expect(result.newSessionId).not.toBe(id);
    expect(result.forkedMessages).toBe(2);
    expect(result.forkedGoal).toBe(false);

    // Messages are copied verbatim, in order.
    const forked = store.load(result.newSessionId!);
    expect(forked.map((m) => m.content)).toEqual(["first question", "first answer"]);

    // Meta inherits the source's identifiers, records provenance, and
    // declares its own timeline.
    const meta = store.readMeta(result.newSessionId!);
    expect(meta?.forkedFrom).toBe(id);
    expect(meta?.model).toBe("fake-model");
    expect(meta?.profile).toBe("p1");
    expect(meta?.workspace).toBe("/srv/ws");
    expect(meta?.createdAt).not.toBe(42);
    expect(typeof meta?.createdAt).toBe("number");
  });

  it("copies the durable Goal sidecar byte-for-byte when present", () => {
    const id = seedHealthy({ goal: true });
    const sourceGoalBytes = fs.readFileSync(store.goalPath(id), "utf-8");
    const result = forkSession(store, id);
    expect(result.ok).toBe(true);
    expect(result.forkedGoal).toBe(true);

    // Byte-identical copy on the fork.
    expect(fs.readFileSync(store.goalPath(result.newSessionId!), "utf-8")).toBe(sourceGoalBytes);
    // And it reads back as the same checkpoint.
    const goal = store.readGoal(result.newSessionId!);
    expect(goal.revision).toBe(2);
    expect(goal.goal?.objective).toBe("continue the migration");
    expect(goal.goal?.title).toBe("Migration");
    // The source's goal sidecar is untouched.
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(sourceGoalBytes);
  });

  it("creates no goal sidecar when the source has none", () => {
    const id = seedHealthy();
    const result = forkSession(store, id);
    expect(result.ok).toBe(true);
    expect(result.forkedGoal).toBe(false);
    expect(fs.existsSync(store.goalPath(result.newSessionId!))).toBe(false);
  });

  it("leaves the source byte-identical (transcript, goal, name) and unnamed fork unclaimed", () => {
    const id = seedHealthy({ goal: true, name: "original work" });
    const transcriptBefore = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    const result = forkSession(store, id);
    expect(result.ok).toBe(true);

    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);
    // The source's name is never inherited: names are user-owned per session.
    expect(store.readName(result.newSessionId!)).toBeNull();
  });

  it("refuses a corrupt source and creates nothing", () => {
    const id = "corrupt-src";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const idsBefore = store.listIds().length;
    const result = forkSession(store, id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("corrupt");
    expect(result.reason).toContain("--salvage-session");
    expect(store.listIds().length).toBe(idsBefore);
  });

  it("refuses a partial source (torn trailing line) rather than silently dropping it", () => {
    const id = "partial-src";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{trailing torn line`,
    );
    expect(store.integrity(id).status).toBe("partial");
    const idsBefore = store.listIds().length;
    const result = forkSession(store, id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resume it first");
    expect(store.listIds().length).toBe(idsBefore);
  });

  it("fails closed for a missing source", () => {
    const result = forkSession(store, "no-such-session");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("was not found");
  });

  it("leaves the fork healthy and resumable through the normal load path", () => {
    const id = seedHealthy({ goal: true });
    const result = forkSession(store, id);
    expect(result.ok).toBe(true);
    expect(store.integrity(result.newSessionId!).status).toBe("ok");
    expect(store.load(result.newSessionId!).length).toBe(2);
  });
});

describe("resolveForkTarget (Issue #592)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-592u-resolve-"));
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
    const resolved = resolveForkTarget("corrupt-target", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe("corrupt-target");
    // No heal side effects: the corrupt file is untouched, not quarantined.
    expect(fs.readFileSync(path.join(dir, "corrupt-target.jsonl"), "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("resolves a healthy session by name", () => {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    store.writeName(id, "named work");
    const resolved = resolveForkTarget("named work", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe(id);
  });

  it("fails closed on ambiguous name matches", () => {
    const a = store.newId();
    const b = store.newId();
    store.checkpoint(a, [{ role: "user", content: "a" }], { createdAt: 1 });
    store.checkpoint(b, [{ role: "user", content: "b" }], { createdAt: 1 });
    store.writeName(a, "shared");
    store.writeName(b, "shared");
    const resolved = resolveForkTarget("shared", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("2 sessions are named");
      expect(resolved.reason).toContain("fork by exact session id");
    }
  });

  it("fails closed for unknown values", () => {
    const resolved = resolveForkTarget("no-such-thing", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("no session named");
  });
});
