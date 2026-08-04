import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote, SESSION_NOTES_MAX } from "../../src/session-notes.js";
import {
  searchSessionNotes,
  formatSessionNotesSearch,
  NOTES_SEARCH_MAX_MATCHES_PER_SESSION,
  NOTES_SEARCH_MAX_MATCHES_TOTAL,
  SESSION_NOTES_SEARCH_SCHEMA,
  SESSION_NOTES_SEARCH_VERSION,
} from "../../src/session-notes-search.js";

const NOW = 1_786_500_000_000;

describe("searchSessionNotes (Issue #606)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-606u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], { createdAt: 1 });
    return id;
  }

  it("reports matching notes with session, ISO timestamp, and snippet; case-insensitive", () => {
    const a = seed();
    expect(appendSessionNote(store, a, "MIGRATION plan decided", NOW).ok).toBe(true);
    expect(appendSessionNote(store, a, "unrelated breadcrumb", NOW + 1000).ok).toBe(true);
    const b = seed();
    expect(appendSessionNote(store, b, "migration follow-up", NOW + 2000).ok).toBe(true);

    const record = searchSessionNotes(store, "migration");
    expect(record.schema).toBe(SESSION_NOTES_SEARCH_SCHEMA);
    expect(record.v).toBe(SESSION_NOTES_SEARCH_VERSION);
    expect(record.query).toBe("migration");
    expect(record.ledgersScanned).toBe(2);
    // Sessions iterate in deterministic sorted-id order (uuids are random, so
    // assert the property rather than a coincidental order).
    const matchIds = record.matches.map((m) => m.sessionId);
    expect(matchIds).toEqual([...matchIds].sort());
    const bySession = new Map(record.matches.map((m) => [m.sessionId, m]));
    expect(bySession.size).toBe(2);
    expect(bySession.get(a)?.snippet).toBe("MIGRATION plan decided");
    expect(bySession.get(a)?.at).toBe(new Date(NOW).toISOString());
    expect(bySession.get(b)?.snippet).toBe("migration follow-up");
    expect(bySession.get(b)?.at).toBe(new Date(NOW + 2000).toISOString());
    expect(record.elidedPerSession).toBe(0);
    expect(record.elidedTotal).toBe(0);
  });

  it("includes session names redacted and leaves unmatched sessions absent", () => {
    const named = seed();
    store.writeName(named, "named ledger");
    expect(appendSessionNote(store, named, "a matching note", NOW).ok).toBe(true);
    const other = seed();
    expect(appendSessionNote(store, other, "nothing here", NOW).ok).toBe(true);

    const record = searchSessionNotes(store, "matching");
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionName).toBe("named ledger");
    // Both ledgers were scanned even though only one matched.
    expect(record.ledgersScanned).toBe(2);
  });

  it("bounds matches per session with a truthful elision count", () => {
    const id = seed();
    for (let i = 0; i < NOTES_SEARCH_MAX_MATCHES_PER_SESSION + 1; i++) {
      expect(appendSessionNote(store, id, `needle note ${i}`, NOW + i).ok).toBe(true);
    }
    const record = searchSessionNotes(store, "needle");
    expect(record.matches).toHaveLength(NOTES_SEARCH_MAX_MATCHES_PER_SESSION);
    expect(record.elidedPerSession).toBe(1);
    expect(record.elidedTotal).toBe(0);
    // Newest kept (ledger order is newest-first).
    expect(record.matches[0].snippet).toBe(
      `needle note ${NOTES_SEARCH_MAX_MATCHES_PER_SESSION}`,
    );
  });

  it("bounds matches overall across sessions with a truthful elision count", () => {
    const sessions = Math.ceil(NOTES_SEARCH_MAX_MATCHES_TOTAL / NOTES_SEARCH_MAX_MATCHES_PER_SESSION) + 1;
    for (let s = 0; s < sessions; s++) {
      const id = seed();
      for (let i = 0; i < NOTES_SEARCH_MAX_MATCHES_PER_SESSION; i++) {
        expect(appendSessionNote(store, id, `needle ${s}-${i}`, NOW + s * 10 + i).ok).toBe(true);
      }
    }
    const record = searchSessionNotes(store, "needle");
    expect(record.matches).toHaveLength(NOTES_SEARCH_MAX_MATCHES_TOTAL);
    expect(record.elidedTotal).toBe(sessions * NOTES_SEARCH_MAX_MATCHES_PER_SESSION - NOTES_SEARCH_MAX_MATCHES_TOTAL);
  });

  it("skips archived sessions and includes corrupt sessions' notes", () => {
    const archived = seed();
    expect(appendSessionNote(store, archived, "needle in archived", NOW).ok).toBe(true);
    store.writeArchived(archived, NOW);

    const corruptId = "corrupt-606";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "needle in corrupt", NOW).ok).toBe(true);

    const record = searchSessionNotes(store, "needle");
    expect(record.ledgersScanned).toBe(1);
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(corruptId);
    expect(record.matches[0].snippet).toBe("needle in corrupt");
  });

  it("never prints secret-shaped content unredacted and leaves the store byte-identical", () => {
    const id = seed();
    const secret = ["ghp", "_", "z".repeat(24)].join("");
    // Persistence already redacts; the search must not resurrect anything.
    expect(appendSessionNote(store, id, `token ${secret} note`, NOW).ok).toBe(true);

    const snapshot = dirSnapshot();
    const record = searchSessionNotes(store, "token");
    expect(dirSnapshot()).toEqual(snapshot);

    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].snippet).not.toContain(secret);
    expect(record.matches[0].snippet).toContain("[REDACTED]");
    expect(record.query).toBe("token");
  });

  it("renders the honest no-match state", () => {
    seed();
    const empty = searchSessionNotes(store, "zzz-not-present");
    expect(empty.matches).toHaveLength(0);
    const text = formatSessionNotesSearch(empty).join("\n");
    expect(text).toContain("Scanned 0 note ledger(s).");
    expect(text).toContain("No matching notes found.");
  });

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snap.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    return snap;
  }
});
