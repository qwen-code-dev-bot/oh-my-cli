import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  searchSessions,
  formatSessionSearch,
  SEARCH_MAX_MATCHES_PER_SESSION,
  SEARCH_MAX_MATCHES_TOTAL,
} from "../../src/session-search.js";

describe("searchSessions (Issue #594)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-594u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(lines: Array<Record<string, unknown>>): string {
    const id = store.newId();
    store.checkpoint(id, lines as never[], { model: "m", workspace: "/w", createdAt: 1 });
    return id;
  }

  it("reports the session, role, message index, and a snippet for a case-insensitive match", () => {
    const id = seed([
      { role: "user", content: "please explain the MIGRATION plan" },
      { role: "assistant", content: "the migration starts with a backup" },
      { role: "user", content: "unrelated chatter" },
    ]);
    const record = searchSessions(store, "migration");
    expect(record.sessionsScanned).toBe(1);
    expect(record.sessionsSkippedCorrupt).toBe(0);
    expect(record.matches).toHaveLength(2);

    const [first, second] = record.matches;
    expect(first.sessionId).toBe(id);
    expect(first.messageIndex).toBe(0);
    expect(first.role).toBe("user");
    expect(first.snippet).toContain("MIGRATION");
    expect(second.messageIndex).toBe(1);
    expect(second.role).toBe("assistant");
    expect(second.snippet).toContain("migration starts with a backup");
    expect(record.elidedPerSession).toBe(0);
    expect(record.elidedTotal).toBe(0);
  });

  it("includes the redacted user-owned name and omits it when unset", () => {
    const named = seed([{ role: "user", content: "needle here" }]);
    store.writeName(named, "named work");
    const unnamed = seed([{ role: "user", content: "needle here too" }]);
    const record = searchSessions(store, "needle");
    const byId = new Map(record.matches.map((m) => [m.sessionId, m]));
    expect(byId.get(named)?.sessionName).toBe("named work");
    expect(byId.get(unnamed)?.sessionName).toBeUndefined();
  });

  it("finds multiple matches inside a single message", () => {
    seed([{ role: "user", content: "a b a b a" }]);
    const record = searchSessions(store, "a");
    expect(record.matches).toHaveLength(3);
    expect(record.matches.every((m) => m.messageIndex === 0)).toBe(true);
  });

  it("matches non-secret attachment names without touching image bytes", () => {
    seed([
      {
        role: "user",
        content: "see attached",
        images: [{ name: "architecture-diagram.png", mediaType: "image/png", bytes: 12 }],
      },
    ]);
    const record = searchSessions(store, "architecture");
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].snippet).toContain('attachment "architecture-diagram.png"');
  });

  it("skips corrupt sessions with a count and scans partial ones", () => {
    const healthy = seed([{ role: "user", content: "needle in healthy" }]);
    // Partial: a torn trailing line is still resumable, so it is scanned.
    const partialId = "partial-src";
    fs.writeFileSync(
      path.join(dir, `${partialId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "needle in partial" })}\n{trailing torn line`,
    );
    // Corrupt: mid-file damage is skipped, counted, never fatal.
    const corruptId = "corrupt-src";
    fs.writeFileSync(
      path.join(dir, `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "needle in corrupt" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const corruptBefore = fs.readFileSync(path.join(dir, `${corruptId}.jsonl`), "utf-8");

    const record = searchSessions(store, "needle");
    expect(record.sessionsScanned).toBe(2);
    expect(record.sessionsSkippedCorrupt).toBe(1);
    const hitSessions = record.matches.map((m) => m.sessionId).sort();
    expect(hitSessions).toEqual([healthy, partialId].sort());
    // The corrupt checkpoint is untouched and never quarantined.
    expect(fs.readFileSync(path.join(dir, `${corruptId}.jsonl`), "utf-8")).toBe(corruptBefore);
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("bounds matches per session with a truthful elision count", () => {
    seed([{ role: "user", content: "x ".repeat(50) + "needle" }]); // many "x" matches
    const record = searchSessions(store, "x");
    expect(record.matches).toHaveLength(SEARCH_MAX_MATCHES_PER_SESSION);
    expect(record.elidedPerSession).toBeGreaterThan(0);
  });

  it("bounds matches in total across sessions with a truthful elision count", () => {
    const sessions = Math.ceil(SEARCH_MAX_MATCHES_TOTAL / SEARCH_MAX_MATCHES_PER_SESSION) + 1;
    for (let i = 0; i < sessions; i++) {
      seed([{ role: "user", content: "needle one needle two needle three needle four needle five needle six" }]);
    }
    const record = searchSessions(store, "needle");
    expect(record.matches).toHaveLength(SEARCH_MAX_MATCHES_TOTAL);
    expect(record.elidedTotal).toBeGreaterThan(0);
  });

  it("redacts secret-shaped transcript content in snippets and the query in the record", () => {
    const secret = ["ghp", "_", "s".repeat(24)].join("");
    seed([{ role: "user", content: `token is ${secret} ok` }]);
    const record = searchSessions(store, "token");
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].snippet).not.toContain(secret);
    expect(record.matches[0].snippet).toContain("[REDACTED]");

    const secretQuery = searchSessions(store, secret);
    expect(secretQuery.query).not.toContain(secret);
    expect(secretQuery.query).toContain("[REDACTED]");
  });

  it("returns an honest empty record and scans deterministically by id", () => {
    const b = seed([{ role: "user", content: "b content" }]);
    const a = seed([{ role: "user", content: "a content" }]);
    const empty = searchSessions(store, "zzz");
    expect(empty.matches).toHaveLength(0);
    expect(empty.sessionsScanned).toBe(2);

    const both = searchSessions(store, "content");
    expect(both.matches.map((m) => m.sessionId)).toEqual([a, b].sort());
    const rendered = formatSessionSearch(both);
    expect(rendered).toContain("2 match(es).");
  });

  it("renders the no-match and empty-query records honestly", () => {
    seed([{ role: "user", content: "something" }]);
    const none = searchSessions(store, "zzz");
    expect(formatSessionSearch(none)).toContain("No matches found.");

    const blank = searchSessions(store, "   ");
    expect(blank.matches).toHaveLength(0);
    expect(blank.sessionsScanned).toBe(0);
    expect(blank.query).toBe("");
  });
});
