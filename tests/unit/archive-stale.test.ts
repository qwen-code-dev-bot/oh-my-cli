import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  executeArchiveStale,
  formatArchiveStale,
  ARCHIVE_STALE_SCHEMA,
  ARCHIVE_STALE_VERSION,
  ARCHIVE_STALE_DRY_RUN_NOTE,
} from "../../src/archive-stale.js";

const DAY = 24 * 60 * 60 * 1000;

describe("formatArchiveStale (Issue #702)", () => {
  it("renders the apply result with candidates and summary", () => {
    const lines = formatArchiveStale({
      schema: ARCHIVE_STALE_SCHEMA,
      v: ARCHIVE_STALE_VERSION,
      thresholdDays: 30,
      mode: "apply",
      candidates: [{ sessionId: "session-a", shortId: "short-a" }],
      archivedIds: ["session-a"],
      protectedPinned: 1,
      protectedArchived: 0,
    });
    const text = lines.join("\n");
    expect(text).toContain("Archive stale sessions — threshold 30 day(s)");
    expect(text).toContain("Archived:");
    expect(text).toContain("short-a");
    expect(text).toContain("Protected (older than threshold): 1 pinned · 0 archived.");
    expect(text).toContain("Archived 1 session(s). Nothing was deleted");
    expect(text).toContain("--unarchive-session short-a");
  });

  it("renders the empty-candidate branch", () => {
    const text = formatArchiveStale({
      schema: ARCHIVE_STALE_SCHEMA,
      v: ARCHIVE_STALE_VERSION,
      thresholdDays: 30,
      mode: "apply",
      candidates: [],
      archivedIds: [],
      protectedPinned: 0,
      protectedArchived: 0,
    }).join("\n");
    expect(text).toContain("No stale archive candidates at this threshold.");
    expect(text).toContain("Archived 0 session(s).");
  });

  it("exposes the stable dry-run note", () => {
    expect(ARCHIVE_STALE_DRY_RUN_NOTE).toContain("Dry run: nothing archived");
    expect(ARCHIVE_STALE_DRY_RUN_NOTE).toContain("--apply");
  });
});

describe("executeArchiveStale (Issue #702)", () => {
  let dir: string;
  let store: SessionStore;
  let staleId: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-702u-store-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    store = new SessionStore(dir);
    staleId = store.newId();
    store.checkpoint(staleId, [{ role: "user", content: "stale" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now() - 60 * DAY,
    });
    const t = new Date(Date.now() - 45 * DAY);
    fs.utimesSync(store.filePath(staleId), t, t);
  });

  it("dry run resolves candidates and never touches the store", () => {
    const before = fs.readdirSync(dir).sort();
    const outcome = executeArchiveStale(store, { thresholdDays: 30, apply: false });
    expect(outcome.record.mode).toBe("dry-run");
    expect(outcome.record.candidates.map((c) => c.sessionId)).toEqual([staleId]);
    expect(outcome.record.archivedIds).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it("apply archives exactly the resolved candidates via the marker", () => {
    const outcome = executeArchiveStale(store, { thresholdDays: 30, apply: true });
    expect(outcome.record.mode).toBe("apply");
    expect(outcome.record.archivedIds).toEqual([staleId]);
    expect(fs.existsSync(path.join(dir, `${staleId}.archived.json`))).toBe(true);

    // Idempotent: the archived session is no longer a candidate.
    const rerun = executeArchiveStale(store, { thresholdDays: 30, apply: true });
    expect(rerun.record.candidates).toEqual([]);
    expect(rerun.record.archivedIds).toEqual([]);
  });
});
