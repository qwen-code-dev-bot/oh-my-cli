import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  PROMPT_HISTORY_MAX_ENTRIES,
  PROMPT_HISTORY_MAX_ENTRY_CHARS,
  PROMPT_HISTORY_SCHEMA,
  PROMPT_HISTORY_VERSION,
  defaultPromptHistoryDir,
  promptHistoryFileName,
  openPromptHistoryStore,
} from "../../src/prompt-history.js";

describe("prompt history store (Issue #711)", () => {
  const tmpDirs: string[] = [];
  const makeDir = (name: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `omc-711-${name}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Never touch the real HOME: an omitted historyDir gets an isolated one.
  const storeFor = (workspace: string, historyDir?: string) =>
    openPromptHistoryStore({
      workspacePath: workspace,
      historyDir: historyDir ?? makeDir("history-auto"),
    });

  it("starts empty when no record exists", () => {
    const store = storeFor(makeDir("ws"));
    expect(store.load()).toEqual({ entries: [], corrupt: false });
  });

  it("round-trips submitted prompts chronologically (oldest first)", () => {
    const store = storeFor(makeDir("ws"));
    store.append("first prompt");
    store.append("second prompt\nwith a newline");
    expect(store.load()).toEqual({
      entries: ["first prompt", "second prompt\nwith a newline"],
      corrupt: false,
    });
  });

  it("rejects empty and whitespace-only entries", () => {
    const store = storeFor(makeDir("ws"));
    store.append("");
    store.append("   \n\t ");
    expect(store.load()).toEqual({ entries: [], corrupt: false });
    expect(fs.existsSync(store.filePath)).toBe(false);
  });

  it("rejects oversized entries instead of truncating them", () => {
    const store = storeFor(makeDir("ws"));
    store.append("a prompt that stays");
    store.append("z".repeat(PROMPT_HISTORY_MAX_ENTRY_CHARS + 1));
    expect(store.load().entries).toEqual(["a prompt that stays"]);
    // Exactly at the bound is still recomposable as sent, so it is accepted.
    store.append("y".repeat(PROMPT_HISTORY_MAX_ENTRY_CHARS));
    expect(store.load().entries).toHaveLength(2);
  });

  it("skips a consecutive duplicate without dropping separated repeats", () => {
    const store = storeFor(makeDir("ws"));
    store.append("run the tests");
    store.append("run the tests");
    store.append("fix the failure");
    store.append("run the tests");
    expect(store.load().entries).toEqual([
      "run the tests",
      "fix the failure",
      "run the tests",
    ]);
  });

  it("bounds the store by evicting the oldest entries", () => {
    const store = storeFor(makeDir("ws"));
    for (let i = 0; i < PROMPT_HISTORY_MAX_ENTRIES + 25; i++) {
      store.append(`prompt ${i}`);
    }
    const loaded = store.load();
    expect(loaded.entries).toHaveLength(PROMPT_HISTORY_MAX_ENTRIES);
    expect(loaded.entries[0]).toBe("prompt 25");
    expect(loaded.entries[loaded.entries.length - 1]).toBe(
      `prompt ${PROMPT_HISTORY_MAX_ENTRIES + 24}`,
    );
  });

  it("scopes history by canonical workspace key: different workspaces never share", () => {
    const historyDir = makeDir("history");
    const a = storeFor(makeDir("a"), historyDir);
    const b = storeFor(makeDir("b"), historyDir);
    a.append("prompt for A");
    expect(a.load().entries).toEqual(["prompt for A"]);
    expect(b.load()).toEqual({ entries: [], corrupt: false });
    expect(a.filePath).not.toBe(b.filePath);
  });

  it("shares one history across symlink aliases of the same workspace", () => {
    const historyDir = makeDir("history");
    const real = makeDir("real");
    const alias = path.join(path.dirname(real), `${path.basename(real)}-alias`);
    tmpDirs.push(alias);
    fs.symlinkSync(real, alias);
    const fromReal = openPromptHistoryStore({ workspacePath: real, historyDir });
    const fromAlias = openPromptHistoryStore({ workspacePath: alias, historyDir });
    fromReal.append("submitted via the real path");
    expect(fromAlias.load().entries).toEqual(["submitted via the real path"]);
    expect(fromReal.filePath).toBe(fromAlias.filePath);
  });

  it("shares one history across a linked git worktree of the same repository", () => {
    const historyDir = makeDir("history");
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
    const fromRepo = openPromptHistoryStore({ workspacePath: repo, historyDir });
    const fromWorktree = openPromptHistoryStore({ workspacePath: worktree, historyDir });
    fromRepo.append("submitted in the main checkout");
    expect(fromWorktree.load().entries).toEqual(["submitted in the main checkout"]);
  });

  it("accepts an injectable keyOf like the other workspace-identity surfaces", () => {
    const historyDir = makeDir("history");
    const keyOf = (p: string): string => (p.endsWith("x") ? "same" : p);
    const one = openPromptHistoryStore({ workspacePath: "/a/x", historyDir, keyOf });
    const two = openPromptHistoryStore({ workspacePath: "/b/x", historyDir, keyOf });
    one.append("shared identity");
    expect(two.load().entries).toEqual(["shared identity"]);
  });

  it("fails closed to corrupt for an unparseable record, preserving the bytes", () => {
    const store = storeFor(makeDir("ws"));
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, "{ not json");
    expect(store.load()).toEqual({ entries: [], corrupt: true });
    expect(fs.readFileSync(store.filePath, "utf8")).toBe("{ not json");
  });

  it("fails closed to corrupt for an unknown schema or version", () => {
    const store = storeFor(makeDir("ws"));
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(
      store.filePath,
      JSON.stringify({ schema: "something-else", v: 1, entries: ["x"] }),
    );
    expect(store.load()).toEqual({ entries: [], corrupt: true });
    fs.writeFileSync(
      store.filePath,
      JSON.stringify({ schema: PROMPT_HISTORY_SCHEMA, v: 999, entries: ["x"] }),
    );
    expect(store.load()).toEqual({ entries: [], corrupt: true });
  });

  it("fails closed to corrupt when entries is not an array", () => {
    const store = storeFor(makeDir("ws"));
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(
      store.filePath,
      JSON.stringify({ schema: PROMPT_HISTORY_SCHEMA, v: PROMPT_HISTORY_VERSION, entries: "nope" }),
    );
    expect(store.load()).toEqual({ entries: [], corrupt: true });
  });

  it("drops unusable stored entries but keeps the trusted ones", () => {
    const store = storeFor(makeDir("ws"));
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(
      store.filePath,
      JSON.stringify({
        schema: PROMPT_HISTORY_SCHEMA,
        v: PROMPT_HISTORY_VERSION,
        entries: ["kept", 42, "  ", "z".repeat(PROMPT_HISTORY_MAX_ENTRY_CHARS + 1), "also kept"],
      }),
    );
    expect(store.load()).toEqual({ entries: ["kept", "also kept"], corrupt: false });
  });

  it("starts recording fresh after a corrupt record without throwing", () => {
    const store = storeFor(makeDir("ws"));
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, "{ not json");
    store.append("after the corruption");
    expect(store.load()).toEqual({ entries: ["after the corruption"], corrupt: false });
  });

  it("clear removes the durable record and persists the cleared state", () => {
    const store = storeFor(makeDir("ws"));
    store.append("remember me");
    expect(store.load().entries).toEqual(["remember me"]);
    store.clear();
    expect(fs.existsSync(store.filePath)).toBe(false);
    expect(store.load()).toEqual({ entries: [], corrupt: false });
    // Clearing an already-absent record is a no-op, not an error.
    store.clear();
    expect(store.load()).toEqual({ entries: [], corrupt: false });
  });

  it("writes atomically (no torn record) with owner-only permissions", () => {
    const store = storeFor(makeDir("ws"));
    store.append("private prompt");
    const mode = fs.statSync(store.filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // No stray temp file lingers after the atomic rename.
    const siblings = fs.readdirSync(path.dirname(store.filePath));
    expect(siblings).toEqual([path.basename(store.filePath)]);
    const dirMode = fs.statSync(path.dirname(store.filePath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("derives the default history dir from HOME like the session store", () => {
    expect(defaultPromptHistoryDir({ HOME: "/home/x" })).toBe(
      path.join("/home/x", ".oh-my-cli", "prompt-history"),
    );
    expect(defaultPromptHistoryDir({})).toBe(path.join("/root", ".oh-my-cli", "prompt-history"));
  });

  it("maps a workspace key to a flat hash file name", () => {
    const name = promptHistoryFileName("/srv/some/workspace");
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    // No path separator can escape the history directory.
    expect(name).not.toContain("/");
  });
});
