import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { buildStoreDoctorReport, formatStoreDoctorReport } from "../../src/store-doctor.js";
import { buildSessionHealthReport } from "../../src/session-health.js";
import { buildSessionStorageReport } from "../../src/session-storage.js";
import { buildStaleSessionsReport, STALE_DEFAULT_DAYS } from "../../src/stale-sessions.js";

const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);

describe("store doctor (Issue #670)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-670u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function freshSession(content: string, ageDays = 0): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    const past = new Date(NOW - ageDays * DAY);
    fs.utimesSync(store.filePath(id), past, past);
    return id;
  }

  it("verdicts a clean store healthy with sections consistent with the individual reports", () => {
    freshSession("recent one", 1);
    freshSession("recent two", 2);
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("healthy");
    expect(report.reasons).toEqual([]);
    expect(report.health.counts).toEqual({ ok: 2, partial: 0, corrupt: 0 });
    expect(report.health.sessionsWithDamagedSidecars).toBe(0);
    expect(report.stale.candidates).toBe(0);
    // Sections are exactly the individual reports' values.
    expect(report.health).toEqual(buildSessionHealthReport(store));
    expect(report.storage).toEqual(buildSessionStorageReport(store));
    const stale = buildStaleSessionsReport(store, { thresholdDays: STALE_DEFAULT_DAYS, now: () => NOW });
    expect(report.stale).toEqual({
      thresholdDays: stale.thresholdDays,
      candidates: stale.candidates.length,
      protectedPinned: stale.protectedPinned,
      protectedArchived: stale.protectedArchived,
    });
  });

  it("flags corrupt transcripts", () => {
    freshSession("fine");
    const corrupt = "corrupt-src";
    fs.writeFileSync(
      path.join(dir, `${corrupt}.jsonl`),
      [META, "{bad middle", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("attention-needed");
    expect(report.reasons).toEqual(["1 corrupt transcript(s)"]);
  });

  it("flags damaged sidecars", () => {
    const id = freshSession("damaged sidecar");
    fs.writeFileSync(store.goalPath(id), "{torn goal");
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("attention-needed");
    expect(report.reasons).toEqual(["1 session(s) with damaged sidecar file(s)"]);
  });

  it("flags stale candidates and counts protected sessions", () => {
    freshSession("stale", 40); // older than the 30-day threshold
    const pinned = freshSession("old but pinned", 40);
    store.writePinned(pinned, NOW);
    const archived = freshSession("old but archived", 40);
    store.writeArchived(archived, NOW);
    freshSession("young", 5);
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("attention-needed");
    expect(report.reasons).toEqual([
      `1 stale session(s) older than ${STALE_DEFAULT_DAYS} days (archive candidates)`,
    ]);
    expect(report.stale).toEqual({
      thresholdDays: STALE_DEFAULT_DAYS,
      candidates: 1,
      protectedPinned: 1,
      protectedArchived: 1,
    });
  });

  it("lists every contributing finding when several classes are present", () => {
    const damaged = freshSession("damaged", 1);
    fs.writeFileSync(store.goalPath(damaged), "{torn goal");
    const corrupt = "corrupt-src";
    fs.writeFileSync(
      path.join(dir, `${corrupt}.jsonl`),
      [META, "{bad", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    freshSession("stale", 45);
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("attention-needed");
    expect(report.reasons).toEqual([
      "1 corrupt transcript(s)",
      "1 session(s) with damaged sidecar file(s)",
      `1 stale session(s) older than ${STALE_DEFAULT_DAYS} days (archive candidates)`,
    ]);
  });

  it("checks up an empty store honestly as healthy", () => {
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    expect(report.verdict).toBe("healthy");
    expect(report.reasons).toEqual([]);
    expect(report.health.sessionCount).toBe(0);
    expect(report.storage.totalBytes).toBe(0);
    expect(report.stale.candidates).toBe(0);
    const text = formatStoreDoctorReport(report).join("\n");
    expect(text).toContain("Sessions: 0 total — 0 ok, 0 partial, 0 corrupt.");
    expect(text).toContain("Storage: 0B across 0 session(s).");
    expect(text).toContain("Verdict: healthy.");
  });

  it("renders sectioned text with the verdict and reasons", () => {
    const damaged = freshSession("damaged", 1);
    fs.writeFileSync(path.join(dir, `${damaged}.notes.json`), "{torn notes");
    const report = buildStoreDoctorReport(store, { now: () => NOW });
    const text = formatStoreDoctorReport(report);
    expect(text[0]).toBe("Store doctor");
    expect(text.some((l) => l.startsWith("Sessions: 1 total — 1 ok, 0 partial, 0 corrupt."))).toBe(true);
    expect(text.some((l) => l.startsWith("Sidecars: 1 session(s) with damaged sidecar file(s)."))).toBe(true);
    expect(text.some((l) => l.startsWith("Storage: "))).toBe(true);
    expect(text.some((l) => l.startsWith("Stale: 0 archive candidate(s)"))).toBe(true);
    expect(
      text.some(
        (l) => l === "Verdict: attention needed — 1 session(s) with damaged sidecar file(s).",
      ),
    ).toBe(true);
  });

  it("keeps the store byte-identical through doctor runs", () => {
    const id = freshSession("identity");
    fs.writeFileSync(store.goalPath(id), "{torn goal");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    buildStoreDoctorReport(store, { now: () => NOW });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
