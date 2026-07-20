import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  referenceQuery,
  escapeReference,
  parseReferenceToken,
  dedupeReferences,
  existingReferencePaths,
  fuzzyScore,
  looksBinary,
  looksLikeSecretPath,
  collectWorkspaceReferences,
  filterReferences,
  collectReferenceCandidates,
  formatReferenceSize,
  formatReferencePreview,
} from "../../src/workspace-reference.js";
import type { ReferenceCandidate } from "../../src/workspace-reference.js";

// Pure-function coverage for the composer `@` reference engine (Issue #196,
// criterion 5): query parsing, escaping round-trips, deduplication, fuzzy
// filtering, ignore handling, binary/secret exclusion, and workspace
// containment. Fixtures are built in a temp workspace; nothing outside it is
// touched.

describe("referenceQuery", () => {
  it("detects an @ reference at the start of input", () => {
    expect(referenceQuery("@src")).toEqual({ query: "src", start: 0 });
  });

  it("detects an @ reference after whitespace", () => {
    expect(referenceQuery("look at @sr")).toEqual({ query: "sr", start: 8 });
  });

  it("treats a bare @ as an empty query that opens the picker", () => {
    expect(referenceQuery("@")).toEqual({ query: "", start: 0 });
  });

  it("does not trigger on an interior @ such as an email address", () => {
    expect(referenceQuery("email@host")).toBeNull();
  });

  it("returns null once the reference is closed by whitespace", () => {
    expect(referenceQuery("@src/index.ts done")).toBeNull();
  });

  it("only the trailing token is active", () => {
    expect(referenceQuery("@a.ts and @b")).toEqual({ query: "b", start: 10 });
  });
});

describe("escapeReference / parseReferenceToken", () => {
  const cases = [
    "src/index.ts",
    "docs/README.md",
    "a-b_c.d/e",
    "path with spaces/file.txt",
    'weird"quote/name.ts',
    "tab\tname.md",
    "na\\me.txt",
  ];

  it("round-trips bare and spaced/quoted paths exactly", () => {
    for (const p of cases) {
      expect(parseReferenceToken(escapeReference(p))).toBe(p);
    }
  });

  it("leaves bare paths unquoted", () => {
    expect(escapeReference("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes paths with whitespace", () => {
    expect(escapeReference("a b/c.txt")).toBe('"a b/c.txt"');
  });

  it("escapes embedded double quotes and backslashes", () => {
    expect(escapeReference('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("dedupeReferences / existingReferencePaths", () => {
  it("collapses duplicate references keeping the first occurrence", () => {
    const text = "see @src/a.ts and @src/a.ts plus @src/b.ts";
    expect(dedupeReferences(text)).toBe("see @src/a.ts and plus @src/b.ts");
  });

  it("keys deduplication on the parsed path value (quoted forms collapse)", () => {
    const same = '@"a b/c.txt" again @"a b/c.txt"';
    expect(dedupeReferences(same)).toBe('@"a b/c.txt" again');
  });

  it("leaves distinct references untouched", () => {
    const text = "@src/a.ts and @src/b.ts";
    expect(dedupeReferences(text)).toBe(text);
  });

  it("reports the set of already-referenced paths", () => {
    const paths = existingReferencePaths('x @src/a.ts @"b c/d.ts" y');
    expect(paths.has("src/a.ts")).toBe(true);
    expect(paths.has("b c/d.ts")).toBe(true);
    expect(paths.size).toBe(2);
  });
});

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "src/index.ts")).toBeNull();
  });

  it("matches a subsequence and scores contiguous/boundary hits higher", () => {
    const contiguous = fuzzyScore("index", "src/index.ts");
    const scattered = fuzzyScore("index", "i/n/d/e/x.txt");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!).toBeGreaterThan(scattered!);
  });

  it("an empty query matches everything with a neutral score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("README", "docs/readme.md")).not.toBeNull();
  });
});

describe("looksBinary / looksLikeSecretPath", () => {
  it("flags NUL-bearing content as binary", () => {
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x69]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
  });

  it("flags common secret shapes", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/.env.production",
      "secrets/api_key.json",
      "id_rsa",
      ".ssh/id_ed25519",
      "certs/server.pem",
      "keystore/app.keystore",
      "terraform.tfstate",
      "credentials.json",
    ]) {
      expect(looksLikeSecretPath(p)).toBe(true);
    }
  });

  it("does not flag ordinary source files", () => {
    for (const p of [
      "src/index.ts",
      "docs/README.md",
      "lib/secret_sauce.test.ts", // 'secret' as a word in a test name is not a credential file
      "config/settings.json",
      "public/key.txt",
    ]) {
      expect(looksLikeSecretPath(p)).toBe(false);
    }
  });
});

describe("formatReferenceSize / formatReferencePreview", () => {
  it("renders directories as a dir label", () => {
    expect(formatReferenceSize("directory", 0)).toBe("dir");
  });

  it("renders byte sizes in binary units", () => {
    expect(formatReferenceSize("file", 0)).toBe("—");
    expect(formatReferenceSize("file", 512)).toBe("512 B");
    expect(formatReferenceSize("file", 4300)).toBe("4.2 KB");
  });

  it("previews type, path, and size with an ASCII label", () => {
    const c: ReferenceCandidate = { path: "src/index.ts", type: "file", sizeBytes: 4300, score: 1 };
    const line = formatReferencePreview(c, 200);
    expect(line).toContain("file");
    expect(line).toContain("src/index.ts");
    expect(line).toContain("4.2 KB");
  });

  it("clips an over-wide preview with an ellipsis", () => {
    const c: ReferenceCandidate = { path: "a".repeat(300), type: "file", sizeBytes: 1, score: 1 };
    expect(Array.from(formatReferencePreview(c, 80)).length).toBeLessThanOrEqual(80);
  });
});

// --- filesystem-backed collection -------------------------------------------

describe("collectWorkspaceReferences", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ref-"));
    ws = new Workspace(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = "x"): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it("enumerates files and directories within the workspace", () => {
    write("src/index.ts");
    write("src/util.ts");
    write("README.md");
    const u = collectWorkspaceReferences(ws);
    const paths = u.entries.map((e) => e.path);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/util.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain("src"); // directory is a candidate too
    expect(u.state).toBe("ok");
  });

  it("honors .gitignore and skips generated directories", () => {
    write(".gitignore", "secret.log\nbuild/\n");
    write("keep.ts");
    write("secret.log");
    write("build/out.js");
    write("node_modules/pkg/index.js");
    const u = collectWorkspaceReferences(ws);
    const paths = u.entries.map((e) => e.path);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("secret.log");
    expect(paths).not.toContain("build/out.js");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(u.excluded.ignored).toBeGreaterThan(0);
  });

  it("excludes binary files by extension", () => {
    write("logo.png", "not really png but ext matters");
    write("app.ts");
    const u = collectWorkspaceReferences(ws);
    const paths = u.entries.map((e) => e.path);
    expect(paths).toContain("app.ts");
    expect(paths).not.toContain("logo.png");
    expect(u.excluded.binary).toBeGreaterThan(0);
  });

  it("excludes likely-secret material", () => {
    write(".env", "TOKEN=abc");
    write("config/credentials.json", "{}");
    write("src/main.ts");
    const u = collectWorkspaceReferences(ws);
    const paths = u.entries.map((e) => e.path);
    expect(paths).toContain("src/main.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("config/credentials.json");
    expect(u.excluded.secret).toBeGreaterThan(0);
  });

  it("never follows symlinks (workspace containment)", () => {
    write("inside.ts");
    // A sibling directory outside the workspace with a file that must never be
    // reached, plus a symlink inside the workspace pointing at it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ref-out-"));
    try {
      fs.writeFileSync(path.join(outside, "leak.ts"), "secret");
      fs.symlinkSync(outside, path.join(root, "link"));
      const u = collectWorkspaceReferences(ws);
      const paths = u.entries.map((e) => e.path);
      expect(paths).toContain("inside.ts");
      // The symlink is neither descended into nor reported as a candidate.
      expect(paths.some((p) => p.startsWith("link/") || p === "link" || p.includes("leak"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports an empty workspace explicitly", () => {
    const u = collectWorkspaceReferences(ws);
    expect(u.state).toBe("empty");
    expect(u.entries).toHaveLength(0);
  });

  it("refuses an untrusted workspace without walking", () => {
    write("a.ts");
    const u = collectWorkspaceReferences(ws, { trusted: false });
    expect(u.state).toBe("untrusted");
    expect(u.entries).toHaveLength(0);
  });

  it("reports an unreadable workspace root explicitly", () => {
    const missing = new Workspace(path.join(root, "does-not-exist"));
    const u = collectWorkspaceReferences(missing);
    expect(u.state).toBe("unreadable");
  });
});

describe("filterReferences", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ref-f-"));
    ws = new Workspace(root);
    fs.writeFileSync(path.join(root, "alpha.ts"), "x");
    fs.writeFileSync(path.join(root, "beta.ts"), "x");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "alpha-deep.ts"), "x");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("filters by query and ranks the closer match first", () => {
    const u = collectWorkspaceReferences(ws);
    const f = filterReferences(u, "alpha");
    expect(f.state).toBe("ok");
    expect(f.candidates[0].path).toBe("alpha.ts"); // shorter/closer beats nested
    expect(f.candidates.map((c) => c.path)).toContain("nested/alpha-deep.ts");
  });

  it("returns no-match when the query matches nothing", () => {
    const u = collectWorkspaceReferences(ws);
    const f = filterReferences(u, "zzz-nope");
    expect(f.state).toBe("no-match");
    expect(f.candidates).toHaveLength(0);
  });

  it("caps results and flags truncation", () => {
    const u = collectWorkspaceReferences(ws);
    const f = filterReferences(u, "", 1);
    expect(f.candidates).toHaveLength(1);
    expect(f.total).toBeGreaterThan(1);
    expect(f.truncated).toBe(true);
  });

  it("passes refusal states through unchanged", () => {
    const untrusted = collectWorkspaceReferences(ws, { trusted: false });
    expect(filterReferences(untrusted, "a").state).toBe("untrusted");
  });

  it("collectReferenceCandidates collects and filters in one call", () => {
    const f = collectReferenceCandidates(ws, "beta");
    expect(f.candidates.map((c) => c.path)).toContain("beta.ts");
  });
});
