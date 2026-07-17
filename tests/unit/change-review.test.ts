import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reviewChange,
  formatChangeReviewReport,
  buildChangeReviewReport,
  isTestPath,
  isSourcePath,
  isProtectedPath,
  CHANGE_REVIEW_SCHEMA,
  CHANGE_REVIEW_VERSION,
} from "../../src/change-review.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cr-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function write(dir: string, rel: string, content = ""): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

// Stage all current changes so `git diff HEAD` observes them (untracked files
// are otherwise invisible to git diff).
function stage(dir: string): void {
  git(dir, ["add", "-A"]);
}

const SECRET = "ghp_" + "a".repeat(36);

// A clean baseline fact set for the pure builder; override per case.
function facts(over: Partial<Parameters<typeof buildChangeReviewReport>[0]> = {}) {
  return {
    head: "f".repeat(40),
    base: { ref: "origin/main", sha: "0".repeat(40) },
    files: [{ path: "src/foo.ts", status: "M", added: 3, removed: 1, binary: false }],
    linesAdded: 3,
    linesRemoved: 1,
    binaryFiles: 0,
    maxFileAdded: 3,
    secretLines: 0,
    dependencyChange: null,
    ...over,
  };
}

describe("path classifiers", () => {
  it("isTestPath recognizes test dirs and .test/.spec suffixes", () => {
    expect(isTestPath("tests/unit/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("lib/foo.spec.js")).toBe(true);
    expect(isTestPath("__tests__/foo.py")).toBe(true);
    expect(isTestPath("src/foo.ts")).toBe(false);
  });

  it("isSourcePath recognizes code under source dirs, excluding tests", () => {
    expect(isSourcePath("src/foo.ts")).toBe(true);
    expect(isSourcePath("lib/bar.go")).toBe(true);
    expect(isSourcePath("src/foo.test.ts")).toBe(false);
    expect(isSourcePath("tests/foo.ts")).toBe(false);
    expect(isSourcePath("README.md")).toBe(false);
    expect(isSourcePath("package.json")).toBe(false);
  });

  it("isProtectedPath recognizes governance / security / license files", () => {
    expect(isProtectedPath("AUTONOMY.md")).toBe(true);
    expect(isProtectedPath("SECURITY.md")).toBe(true);
    expect(isProtectedPath("LICENSE")).toBe(true);
    expect(isProtectedPath(".autonomy/prompts/coordinator.md")).toBe(true);
    expect(isProtectedPath("src/foo.ts")).toBe(false);
  });
});

describe("buildChangeReviewReport (pure)", () => {
  it("returns no-change for an empty change set", () => {
    const r = buildChangeReviewReport(facts({ files: [] }));
    expect(r.verdict).toBe("no-change");
    expect(r.filesChanged).toBe(0);
    expect(r.signals.protectedPaths).toEqual([]);
    expect(r.signals.secretsIntroduced).toBe(0);
  });

  it("returns clean when no objective signal fires", () => {
    const r = buildChangeReviewReport(
      facts({
        files: [
          { path: "src/foo.ts", status: "M", added: 3, removed: 1, binary: false },
          { path: "tests/unit/foo.test.ts", status: "M", added: 5, removed: 0, binary: false },
        ],
      }),
    );
    expect(r.verdict).toBe("clean");
    expect(r.signals.sourceWithoutTests).toBe(false);
  });

  it("flags secrets introduced (count only, never the literal)", () => {
    const r = buildChangeReviewReport(facts({ secretLines: 2 }));
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.secretsIntroduced).toBe(2);
  });

  it("flags protected-path mutation", () => {
    const r = buildChangeReviewReport(
      facts({ files: [{ path: "AUTONOMY.md", status: "M", added: 1, removed: 0, binary: false }] }),
    );
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.protectedPaths).toContain("AUTONOMY.md");
  });

  it("flags source changed without tests", () => {
    const r = buildChangeReviewReport(
      facts({ files: [{ path: "src/foo.ts", status: "M", added: 10, removed: 0, binary: false }] }),
    );
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.sourceWithoutTests).toBe(true);
  });

  it("flags an oversized change (per-file, total-line, and file-count bounds)", () => {
    expect(buildChangeReviewReport(facts({ maxFileAdded: 801 })).signals.oversized).toBe(true);
    expect(
      buildChangeReviewReport(facts({ linesAdded: 4001, linesRemoved: 0 })).signals.oversized,
    ).toBe(true);
    const many = Array.from({ length: 61 }, (_, i) => ({
      path: `src/f${i}.ts`,
      status: "A",
      added: 1,
      removed: 0,
      binary: false,
    }));
    const r = buildChangeReviewReport(facts({ files: many }));
    expect(r.signals.oversized).toBe(true);
    expect(r.filesTruncated).toBe(true);
    expect(r.files.length).toBe(60);
    expect(r.filesChanged).toBe(61);
  });

  it("flags an added runtime dependency", () => {
    const r = buildChangeReviewReport(
      facts({ dependencyChange: { added: ["zod"], removed: [] } }),
    );
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.dependencies?.added).toContain("zod");
  });

  it("is deterministic for identical facts", () => {
    const f = facts({ secretLines: 1 });
    expect(buildChangeReviewReport(f)).toEqual(buildChangeReviewReport(f));
  });

  it("carries schema/version and head/base binding", () => {
    const r = buildChangeReviewReport(facts());
    expect(r.schema).toBe(CHANGE_REVIEW_SCHEMA);
    expect(r.v).toBe(CHANGE_REVIEW_VERSION);
    expect(r.head).toBe("f".repeat(40));
    expect(r.base.ref).toBe("origin/main");
  });
});

describe("reviewChange (real git)", () => {
  it("reports no-change for a clean repository", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.verdict).toBe("no-change");
    expect(r.filesChanged).toBe(0);
  });

  it("binds the verdict to the repository head SHA", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("flags source changed without a corresponding test change", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.sourceWithoutTests).toBe(true);
  });

  it("is clean when a source change is accompanied by tests", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.verdict).toBe("clean");
    expect(r.signals.sourceWithoutTests).toBe(false);
  });

  it("flags a secret-like string introduced in the diff without leaking the literal", () => {
    const dir = tmp();
    write(dir, "notes.txt", "hello\n");
    initRepo(dir);
    write(dir, "notes.txt", `hello\n${SECRET}\n`);
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.secretsIntroduced).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("flags protected governance path mutation", () => {
    const dir = tmp();
    write(dir, "SECURITY.md", "# Security\n");
    initRepo(dir);
    write(dir, "SECURITY.md", "# Security\n\nUpdated.\n");
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.verdict).toBe("needs-attention");
    expect(r.signals.protectedPaths).toContain("SECURITY.md");
  });

  it("reports added runtime dependencies when package.json changes", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ dependencies: { a: "1.0.0" } }));
    initRepo(dir);
    write(dir, "package.json", JSON.stringify({ dependencies: { a: "1.0.0", b: "2.0.0" } }));
    stage(dir);
    const r = reviewChange({ workspace: dir });
    expect(r.signals.dependencies?.added).toContain("b");
    expect(r.verdict).toBe("needs-attention");
  });

  it("never leaks the workspace path or secrets in the JSON brief", () => {
    const dir = tmp();
    write(dir, "leak.txt", "start\n");
    initRepo(dir);
    write(dir, "leak.txt", `start\n${SECRET}\n${dir}/src/secret.ts\n`);
    stage(dir);
    const json = JSON.stringify(reviewChange({ workspace: dir }));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(dir);
  });

  it("includes untracked new files in the change set (git diff alone would omit them)", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    // A brand-new source file, deliberately NOT staged.
    write(dir, "src/newmodule.ts", "export const z = 3;\nexport const w = 4;\n");
    const r = reviewChange({ workspace: dir });
    const added = r.files.find((f) => f.path === "src/newmodule.ts");
    expect(added).toBeDefined();
    expect(added?.status).toBe("A");
    expect(added?.added).toBe(2);
    expect(r.signals.sourceWithoutTests).toBe(true);
  });

  it("counts a secret-like string in an untracked file without leaking it", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n`);
    const r = reviewChange({ workspace: dir });
    expect(r.signals.secretsIntroduced).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("returns no-change with a null head outside a git repository", () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    const r = reviewChange({ workspace: dir });
    expect(r.head).toBeNull();
    expect(r.base.sha).toBeNull();
    expect(r.verdict).toBe("no-change");
  });
});

describe("formatChangeReviewReport", () => {
  it("renders a clean brief", () => {
    const r = buildChangeReviewReport(
      facts({
        files: [
          { path: "src/foo.ts", status: "M", added: 3, removed: 1, binary: false },
          { path: "tests/unit/foo.test.ts", status: "A", added: 5, removed: 0, binary: false },
        ],
        linesAdded: 8,
        linesRemoved: 1,
      }),
    );
    const text = formatChangeReviewReport(r);
    expect(text).toContain("Change review (oh-my-cli.change-review v1)");
    expect(text).toContain("Verdict: clean");
    expect(text).toContain("src/foo.ts");
    expect(text).toContain("Source w/o tests   : no");
  });

  it("renders a no-change brief", () => {
    const text = formatChangeReviewReport(buildChangeReviewReport(facts({ files: [] })));
    expect(text).toContain("Verdict: no-change");
    expect(text).toContain("No changes relative to base.");
  });

  it("renders a needs-attention brief with signals", () => {
    const r = buildChangeReviewReport(
      facts({
        secretLines: 1,
        files: [{ path: "AUTONOMY.md", status: "M", added: 2, removed: 0, binary: false }],
      }),
    );
    const text = formatChangeReviewReport(r);
    expect(text).toContain("Verdict: needs-attention");
    expect(text).toContain("Secrets introduced : 1 added line(s)");
    expect(text).toContain("AUTONOMY.md");
  });
});
