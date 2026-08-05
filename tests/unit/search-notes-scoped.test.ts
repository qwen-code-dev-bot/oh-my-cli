import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { searchSessionNotes } from "../../src/session-notes-search.js";
import { appendSessionNote } from "../../src/session-notes.js";
import { workspaceTrustKey } from "../../src/folder-trust.js";

const NOW = 1_701_000_000_000;

describe("searchSessionNotes workspace scoping (Issue #628)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(workspace: string | undefined, note: string): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "scope fodder" }], {
      model: "m",
      ...(workspace !== undefined ? { workspace } : {}),
      createdAt: 1,
    });
    expect(appendSessionNote(store, id, note, NOW).ok).toBe(true);
    return id;
  }

  it("scans only ledgers of sessions declared for the scoped workspace", () => {
    const inScope = seed("/srv/ws-a", "breadcrumb inside");
    seed("/srv/ws-b", "breadcrumb outside");
    const noWorkspace = seed(undefined, "breadcrumb legacy");

    const scope = {
      workspaceKey: "key-a",
      workspacePath: "/srv/ws-a",
      keyOf: (p: string) => (p === "/srv/ws-a" ? "key-a" : `other-${p}`),
    };
    const scoped = searchSessionNotes(store, "breadcrumb", scope);
    expect(scoped.scopedWorkspace).toBe("/srv/ws-a");
    expect(scoped.ledgersScanned).toBe(1);
    expect(scoped.matches.map((m) => m.sessionId)).toEqual([inScope]);

    // Unscoped scan still sees everything (unchanged behavior).
    const unscoped = searchSessionNotes(store, "breadcrumb");
    expect(unscoped.scopedWorkspace).toBeUndefined();
    expect(unscoped.ledgersScanned).toBe(3);
    expect(unscoped.matches).toHaveLength(3);
  });

  it("matches symlink-alias workspaces through the canonical identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628u-alias-"));
    try {
      const realWs = path.join(root, "project");
      const aliasWs = path.join(root, "alias");
      fs.mkdirSync(realWs);
      fs.symlinkSync(realWs, aliasWs);
      // Session declared for the alias; scope targets the real path.
      seed(aliasWs, "alias breadcrumb");
      const scoped = searchSessionNotes(store, "alias breadcrumb", {
        workspaceKey: workspaceTrustKey(realWs),
        workspacePath: realWs,
      });
      expect(scoped.matches).toHaveLength(1);
      expect(scoped.scopedWorkspace).toBe(realWs);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips archived sessions in both scoped and unscoped scans", () => {
    const archived = seed("/srv/ws-a", "retired breadcrumb");
    store.writeArchived(archived, NOW);
    seed("/srv/ws-a", "live breadcrumb");

    const scope = { workspaceKey: "key-a", workspacePath: "/srv/ws-a", keyOf: () => "key-a" };
    const scoped = searchSessionNotes(store, "breadcrumb", scope);
    expect(scoped.matches.map((m) => m.snippet)).toEqual(["live breadcrumb"]);

    const unscoped = searchSessionNotes(store, "breadcrumb");
    expect(unscoped.matches.map((m) => m.snippet)).toEqual(["live breadcrumb"]);
  });

  it("skips sessions without workspace metadata and uncanonicalizable ones when scoped", () => {
    seed(undefined, "legacy breadcrumb");
    const weird = seed("/srv/weird", "weird breadcrumb");
    const scope = {
      workspaceKey: "key-a",
      workspacePath: "/srv/ws-a",
      keyOf: (p: string) => {
        if (p === "/srv/weird") throw new Error("uncanonicalizable");
        return p === "/srv/ws-a" ? "key-a" : "other";
      },
    };
    const scoped = searchSessionNotes(store, "breadcrumb", scope);
    expect(scoped.matches).toEqual([]);
    expect(scoped.ledgersScanned).toBe(0);
    // The weird session is skipped, not surfaced as an error.
    expect(scoped.elidedTotal).toBe(0);
    void weird;
  });

  it("keeps the store byte-identical through a scoped scan", () => {
    seed("/srv/ws-a", "byte breadcrumb");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    searchSessionNotes(store, "byte", {
      workspaceKey: "key-a",
      workspacePath: "/srv/ws-a",
      keyOf: () => "key-a",
    });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
