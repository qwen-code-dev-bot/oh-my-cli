import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildSessionDiff, formatSessionDiff } from "../../src/session-diff.js";
import { forkSession } from "../../src/session-fork.js";

describe("buildSessionDiff (Issue #622)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-622u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(id: string, contents: string[]): void {
    store.checkpoint(
      id,
      contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content })),
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1 },
    );
  }

  it("reports identical sessions with the full shared prefix and zero divergence", () => {
    seed("sess-a", ["one", "two", "three"]);
    seed("sess-b", ["one", "two", "three"]);
    const built = buildSessionDiff(store, "sess-a", "sess-b");
    if ("error" in built) throw new Error(built.error);
    const d = built.diff;
    expect(d.sharedPrefix).toBe(3);
    expect(d.aBeyond).toBe(0);
    expect(d.bBeyond).toBe(0);
    expect(d.aFirstDivergence).toBeNull();
    expect(d.bFirstDivergence).toBeNull();
    expect(d.forkRelationship).toBeNull();
    expect(formatSessionDiff(d).join("\n")).toContain("sessions are identical across all messages");
  });

  it("reports completely different sessions with zero shared messages", () => {
    seed("sess-a", ["alpha"]);
    seed("sess-b", ["beta"]);
    const built = buildSessionDiff(store, "sess-a", "sess-b");
    if ("error" in built) throw new Error(built.error);
    const d = built.diff;
    expect(d.sharedPrefix).toBe(0);
    expect(d.aBeyond).toBe(1);
    expect(d.bBeyond).toBe(1);
    expect(d.aFirstDivergence).toBe("alpha");
    expect(d.bFirstDivergence).toBe("beta");
  });

  it("reports a fork against its origin with provenance and the fork's additions", () => {
    seed("origin", ["base one", "base two"]);
    const forked = forkSession(store, "origin");
    expect(forked.ok).toBe(true);
    const forkId = forked.newSessionId!;
    store.append(forkId, { role: "user", content: "fork-only work" });

    const built = buildSessionDiff(store, "origin", forkId);
    if ("error" in built) throw new Error(built.error);
    const d = built.diff;
    expect(d.forkRelationship).toBe("b-forked-from-a");
    expect(d.sharedPrefix).toBe(2);
    expect(d.aBeyond).toBe(0);
    expect(d.bBeyond).toBe(1);
    expect(d.aFirstDivergence).toBeNull();
    expect(d.bFirstDivergence).toBe("fork-only work");
    expect(d.b.forkedFrom).toBe("origin");
    const text = formatSessionDiff(d).join("\n");
    expect(text).toContain("provenance: B is a fork of A");
    expect(text).toContain("first divergence B: fork-only work");
  });

  it("redacts and bounds first-divergence snippets", () => {
    const secret = ["ghp", "_", "d".repeat(24)].join("");
    seed("sess-a", [`diverge with ${secret}`]);
    seed("sess-b", ["something else"]);
    const built = buildSessionDiff(store, "sess-a", "sess-b");
    if ("error" in built) throw new Error(built.error);
    const d = built.diff;
    expect(d.aFirstDivergence).not.toContain(secret);
    expect(d.aFirstDivergence).toContain("[REDACTED]");
    expect(JSON.stringify(d)).not.toContain(secret);

    seed("long-a", ["x".repeat(500)]);
    seed("long-b", ["y"]);
    const longBuilt = buildSessionDiff(store, "long-a", "long-b");
    if ("error" in longBuilt) throw new Error(longBuilt.error);
    expect(longBuilt.diff.aFirstDivergence!.length).toBeLessThanOrEqual(120);
    expect(longBuilt.diff.aFirstDivergence!.endsWith("…")).toBe(true);
  });

  it("compares a corrupt session via its recoverable messages with the verdict visible", () => {
    seed("healthy", ["kept", "extra"]);
    fs.writeFileSync(
      path.join(dir, "corrupt.jsonl"),
      `${JSON.stringify({ meta: true, model: "fake-model", createdAt: 1 })}\n` +
        `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const built = buildSessionDiff(store, "healthy", "corrupt");
    if ("error" in built) throw new Error(built.error);
    const d = built.diff;
    expect(d.a.integrity).toBe("ok");
    expect(d.b.integrity).toBe("corrupt");
    // Recoverable messages: "kept" (user) and "after" (assistant).
    expect(d.b.messages).toBe(2);
    expect(d.sharedPrefix).toBe(1);
    expect(formatSessionDiff(d).join("\n")).toContain("(corrupt)");
  });

  it("keeps the store byte-identical through a comparison", () => {
    seed("sess-a", ["one"]);
    seed("sess-b", ["two"]);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionDiff(store, "sess-a", "sess-b");
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });

  it("returns an error for a missing session", () => {
    seed("sess-a", ["one"]);
    const built = buildSessionDiff(store, "sess-a", "no-such");
    expect("error" in built).toBe(true);
  });
});
