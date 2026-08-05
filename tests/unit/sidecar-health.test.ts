import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";
import {
  buildSessionHealthReport,
  damagedSidecars,
  formatSessionHealthReport,
} from "../../src/session-health.js";

const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });

describe("sidecar health diagnostics (Issue #668)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-668u-"));
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

  function corruptFile(p: string): void {
    fs.writeFileSync(p, "{torn sidecar json — not parseable");
  }

  it("reports no damaged sidecars for healthy or absent sidecars", () => {
    const plain = healthySession("plain");
    expect(damagedSidecars(store, plain)).toEqual([]);

    const rich = healthySession("rich");
    store.writeName(rich, "named session");
    store.writeGoal(rich, {
      revision: 1,
      goal: { objective: "o", status: "active", createdAt: 1, updatedAt: 1 },
      history: [{ revision: 1, kind: "set", objective: "o", status: "active", at: 1 }],
    });
    expect(appendSessionNote(store, rich, "a note", 2).ok).toBe(true);
    store.writePinned(rich, 3);
    expect(damagedSidecars(store, rich)).toEqual([]);
  });

  it("reports each damaged sidecar, in fixed canonical order", () => {
    const id = healthySession("body");
    corruptFile(store.goalPath(id));
    corruptFile(store.namePath(id));
    // Canonical order: name before goal, regardless of damage order.
    expect(damagedSidecars(store, id)).toEqual(["name", "goal"]);

    const notesDamaged = healthySession("body two");
    corruptFile(path.join(dir, `${notesDamaged}.notes.json`));
    expect(damagedSidecars(store, notesDamaged)).toEqual(["notes"]);

    const pinArch = healthySession("body three");
    corruptFile(store.pinnedPath(pinArch));
    corruptFile(store.archivedPath(pinArch));
    expect(damagedSidecars(store, pinArch)).toEqual(["pinned", "archived"]);
  });

  it("rolls up sessionsWithDamagedSidecars and marks entries", () => {
    const clean = healthySession("clean");
    const damagedOne = healthySession("damaged one");
    corruptFile(store.goalPath(damagedOne));
    const damagedTwo = healthySession("damaged two");
    corruptFile(store.goalPath(damagedTwo));
    corruptFile(path.join(dir, `${damagedTwo}.notes.json`));

    const report = buildSessionHealthReport(store);
    expect(report.sessionCount).toBe(3);
    expect(report.sessionsWithDamagedSidecars).toBe(2);
    const byId = new Map(report.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get(clean)!.damagedSidecars).toEqual([]);
    expect(byId.get(damagedOne)!.damagedSidecars).toEqual(["goal"]);
    expect(byId.get(damagedTwo)!.damagedSidecars).toEqual(["goal", "notes"]);
  });

  it("orders transcript severity first, then damaged count desc, then sessionId", () => {
    // ok with 2 damaged sidecars
    const okDamaged2 = healthySession("ok damaged two");
    corruptFile(store.goalPath(okDamaged2));
    corruptFile(store.pinnedPath(okDamaged2));
    // partial with no damaged sidecars
    const partial = "partial-src";
    fs.writeFileSync(
      path.join(dir, `${partial}.jsonl`),
      [META, JSON.stringify({ role: "user", content: "x" }), "{bad"].join("\n") + "\n",
    );
    // ok with 1 damaged sidecar
    const okDamaged1 = healthySession("ok damaged one");
    corruptFile(store.namePath(okDamaged1));
    // clean ok
    const clean = healthySession("clean");

    const report = buildSessionHealthReport(store);
    const order = report.sessions.map((s) => s.sessionId);
    expect(order[0]).toBe(partial); // severity wins over damage count
    expect(order.slice(1)).toEqual([okDamaged2, okDamaged1, clean]);
  });

  it("shows transcript damage and sidecar damage together honestly", () => {
    const id = "both-damaged";
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      [META, "{bad middle", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    corruptFile(store.goalPath(id));

    const report = buildSessionHealthReport(store);
    const entry = report.sessions.find((s) => s.sessionId === id)!;
    expect(entry.integrity).toBe("corrupt");
    expect(entry.damagedSidecars).toEqual(["goal"]);
    const text = formatSessionHealthReport(report).join("\n");
    expect(text).toContain("1 bad line(s), 1 message(s) parseable; damaged sidecars: goal");
    expect(text).toContain("1 session(s) with damaged sidecar file(s).");
  });

  it("renders the damaged-sidecar rollup and per-session marks", () => {
    const id = healthySession("marked");
    corruptFile(path.join(dir, `${id}.notes.json`));
    const report = buildSessionHealthReport(store);
    const lines = formatSessionHealthReport(report);
    expect(lines.some((l) => l === "1 session(s) with damaged sidecar file(s).")).toBe(true);
    const marked = lines.find((l) => l.includes("— ok"));
    expect(marked).toContain("(damaged sidecars: notes)");
  });

  it("keeps the store byte-identical and never rewrites damaged files", () => {
    const id = healthySession("byte identity");
    corruptFile(store.goalPath(id));
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildSessionHealthReport(store);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
  });
});
