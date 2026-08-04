import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { salvageSession, resolveSalvageTarget } from "../../src/session-salvage.js";

describe("salvageSession (Issue #546)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-salvage-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function corruptSession(lines: string[]): string {
    const id = "corrupt-src";
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
    return id;
  }

  it("salvages every parseable message of a corrupt session in order, with provenance", () => {
    const id = corruptSession([
      JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 }),
      JSON.stringify({ role: "user", content: "first question" }),
      JSON.stringify({ role: "assistant", content: "first answer" }),
      "{torn write — not json",
      JSON.stringify({ role: "user", content: "after the damage" }),
    ]);
    const before = fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8");

    const result = salvageSession(store, id);
    expect(result.ok).toBe(true);
    expect(result.newSessionId).toBeTruthy();
    // Every parseable line is recovered (before and after the damage).
    expect(result.salvagedMessages).toBe(3);
    expect(result.skippedLines).toBe(1);

    // The salvaged session carries the messages verbatim, in order.
    const messages = store.load(result.newSessionId!);
    expect(messages.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "after the damage",
    ]);

    // Provenance is recorded in the salvaged session's meta.
    const meta = store.readMeta(result.newSessionId!);
    expect(meta?.salvagedFrom).toBe(id);
    expect(meta?.model).toBe("fake-model");
    expect(meta?.workspace).toBe("/srv/ws");
    expect(meta?.createdAt).toBe(42);

    // The source checkpoint is byte-identical.
    expect(fs.readFileSync(path.join(dir, `${id}.jsonl`), "utf-8")).toBe(before);
  });

  it("refuses a healthy session (nothing to salvage)", () => {
    const id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "hi" }],
      { model: "m", workspace: "/w", createdAt: 1 },
    );
    const result = salvageSession(store, id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nothing to salvage");
    expect(result.reason).toContain("--resume");
  });

  it("refuses a corrupt session with no recoverable content", () => {
    const id = corruptSession(["{broken", "{also broken"]);
    const result = salvageSession(store, id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no recoverable content");
  });

  it("fails closed for a missing session", () => {
    const result = salvageSession(store, "no-such-session");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("was not found");
  });

  it("leaves a salvaged session resumable through the normal load path", () => {
    // A mid-file bad line (with parseable content after it) is genuinely
    // corrupt; a trailing torn line would be "partial" and resumable as-is.
    const id = corruptSession([
      JSON.stringify({ role: "user", content: "kept before" }),
      "{damage mid-file",
      JSON.stringify({ role: "assistant", content: "kept after" }),
    ]);
    const result = salvageSession(store, id);
    expect(result.ok).toBe(true);
    expect(result.salvagedMessages).toBe(2);
    // loadSessionMessages-style read (load) returns the salvaged content.
    expect(store.load(result.newSessionId!).length).toBe(2);
    // The new session is healthy.
    expect(store.integrity(result.newSessionId!).status).toBe("ok");
  });

  it("refuses a partial session whose only damage is a trailing torn line", () => {
    const id = corruptSession([
      JSON.stringify({ role: "user", content: "kept" }),
      "{trailing torn line",
    ]);
    // Trailing torn line => "partial", loadable via --resume; nothing to salvage.
    expect(store.integrity(id).status).toBe("partial");
    const result = salvageSession(store, id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nothing to salvage");
  });
});

describe("resolveSalvageTarget (Issue #546)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-salvage-resolve-"));
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
    const resolved = resolveSalvageTarget("corrupt-target", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe("corrupt-target");
    // No heal side effects: the corrupt file is untouched, not quarantined.
    expect(fs.readFileSync(path.join(dir, "corrupt-target.jsonl"), "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("resolves a corrupt session by name, preferring corrupt matches", () => {
    writeCorrupt("named-corrupt");
    store.writeName("named-corrupt", "damaged work");
    const resolved = resolveSalvageTarget("damaged work", store);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.sessionId).toBe("named-corrupt");
  });

  it("fails closed on ambiguous corrupt name matches", () => {
    writeCorrupt("dup-a");
    writeCorrupt("dup-b");
    store.writeName("dup-a", "shared");
    store.writeName("dup-b", "shared");
    const resolved = resolveSalvageTarget("shared", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("2 corrupt sessions are named");
      // shortSessionId takes the first dash-segment ("dup" for both ids).
      expect(resolved.reason).toContain("dup");
      expect(resolved.reason).toContain("salvage by exact session id");
    }
  });

  it("refuses a name matching only healthy sessions", () => {
    const healthy = store.newId();
    store.checkpoint(healthy, [{ role: "user", content: "hi" }], { createdAt: 1 });
    store.writeName(healthy, "healthy work");
    const resolved = resolveSalvageTarget("healthy work", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("not corrupt");
      expect(resolved.reason).toContain("--resume");
    }
  });

  it("fails closed for unknown values", () => {
    const resolved = resolveSalvageTarget("no-such-thing", store);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("no session named");
  });
});
