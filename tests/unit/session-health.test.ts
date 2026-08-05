import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionHealthReport,
  formatSessionHealthReport,
} from "../../src/session-health.js";

const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });

describe("session health report (Issue #666)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-666u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function healthySession(content: string): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    return id;
  }

  function writeTranscript(id: string, lines: string[]): void {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  }

  it("classifies healthy, partial, and corrupt sessions per the store's semantics", () => {
    const ok = healthySession("healthy body");
    const partial = "partial-src";
    writeTranscript(partial, [
      META,
      JSON.stringify({ role: "user", content: "before the tear" }),
      "{torn trailing write — not json",
    ]);
    const corrupt = "corrupt-src";
    writeTranscript(corrupt, [
      META,
      "{torn middle write — not json",
      JSON.stringify({ role: "user", content: "after the damage" }),
    ]);

    const report = buildSessionHealthReport(store);
    expect(report.sessionCount).toBe(3);
    expect(report.counts).toEqual({ ok: 1, partial: 1, corrupt: 1 });

    const byId = new Map(report.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get(ok)!.integrity).toBe("ok");
    expect(byId.get(ok)!.badLines).toBe(0);
    expect(byId.get(ok)!.messageCount).toBe(1);
    expect(byId.get(partial)!.integrity).toBe("partial");
    expect(byId.get(partial)!.badLines).toBe(1);
    expect(byId.get(partial)!.messageCount).toBe(1);
    expect(byId.get(corrupt)!.integrity).toBe("corrupt");
    expect(byId.get(corrupt)!.badLines).toBe(1);
    expect(byId.get(corrupt)!.messageCount).toBe(1);
  });

  it("orders worst-first with sessionId tie-break within a status", () => {
    const a = healthySession("a");
    const b = healthySession("b");
    const corrupt = "corrupt-src";
    writeTranscript(corrupt, [META, "{bad", JSON.stringify({ role: "user", content: "x" })]);
    const partial = "partial-src";
    writeTranscript(partial, [META, JSON.stringify({ role: "user", content: "x" }), "{bad"]);

    const report = buildSessionHealthReport(store);
    const order = report.sessions.map((s) => s.integrity);
    expect(order).toEqual(["corrupt", "partial", "ok", "ok"]);
    const oks = report.sessions.filter((s) => s.integrity === "ok").map((s) => s.sessionId);
    expect(oks).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
  });

  it("includes archived sessions and marks them", () => {
    const id = healthySession("archived body");
    store.writeArchived(id, 5);
    const report = buildSessionHealthReport(store);
    const entry = report.sessions.find((s) => s.sessionId === id);
    expect(entry!.archived).toBe(true);
    expect(entry!.integrity).toBe("ok");
    const text = formatSessionHealthReport(report).join("\n");
    expect(text).toContain("(archived)");
  });

  it("reports an empty store honestly", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-666u-empty-"));
    try {
      const report = buildSessionHealthReport(new SessionStore(emptyDir));
      expect(report.sessionCount).toBe(0);
      expect(report.counts).toEqual({ ok: 0, partial: 0, corrupt: 0 });
      expect(report.sessions).toEqual([]);
      const text = formatSessionHealthReport(report).join("\n");
      expect(text).toContain("0 session(s): 0 ok, 0 partial, 0 corrupt.");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("renders the rollup and worst-first per-session lines with damage detail", () => {
    healthySession("fine");
    const partial = "partial-src";
    writeTranscript(partial, [META, JSON.stringify({ role: "user", content: "x" }), "{bad"]);
    const report = buildSessionHealthReport(store);
    const lines = formatSessionHealthReport(report);
    expect(lines[0]).toBe("Session health report");
    expect(lines.some((l) => l === "2 session(s): 1 ok, 1 partial, 0 corrupt.")).toBe(true);
    // Worst-first: the partial line comes before the ok line, with detail.
    const partialIdx = lines.findIndex((l) => l.includes("— partial"));
    const okIdx = lines.findIndex((l) => l.includes("— ok"));
    expect(partialIdx).toBeGreaterThan(-1);
    expect(okIdx).toBeGreaterThan(-1);
    expect(partialIdx).toBeLessThan(okIdx);
    expect(lines[partialIdx]).toContain("(1 bad line(s), 1 message(s) parseable)");
    expect(lines[okIdx]).not.toContain("bad line");
  });

  it("keeps the store byte-identical through report reads", () => {
    healthySession("body one");
    const partial = "partial-src";
    writeTranscript(partial, [META, JSON.stringify({ role: "user", content: "x" }), "{bad"]);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionHealthReport(store);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
