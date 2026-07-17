import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listDirectory,
  globPaths,
  grepContent,
  compileGlob,
  IgnoreSet,
} from "../../src/discovery.js";
import { Workspace } from "../../src/workspace.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;
let workspace: Workspace;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-discovery-"));
  workspace = new Workspace(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function mkdir(rel: string): void {
  fs.mkdirSync(path.join(tmpDir, rel), { recursive: true });
}

describe("compileGlob", () => {
  it("matches * within a single segment", () => {
    const re = compileGlob("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("a/b.ts")).toBe(false);
  });

  it("matches ** across segments", () => {
    const re = compileGlob("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/deep/a.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });

  it("supports ? and character classes", () => {
    expect(compileGlob("file?.txt").test("file1.txt")).toBe(true);
    expect(compileGlob("file?.txt").test("file12.txt")).toBe(false);
    expect(compileGlob("[ab].js").test("a.js")).toBe(true);
    expect(compileGlob("[ab].js").test("c.js")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    const re = compileGlob("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });
});

describe("IgnoreSet", () => {
  it("matches basename patterns at any depth", () => {
    const set = new IgnoreSet();
    set.addPattern("*.log");
    expect(set.isIgnored("a.log", false)).toBe(true);
    expect(set.isIgnored("nested/deep/a.log", false)).toBe(true);
    expect(set.isIgnored("a.txt", false)).toBe(false);
  });

  it("anchors patterns containing a slash to the root", () => {
    const set = new IgnoreSet();
    set.addPattern("/build");
    expect(set.isIgnored("build", true)).toBe(true);
    expect(set.isIgnored("src/build", true)).toBe(false);
  });

  it("honors negation with last-match-wins", () => {
    const set = new IgnoreSet();
    set.addPattern("*.log");
    set.addPattern("!keep.log");
    expect(set.isIgnored("debug.log", false)).toBe(true);
    expect(set.isIgnored("keep.log", false)).toBe(false);
  });

  it("treats directory-only rules as not matching files", () => {
    const set = new IgnoreSet();
    set.addPattern("logs/");
    expect(set.isIgnored("logs", true)).toBe(true);
    expect(set.isIgnored("logs", false)).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const set = new IgnoreSet();
    set.addPattern("# a comment");
    set.addPattern("   ");
    expect(set.isIgnored("# a comment", false)).toBe(false);
  });
});

describe("listDirectory", () => {
  it("lists immediate entries with types, deterministically ordered", () => {
    write("b.txt", "x");
    write("a.txt", "x");
    mkdir("sub");
    const result = listDirectory(workspace, {});
    expect(result.entries.map((e) => e.path)).toEqual(["a.txt", "b.txt", "sub"]);
    expect(result.entries.find((e) => e.path === "sub")!.type).toBe("directory");
    expect(result.entries.find((e) => e.path === "a.txt")!.type).toBe("file");
  });

  it("lists a subdirectory by relative path", () => {
    write("sub/inner.txt", "x");
    const result = listDirectory(workspace, { path: "sub" });
    expect(result.entries.map((e) => e.path)).toEqual(["sub/inner.txt"]);
  });

  it("omits generated directories while showing hidden files", () => {
    write("keep.txt", "x");
    write(".env", "x");
    mkdir("node_modules");
    write("node_modules/pkg.js", "x");
    const result = listDirectory(workspace, {});
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain(".env");
    expect(paths).toContain("keep.txt");
    expect(paths).not.toContain("node_modules");
  });

  it("includes generated directories when ignore:false", () => {
    mkdir("node_modules");
    const result = listDirectory(workspace, { ignore: false });
    expect(result.entries.map((e) => e.path)).toContain("node_modules");
  });

  it("applies .gitignore rules", () => {
    write(".gitignore", "secret.txt\n");
    write("secret.txt", "x");
    write("public.txt", "x");
    const result = listDirectory(workspace, {});
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("public.txt");
    expect(paths).not.toContain("secret.txt");
  });

  it("reports symlinks without following them", () => {
    write("target.txt", "x");
    fs.symlinkSync(path.join(tmpDir, "target.txt"), path.join(tmpDir, "link.txt"));
    const result = listDirectory(workspace, {});
    expect(result.entries.find((e) => e.path === "link.txt")!.type).toBe("symlink");
  });

  it("rejects path traversal escape", () => {
    expect(() => listDirectory(workspace, { path: "../../etc" })).toThrow(/escape/i);
  });

  it("rejects a symlink base that escapes the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.symlinkSync(outside, path.join(tmpDir, "escape"));
    try {
      expect(() => listDirectory(workspace, { path: "escape" })).toThrow(/escape/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws for a non-directory base", () => {
    write("file.txt", "x");
    expect(() => listDirectory(workspace, { path: "file.txt" })).toThrow(/not a directory/i);
  });

  it("truncates beyond the entry bound with overflow metadata", () => {
    for (let i = 0; i < 1001; i++) write(`d/f${String(i).padStart(4, "0")}.txt`, "x");
    const result = listDirectory(workspace, { path: "d" });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBe(1000);
    expect(result.totalEntries).toBe(1001);
  });
});

describe("globPaths", () => {
  it("matches files recursively and orders deterministically", () => {
    write("src/a.ts", "x");
    write("src/nested/b.ts", "x");
    write("src/c.js", "x");
    const result = globPaths(workspace, { pattern: "**/*.ts" });
    expect(result.matches).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("matches directories too", () => {
    mkdir("src/components");
    write("src/components/x.ts", "x");
    const result = globPaths(workspace, { pattern: "src/**" });
    expect(result.matches).toContain("src/components");
  });

  it("honors ignore rules (skips node_modules)", () => {
    write("src/a.ts", "x");
    write("node_modules/pkg/a.ts", "x");
    const result = globPaths(workspace, { pattern: "**/*.ts" });
    expect(result.matches).toEqual(["src/a.ts"]);
  });

  it("honors .gitignore file patterns", () => {
    write(".gitignore", "*.log\n");
    write("a.ts", "x");
    write("debug.log", "x");
    const result = globPaths(workspace, { pattern: "**/*" });
    expect(result.matches).toContain("a.ts");
    expect(result.matches).not.toContain("debug.log");
  });

  it("searches ignored trees when ignore:false", () => {
    write("node_modules/pkg/a.ts", "x");
    const result = globPaths(workspace, { pattern: "**/*.ts", ignore: false });
    expect(result.matches).toContain("node_modules/pkg/a.ts");
  });

  it("scopes matches to a base directory", () => {
    write("src/a.ts", "x");
    write("lib/b.ts", "x");
    const result = globPaths(workspace, { pattern: "**/*.ts", path: "src" });
    expect(result.matches).toEqual(["src/a.ts"]);
  });

  it("does not follow symlinked directories", () => {
    write("real/a.ts", "x");
    fs.symlinkSync(path.join(tmpDir, "real"), path.join(tmpDir, "linked"));
    const result = globPaths(workspace, { pattern: "**/*.ts" });
    expect(result.matches).toEqual(["real/a.ts"]);
  });

  it("rejects path traversal in the base", () => {
    expect(() => globPaths(workspace, { pattern: "*", path: "../../" })).toThrow(/escape/i);
  });

  it("requires a pattern", () => {
    expect(() => globPaths(workspace, { pattern: "" })).toThrow(/pattern is required/i);
  });

  it("truncates beyond the match bound", () => {
    for (let i = 0; i < 2001; i++) write(`m/f${String(i).padStart(4, "0")}.txt`, "x");
    const result = globPaths(workspace, { pattern: "m/*.txt" });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(2000);
  });
});

describe("grepContent", () => {
  it("returns path:line matches with 1-based line numbers", () => {
    write("a.txt", "alpha\nbeta\nalpha again");
    const result = grepContent(workspace, { pattern: "alpha" });
    expect(result.matches.map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
      "a.txt:1",
      "a.txt:3",
    ]);
  });

  it("treats the pattern as a regular expression", () => {
    write("a.txt", "foo123bar\nnope");
    const result = grepContent(workspace, { pattern: "foo\\d+bar" });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].lineNumber).toBe(1);
  });

  it("orders matches by path then line number", () => {
    write("b.txt", "x\nx");
    write("a.txt", "x");
    const result = grepContent(workspace, { pattern: "x" });
    expect(result.matches.map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
      "a.txt:1",
      "b.txt:1",
      "b.txt:2",
    ]);
  });

  it("filters by include glob", () => {
    write("a.ts", "needle");
    write("a.js", "needle");
    const result = grepContent(workspace, { pattern: "needle", include: "**/*.ts" });
    expect(result.matches.map((m) => m.path)).toEqual(["a.ts"]);
  });

  it("skips binary files with an explicit count", () => {
    write("text.txt", "needle here");
    fs.writeFileSync(path.join(tmpDir, "bin.dat"), Buffer.from("needle\u0000binary"));
    const result = grepContent(workspace, { pattern: "needle" });
    expect(result.filesSkippedBinary).toBe(1);
    expect(result.matches.map((m) => m.path)).toEqual(["text.txt"]);
  });

  it("skips oversized files with an explicit count", () => {
    write("small.txt", "needle");
    const big = Buffer.alloc(2 * 1_048_576 + 10, "a");
    fs.writeFileSync(path.join(tmpDir, "big.txt"), big);
    const result = grepContent(workspace, { pattern: "needle" });
    expect(result.filesSkippedLarge).toBe(1);
    expect(result.matches.map((m) => m.path)).toEqual(["small.txt"]);
  });

  it("truncates over-long lines with metadata", () => {
    write("long.txt", "x".repeat(2000) + "needle");
    const result = grepContent(workspace, { pattern: "needle" });
    // The needle is past the line cap, so the match line is truncated.
    expect(result.matches[0].truncatedLine).toBe(true);
    expect(result.matches[0].line.length).toBeLessThanOrEqual(1000);
  });

  it("honors ignore rules", () => {
    write(".gitignore", "ignored.txt\n");
    write("ignored.txt", "needle");
    write("kept.txt", "needle");
    const result = grepContent(workspace, { pattern: "needle" });
    expect(result.matches.map((m) => m.path)).toEqual(["kept.txt"]);
  });

  it("searches a single file passed as the base", () => {
    write("only.txt", "one needle\ntwo needle");
    const result = grepContent(workspace, { pattern: "needle", path: "only.txt" });
    expect(result.matches.map((m) => m.lineNumber)).toEqual([1, 2]);
  });

  it("rejects an invalid regex", () => {
    write("a.txt", "x");
    expect(() => grepContent(workspace, { pattern: "(" })).toThrow(/invalid regex/i);
  });

  it("rejects path traversal in the base", () => {
    expect(() => grepContent(workspace, { pattern: "x", path: "../../" })).toThrow(/escape/i);
  });

  it("truncates beyond the match bound", () => {
    write("many.txt", Array.from({ length: 1001 }, () => "needle").join("\n"));
    const result = grepContent(workspace, { pattern: "needle" });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(1000);
  });

  it("is deterministic across repeated runs", () => {
    write("a.txt", "x\ny\nx");
    write("b.txt", "x");
    const first = grepContent(workspace, { pattern: "x" });
    const second = grepContent(workspace, { pattern: "x" });
    expect(second.matches).toEqual(first.matches);
  });
});
