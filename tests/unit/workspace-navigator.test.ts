import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  navigateTree,
  searchWorkspace,
  previewFile,
  evaluatePolicy,
  RecentFilesTracker,
  type NavigatorPolicy,
} from "../../src/workspace-navigator.js";
import { IgnoreSet } from "../../src/discovery.js";
import { createContextReference } from "../../src/context-reference.js";

// Fixture-based coverage for the read-only workspace navigator (Issue #332):
// tree navigation, content search, recent files, policy enforcement (trust,
// ignore, binary, secret, oversized), and preview. Fixtures are built in a
// temp workspace; nothing outside it is touched. Navigation is verified to be
// read-only (no mutations).

let tmpDir: string;
let ws: Workspace;

const TRUSTED_POLICY: NavigatorPolicy = {
  trusted: true,
  ignore: true,
  maxPreviewBytes: 2 * 1_048_576,
};

const UNTRUSTED_POLICY: NavigatorPolicy = {
  ...TRUSTED_POLICY,
  trusted: false,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-test-"));
  ws = new Workspace(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

function writeBinary(rel: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
}

// --- tree navigation --------------------------------------------------------

describe("navigateTree", () => {
  it("lists files and directories as canonical references", () => {
    write("src/index.ts", "export {}");
    write("src/util.ts", "export {}");
    fs.mkdirSync(path.join(tmpDir, "docs"));

    const result = navigateTree(ws, "src", TRUSTED_POLICY);
    expect(result.dir).toBe("src");
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].ref.path).toBe("src/index.ts");
    expect(result.entries[0].ref.provenance).toBe("tree");
    expect(result.entries[0].type).toBe("file");
    expect(result.entries[1].ref.path).toBe("src/util.ts");
  });

  it("lists root directory when dir is empty", () => {
    write("a.ts", "");
    write("b.ts", "");

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    expect(result.dir).toBe("");
    expect(result.entries.length).toBe(2);
  });

  it("refuses all navigation when untrusted", () => {
    write("a.ts", "content");

    const result = navigateTree(ws, "", UNTRUSTED_POLICY);
    expect(result.entries).toHaveLength(0);
    expect(result.refused.untrusted).toBeGreaterThan(0);
  });

  it("excludes binary files", () => {
    write("good.ts", "code");
    writeBinary("image.png");

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("good.ts");
    expect(paths).not.toContain("image.png");
    expect(result.refused.binary).toBeGreaterThan(0);
  });

  it("excludes secret paths", () => {
    write("app.ts", "code");
    write(".env", "SECRET=abc");
    write("id_rsa", "key data");

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("app.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("id_rsa");
    expect(result.refused.secret).toBeGreaterThan(0);
  });

  it("excludes ignored directories", () => {
    write("src/a.ts", "code");
    write("node_modules/pkg/index.js", "module");
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("src");
    expect(paths).not.toContain("node_modules");
    expect(paths).not.toContain(".git");
  });

  it("honors .gitignore rules", () => {
    write(".gitignore", "generated/\n*.log");
    write("src/a.ts", "code");
    write("generated/out.ts", "gen");
    write("debug.log", "log");

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("src");
    expect(paths).not.toContain("generated");
    expect(paths).not.toContain("debug.log");
    expect(result.refused.ignored).toBeGreaterThan(0);
  });

  it("excludes oversized files", () => {
    write("small.ts", "ok");
    const bigContent = "x".repeat(3 * 1_048_576);
    write("big.ts", bigContent);

    const policy: NavigatorPolicy = { ...TRUSTED_POLICY, maxPreviewBytes: 2 * 1_048_576 };
    const result = navigateTree(ws, "", policy);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("small.ts");
    expect(paths).not.toContain("big.ts");
    expect(result.refused.oversized).toBeGreaterThan(0);
  });

  it("never follows symlinks", () => {
    write("real.ts", "content");
    const linkPath = path.join(tmpDir, "link.ts");
    try {
      fs.symlinkSync(path.join(tmpDir, "real.ts"), linkPath);
    } catch {
      return; // skip on platforms that disallow symlinks
    }

    const result = navigateTree(ws, "", TRUSTED_POLICY);
    const paths = result.entries.map((e) => e.ref.path);
    expect(paths).toContain("real.ts");
    expect(paths).not.toContain("link.ts");
  });

  it("is read-only (does not mutate the workspace)", () => {
    write("a.ts", "content");
    const before = fs.readdirSync(tmpDir).sort();

    navigateTree(ws, "", TRUSTED_POLICY);

    const after = fs.readdirSync(tmpDir).sort();
    expect(after).toEqual(before);
  });
});

// --- content search ---------------------------------------------------------

describe("searchWorkspace", () => {
  it("finds matching files with line numbers", () => {
    write("src/app.ts", "line1\nhello world\nline3\nhello again\n");
    write("src/other.ts", "no match here\n");

    const result = searchWorkspace(ws, "hello", TRUSTED_POLICY);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].ref.path).toBe("src/app.ts");
    expect(result.matches[0].ref.provenance).toBe("search");
    expect(result.matches[0].matchLines).toEqual([2, 4]);
    expect(result.matches[0].ref.lines).toEqual({ start: 2, end: 4 });
    expect(result.matches[0].preview).toContain("hello");
  });

  it("is case-insensitive", () => {
    write("a.ts", "Hello World\n");

    const result = searchWorkspace(ws, "hello", TRUSTED_POLICY);
    expect(result.matches.length).toBe(1);
  });

  it("returns empty for no matches", () => {
    write("a.ts", "nothing here\n");

    const result = searchWorkspace(ws, "zzz_no_match", TRUSTED_POLICY);
    expect(result.matches).toHaveLength(0);
  });

  it("refuses search when untrusted", () => {
    write("a.ts", "secret content");

    const result = searchWorkspace(ws, "secret", UNTRUSTED_POLICY);
    expect(result.matches).toHaveLength(0);
    expect(result.refused.untrusted).toBeGreaterThan(0);
  });

  it("skips binary files", () => {
    writeBinary("img.png");
    write("a.ts", "match here");

    const result = searchWorkspace(ws, "match", TRUSTED_POLICY);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].ref.path).toBe("a.ts");
  });

  it("skips secret files", () => {
    write(".env", "TOKEN=match_this");
    write("app.ts", "match_this");

    const result = searchWorkspace(ws, "match_this", TRUSTED_POLICY);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].ref.path).toBe("app.ts");
    expect(result.refused.secret).toBeGreaterThan(0);
  });

  it("returns empty for invalid regex", () => {
    write("a.ts", "content");

    const result = searchWorkspace(ws, "[invalid", TRUSTED_POLICY);
    expect(result.matches).toHaveLength(0);
  });

  it("is read-only", () => {
    write("a.ts", "search target");
    const before = fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8");

    searchWorkspace(ws, "target", TRUSTED_POLICY);

    const after = fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8");
    expect(after).toBe(before);
  });
});

// --- recent files -----------------------------------------------------------

describe("RecentFilesTracker", () => {
  it("records and queries recent files", () => {
    write("a.ts", "code");
    write("b.ts", "code");

    const tracker = new RecentFilesTracker();
    tracker.record("a.ts");
    tracker.record("b.ts");

    const result = tracker.query(ws, TRUSTED_POLICY);
    expect(result.entries.length).toBe(2);
    // Most recent first.
    expect(result.entries[0].ref.path).toBe("b.ts");
    expect(result.entries[1].ref.path).toBe("a.ts");
    expect(result.entries[0].ref.provenance).toBe("recent");
  });

  it("deduplicates by path, keeping most recent", () => {
    write("a.ts", "code");

    const tracker = new RecentFilesTracker();
    tracker.record("a.ts");
    tracker.record("a.ts");

    expect(tracker.size).toBe(1);
  });

  it("respects the max bound", () => {
    const tracker = new RecentFilesTracker(3);
    for (let i = 0; i < 5; i++) {
      write(`f${i}.ts`, "");
      tracker.record(`f${i}.ts`);
    }
    expect(tracker.size).toBe(3);
  });

  it("filters out policy-refused paths", () => {
    write("good.ts", "code");
    write(".env", "SECRET=x");

    const tracker = new RecentFilesTracker();
    tracker.record("good.ts");
    tracker.record(".env");

    const result = tracker.query(ws, TRUSTED_POLICY);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].ref.path).toBe("good.ts");
  });

  it("returns empty when untrusted", () => {
    write("a.ts", "code");

    const tracker = new RecentFilesTracker();
    tracker.record("a.ts");

    const result = tracker.query(ws, UNTRUSTED_POLICY);
    expect(result.entries).toHaveLength(0);
  });

  it("clear removes all entries", () => {
    const tracker = new RecentFilesTracker();
    tracker.record("a.ts");
    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});

// --- policy enforcement -----------------------------------------------------

describe("evaluatePolicy", () => {
  it("allows a normal file in a trusted workspace", () => {
    write("src/app.ts", "code");
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, "src/app.ts", TRUSTED_POLICY, ignoreSet, false);
    expect(result).toEqual({ allowed: true });
  });

  it("refuses when untrusted", () => {
    write("a.ts", "");
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, "a.ts", UNTRUSTED_POLICY, ignoreSet, false);
    expect(result).toEqual({ allowed: false, refusal: "untrusted" });
  });

  it("refuses binary extensions", () => {
    writeBinary("img.png");
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, "img.png", TRUSTED_POLICY, ignoreSet, false);
    expect(result).toEqual({ allowed: false, refusal: "binary" });
  });

  it("refuses secret paths", () => {
    write(".env.local", "X=1");
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, ".env.local", TRUSTED_POLICY, ignoreSet, false);
    expect(result).toEqual({ allowed: false, refusal: "secret" });
  });

  it("refuses oversized files", () => {
    const bigContent = "x".repeat(3 * 1_048_576);
    write("big.dat", bigContent);
    const ignoreSet = IgnoreSet.load(ws);
    const policy: NavigatorPolicy = { ...TRUSTED_POLICY, maxPreviewBytes: 1_048_576 };
    const result = evaluatePolicy(ws, "big.dat", policy, ignoreSet, false);
    expect(result).toEqual({ allowed: false, refusal: "oversized" });
  });

  it("refuses paths with ..", () => {
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, "../escape.ts", TRUSTED_POLICY, ignoreSet, false);
    expect(result).toEqual({ allowed: false, refusal: "outside-workspace" });
  });

  it("refuses ignored directories", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    const ignoreSet = IgnoreSet.load(ws);
    const result = evaluatePolicy(ws, "node_modules", TRUSTED_POLICY, ignoreSet, true);
    expect(result).toEqual({ allowed: false, refusal: "ignored" });
  });
});

// --- preview ----------------------------------------------------------------

describe("previewFile", () => {
  it("returns bounded content for a file reference", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    write("src/app.ts", lines.join("\n"));

    const ref = createContextReference("src/app.ts", "tree");
    const result = previewFile(ws, ref, TRUSTED_POLICY);

    expect("refused" in result).toBe(false);
    if (!("refused" in result)) {
      expect(result.lines.length).toBe(50); // PREVIEW_MAX_LINES
      expect(result.startLine).toBe(1);
      expect(result.totalLines).toBe(100);
      expect(result.truncated).toBe(true);
    }
  });

  it("returns only the referenced line range", () => {
    write("a.ts", "a\nb\nc\nd\ne\n");

    const ref = createContextReference("a.ts", "search", { start: 2, end: 4 });
    const result = previewFile(ws, ref, TRUSTED_POLICY);

    expect("refused" in result).toBe(false);
    if (!("refused" in result)) {
      expect(result.lines).toEqual(["b", "c", "d"]);
      expect(result.startLine).toBe(2);
      expect(result.truncated).toBe(true);
    }
  });

  it("refuses a secret file", () => {
    write(".env", "SECRET=abc");

    const ref = createContextReference(".env", "manual");
    const result = previewFile(ws, ref, TRUSTED_POLICY);
    expect(result).toEqual({ refused: "secret" });
  });

  it("refuses when untrusted", () => {
    write("a.ts", "code");

    const ref = createContextReference("a.ts", "manual");
    const result = previewFile(ws, ref, UNTRUSTED_POLICY);
    expect(result).toEqual({ refused: "untrusted" });
  });

  it("refuses a binary file", () => {
    writeBinary("img.png");

    const ref = createContextReference("img.png", "manual");
    const result = previewFile(ws, ref, TRUSTED_POLICY);
    expect(result).toEqual({ refused: "binary" });
  });

  it("is read-only", () => {
    write("a.ts", "original");
    const ref = createContextReference("a.ts", "manual");

    previewFile(ws, ref, TRUSTED_POLICY);

    expect(fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8")).toBe("original");
  });
});

// --- surface independence ---------------------------------------------------

describe("surface independence", () => {
  it("produces the same canonical reference from tree and search", () => {
    write("src/mod.ts", "export function target() {}\n");

    const treeResult = navigateTree(ws, "src", TRUSTED_POLICY);
    const searchResult = searchWorkspace(ws, "target", TRUSTED_POLICY);

    expect(treeResult.entries.length).toBe(1);
    expect(searchResult.matches.length).toBe(1);

    // Both produce references with the same path and schema.
    expect(treeResult.entries[0].ref.path).toBe(searchResult.matches[0].ref.path);
    expect(treeResult.entries[0].ref.schema).toBe(searchResult.matches[0].ref.schema);
    expect(treeResult.entries[0].ref.v).toBe(searchResult.matches[0].ref.v);
  });
});
