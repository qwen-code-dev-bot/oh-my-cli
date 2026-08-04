import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  COMPOSER_DRAFT_MAX_CHARS,
  defaultDraftsDir,
  draftFileName,
  openComposerDraftStore,
} from "../../src/composer-draft.js";

describe("composer draft store (Issue #556)", () => {
  const tmpDirs: string[] = [];
  const makeDir = (name: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `omc-556-${name}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Never touch the real HOME: an omitted draftsDir gets an isolated one.
  const storeFor = (workspace: string, draftsDir?: string) =>
    openComposerDraftStore({ workspacePath: workspace, draftsDir: draftsDir ?? makeDir("drafts-auto") });

  it("round-trips a draft exactly", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    expect(store.load().status).toBe("none");
    store.save("fix the login bug\nwith details");
    const loaded = store.load();
    expect(loaded).toEqual({ status: "restored", text: "fix the login bug\nwith details" });
  });

  it("clears the durable copy on empty or whitespace-only save", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    store.save("something");
    expect(store.load().status).toBe("restored");
    store.save("   ");
    expect(store.load().status).toBe("none");
    expect(fs.existsSync(store.filePath)).toBe(false);
    // Clearing an already-absent draft is a no-op, not an error.
    store.save("");
    expect(store.load().status).toBe("none");
  });

  it("scopes drafts by canonical workspace key: different workspaces never share", () => {
    const draftsDir = makeDir("drafts");
    const a = storeFor(makeDir("a"), draftsDir);
    const b = storeFor(makeDir("b"), draftsDir);
    a.save("draft for A");
    expect(a.load()).toEqual({ status: "restored", text: "draft for A" });
    expect(b.load().status).toBe("none");
    expect(a.filePath).not.toBe(b.filePath);
  });

  it("shares one draft across symlink aliases of the same workspace", () => {
    const draftsDir = makeDir("drafts");
    const real = makeDir("real");
    const alias = path.join(path.dirname(real), `${path.basename(real)}-alias`);
    tmpDirs.push(alias);
    fs.symlinkSync(real, alias);
    const fromReal = openComposerDraftStore({ workspacePath: real, draftsDir });
    const fromAlias = openComposerDraftStore({ workspacePath: alias, draftsDir });
    fromReal.save("composed via the real path");
    expect(fromAlias.load()).toEqual({ status: "restored", text: "composed via the real path" });
    expect(fromReal.filePath).toBe(fromAlias.filePath);
  });

  it("shares one draft across a linked git worktree of the same repository", () => {
    const draftsDir = makeDir("drafts");
    const repo = makeDir("repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
    const worktree = path.join(repo, "..", `${path.basename(repo)}-wt`);
    execFileSync("git", ["-C", repo, "worktree", "add", worktree, "-b", "wt"], { stdio: ["ignore", "pipe", "ignore"] });
    tmpDirs.push(fs.realpathSync(worktree));
    const fromRepo = openComposerDraftStore({ workspacePath: repo, draftsDir });
    const fromWorktree = openComposerDraftStore({ workspacePath: worktree, draftsDir });
    fromRepo.save("draft in the main checkout");
    expect(fromWorktree.load()).toEqual({ status: "restored", text: "draft in the main checkout" });
  });

  it("accepts an injectable keyOf like the other workspace-identity surfaces", () => {
    const draftsDir = makeDir("drafts");
    const keyOf = (p: string): string => (p.endsWith("x") ? "same" : p);
    const one = openComposerDraftStore({ workspacePath: "/a/x", draftsDir, keyOf });
    const two = openComposerDraftStore({ workspacePath: "/b/x", draftsDir, keyOf });
    one.save("shared identity");
    expect(two.load()).toEqual({ status: "restored", text: "shared identity" });
  });

  it("truncates oversized drafts at the bound on save and load", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    const big = "z".repeat(COMPOSER_DRAFT_MAX_CHARS + 5_000);
    store.save(big);
    const loaded = store.load();
    expect(loaded.status).toBe("restored");
    if (loaded.status === "restored") expect(loaded.text.length).toBe(COMPOSER_DRAFT_MAX_CHARS);
  });

  it("fails closed to corrupt for an unparseable record, preserving the bytes", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, "{ not json");
    expect(store.load().status).toBe("corrupt");
    expect(fs.readFileSync(store.filePath, "utf8")).toBe("{ not json");
  });

  it("fails closed to corrupt when the record has no usable text field", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, JSON.stringify({ text: 42 }));
    expect(store.load().status).toBe("corrupt");
  });

  it("writes atomically (no torn record) with owner-only permissions", () => {
    const ws = makeDir("ws");
    const store = storeFor(ws);
    store.save("private draft");
    const mode = fs.statSync(store.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // No stray temp file lingers after the atomic rename.
    const siblings = fs.readdirSync(path.dirname(store.filePath));
    expect(siblings).toEqual([path.basename(store.filePath)]);
  });

  it("derives the default drafts dir from HOME like the session store", () => {
    expect(defaultDraftsDir({ HOME: "/home/x" })).toBe(path.join("/home/x", ".oh-my-cli", "drafts"));
    expect(defaultDraftsDir({})).toBe(path.join("/root", ".oh-my-cli", "drafts"));
  });

  it("maps a workspace key to a flat hash file name", () => {
    const name = draftFileName("/srv/some/workspace");
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    // No path separator can escape the drafts directory.
    expect(name).not.toContain("/");
  });
});
