import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import type { SessionSummary } from "../../src/session-summary.js";
import {
  scopeSessionSummariesByWorkspace,
  sessionListRecord,
  formatSessionList,
} from "../../src/session-summary.js";
import { searchSessions } from "../../src/session-search.js";
import { workspaceTrustKey } from "../../src/folder-trust.js";

function summary(id: string, workspace?: string): SessionSummary {
  return {
    id,
    messageCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    totalChars: 0,
    approxTokens: 0,
    ...(workspace !== undefined ? { workspace } : {}),
    createdAt: null,
    lastModified: 1,
    ageMs: 0,
    corrupt: false,
  };
}

describe("scopeSessionSummariesByWorkspace (Issue #596)", () => {
  it("keeps canonical-identity matches and counts only unverifiable sessions", () => {
    const keyOf = (p: string) => {
      if (p === "/repo" || p === "/repo-worktree") return "K";
      if (p === "/other") return "OTHER";
      throw new Error("uncanonicalizable");
    };
    const summaries = [
      summary("a", "/repo"),
      summary("b", "/other"),
      summary("c"), // no workspace metadata (legacy)
      summary("d", "/weird"), // keyOf throws
      summary("e", "/repo-worktree"), // linked worktree collapses to the same key
    ];
    const result = scopeSessionSummariesByWorkspace(summaries, "K", keyOf);
    expect(result.kept.map((s) => s.id)).toEqual(["a", "e"]);
    // Legacy and uncanonicalizable are excluded and counted; another
    // workspace's session is simply out of scope (not "excluded").
    expect(result.excludedUnverifiable).toBe(2);
  });

  it("matches symlink aliases through the real canonical identity", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596u-"));
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(repo);
      const alias = path.join(base, "alias");
      fs.symlinkSync(repo, alias);
      // The alias collapses to the same canonical key as the real path.
      expect(workspaceTrustKey(alias)).toBe(workspaceTrustKey(repo));
      const result = scopeSessionSummariesByWorkspace(
        [summary("a", alias), summary("b", "/somewhere/else")],
        workspaceTrustKey(repo),
      );
      expect(result.kept.map((s) => s.id)).toEqual(["a"]);
      expect(result.excludedUnverifiable).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("session list record + text with workspace scoping (Issue #596)", () => {
  const summaries = [summary("abc-123", "/srv/ws")];

  it("adds scope fields only when scoping is active", () => {
    const scoped = sessionListRecord(summaries, { workspace: "/srv/ws", excludedUnverifiable: 3 });
    expect(scoped.scopedWorkspace).toBe("/srv/ws");
    expect(scoped.excludedUnverifiable).toBe(3);

    const unscoped = sessionListRecord(summaries);
    expect("scopedWorkspace" in unscoped).toBe(false);
    expect("excludedUnverifiable" in unscoped).toBe(false);
  });

  it("renders the scope line and excluded count only when scoped", () => {
    const scopedText = formatSessionList(summaries, {
      workspace: "/srv/ws",
      excludedUnverifiable: 2,
    });
    expect(scopedText).toContain("Scoped to workspace: /srv/ws");
    expect(scopedText).toContain("2 excluded (workspace unverifiable)");

    const unscopedText = formatSessionList(summaries);
    expect(unscopedText).not.toContain("Scoped to workspace");
    expect(unscopedText).not.toContain("excluded");
    // Unscoped rendering is byte-identical to today's format.
    expect(unscopedText).toBe(formatSessionList(summaries, undefined));
  });

  it("reports exclusions on an empty scoped list", () => {
    const text = formatSessionList([], { workspace: "/srv/ws", excludedUnverifiable: 4 });
    expect(text).toContain("No resumable sessions found.");
    expect(text).toContain("(4 session(s) excluded: workspace unverifiable)");
  });
});

describe("searchSessions with workspace scoping (Issue #596)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596u-search-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(workspace: string | undefined, content: string): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content }],
      workspace === undefined ? { model: "m", createdAt: 1 } : { model: "m", workspace, createdAt: 1 },
    );
    return id;
  }

  it("scopes the scan, counts exclusions, and composes with corrupt skip", () => {
    const inScope = seed("/repo", "needle in scope");
    seed("/other", "needle out of scope");
    seed(undefined, "needle legacy");
    // Corrupt checkpoint WITH a verifiable in-scope workspace: still counts
    // as skipped corrupt, not as excluded.
    fs.writeFileSync(
      path.join(dir, "corrupt-in-scope.jsonl"),
      `${JSON.stringify({ meta: true, model: "m", workspace: "/repo", createdAt: 1 })}\n` +
        `${JSON.stringify({ role: "user", content: "needle corrupt" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    // Corrupt checkpoint WITHOUT workspace metadata: excluded as unverifiable.
    fs.writeFileSync(
      path.join(dir, "corrupt-legacy.jsonl"),
      `${JSON.stringify({ role: "user", content: "needle corrupt legacy" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );

    const scope = { workspaceKey: "K", workspacePath: "/repo", keyOf: (p: string) => (p === "/repo" ? "K" : "OTHER") };
    const record = searchSessions(store, "needle", scope);

    expect(record.sessionsScanned).toBe(1);
    expect(record.sessionsSkippedCorrupt).toBe(1);
    expect(record.excludedUnverifiable).toBe(2); // legacy healthy + legacy corrupt
    expect(record.scopedWorkspace).toBe("/repo");
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(inScope);
  });

  it("leaves unscoped scans byte-compatible (no scope fields)", () => {
    seed("/repo", "needle here");
    const record = searchSessions(store, "needle");
    expect(record.matches).toHaveLength(1);
    expect("scopedWorkspace" in record).toBe(false);
    expect("excludedUnverifiable" in record).toBe(false);
  });

  it("matches symlink-alias workspaces through the real canonical identity", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596u-scan-"));
    try {
      const repo = path.join(base, "repo");
      fs.mkdirSync(repo);
      const alias = path.join(base, "alias");
      fs.symlinkSync(repo, alias);
      // The session declares the alias; the scope targets the real path.
      seed(alias, "needle via alias");
      const record = searchSessions(store, "needle", {
        workspaceKey: workspaceTrustKey(repo),
        workspacePath: repo,
      });
      expect(record.sessionsScanned).toBe(1);
      expect(record.matches).toHaveLength(1);
      expect(record.excludedUnverifiable).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
