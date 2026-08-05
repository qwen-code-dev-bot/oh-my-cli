import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildStaleSessionsReport, formatStaleSessions, STALE_DEFAULT_DAYS } from "../../src/stale-sessions.js";
import { appendSessionNote } from "../../src/session-notes.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("buildStaleSessionsReport (Issue #626)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-626u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(ageDays: number): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "stale fodder" }], { model: "m", createdAt: 1 });
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  it("lists candidates oldest-first with age, messages, and notes", () => {
    const oldest = seed(45);
    seed(40);
    seed(5); // below the default threshold
    expect(appendSessionNote(store, oldest, "old breadcrumb", NOW).ok).toBe(true);
    expect(appendSessionNote(store, oldest, "another breadcrumb", NOW).ok).toBe(true);

    const report = buildStaleSessionsReport(store, { now: () => NOW });
    expect(report.thresholdDays).toBe(STALE_DEFAULT_DAYS);
    expect(report.totalSessions).toBe(3);
    expect(report.candidates.map((c) => c.sessionId)).toEqual([oldest, expect.any(String)]);
    expect(report.candidates[0].sessionId).toBe(oldest);
    expect(report.candidates[0].notes).toBe(2);
    expect(report.candidates[0].messages).toBe(1);
    expect(report.candidates[0].ageMs).toBeGreaterThanOrEqual(STALE_DEFAULT_DAYS * DAY);
    expect(report.protectedPinned).toBe(0);
    expect(report.protectedArchived).toBe(0);
  });

  it("honors a custom threshold", () => {
    const sixDays = seed(6);
    seed(2);
    const defaultReport = buildStaleSessionsReport(store, { now: () => NOW });
    expect(defaultReport.candidates).toEqual([]);

    const report = buildStaleSessionsReport(store, { thresholdDays: 5, now: () => NOW });
    expect(report.thresholdDays).toBe(5);
    expect(report.candidates.map((c) => c.sessionId)).toEqual([sixDays]);
  });

  it("counts pinned-old and archived-old as protected, never candidates", () => {
    const pinnedOld = seed(50);
    store.writePinned(pinnedOld, NOW);
    const archivedOld = seed(60);
    store.writeArchived(archivedOld, NOW);
    const both = seed(70);
    store.writePinned(both, NOW);
    store.writeArchived(both, NOW);
    seed(40); // the only candidate

    const report = buildStaleSessionsReport(store, { now: () => NOW });
    expect(report.candidates).toHaveLength(1);
    expect(report.protectedPinned).toBe(1);
    // Archived takes precedence, so pinned+archived counts once, as archived.
    expect(report.protectedArchived).toBe(2);
    expect(report.totalSessions).toBe(4);
  });

  it("renders the honest empty state and the advisory footer", () => {
    seed(1);
    const report = buildStaleSessionsReport(store, { now: () => NOW });
    const text = formatStaleSessions(report).join("\n");
    expect(text).toContain("No stale sessions at this threshold.");
    expect(text).toContain("Protected (older than threshold): 0 pinned · 0 archived.");
    expect(text).toContain("Advisory only — nothing is archived.");
  });

  it("redacts secret-shaped session names in candidates", () => {
    const secret = ["ghp", "_", "s".repeat(24)].join("");
    const id = seed(40);
    store.writeName(id, `named ${secret}`);
    const report = buildStaleSessionsReport(store, { now: () => NOW });
    expect(report.candidates[0].name).not.toContain(secret);
    expect(report.candidates[0].name).toContain("[REDACTED]");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("keeps the store byte-identical through a report", () => {
    const id = seed(40);
    store.writePinned(id, NOW);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildStaleSessionsReport(store, { now: () => NOW });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
