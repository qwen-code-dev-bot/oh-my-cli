import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectRepoContext,
  formatRepoContext,
  REPO_CONTEXT_SCHEMA,
  REPO_CONTEXT_VERSION,
} from "../../src/repo-context.js";

// Throwaway directories under the OS temp dir, removed after each test.
const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
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

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("toolchain detection", () => {
  it("detects npm with manifest and lockfile", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    write(dir, "package-lock.json", "{}");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.toolchains).toEqual([
      { manager: "npm", manifest: "package.json", lockfile: "package-lock.json" },
    ]);
  });

  it("resolves the JS manager by lockfile precedence (pnpm, yarn, bun)", () => {
    const pnpm = tmp();
    write(pnpm, "package.json", "{}");
    write(pnpm, "pnpm-lock.yaml", "");
    expect(collectRepoContext({ workspace: pnpm }).toolchains[0].manager).toBe("pnpm");

    const yarn = tmp();
    write(yarn, "package.json", "{}");
    write(yarn, "yarn.lock", "");
    expect(collectRepoContext({ workspace: yarn }).toolchains[0].manager).toBe("yarn");

    const bun = tmp();
    write(bun, "package.json", "{}");
    write(bun, "bun.lockb", "");
    expect(collectRepoContext({ workspace: bun }).toolchains[0].manager).toBe("bun");
  });

  it("defaults to npm with no lockfile", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    expect(collectRepoContext({ workspace: dir }).toolchains).toEqual([
      { manager: "npm", manifest: "package.json" },
    ]);
  });

  it("detects cargo and go with their lockfiles", () => {
    const dir = tmp();
    write(dir, "Cargo.toml", "");
    write(dir, "Cargo.lock", "");
    write(dir, "go.mod", "");
    write(dir, "go.sum", "");
    const managers = collectRepoContext({ workspace: dir }).toolchains.map((t) => t.manager);
    // Sorted by manager name.
    expect(managers).toEqual(["cargo", "go"]);
    expect(collectRepoContext({ workspace: dir }).toolchains).toContainEqual({
      manager: "cargo",
      manifest: "Cargo.toml",
      lockfile: "Cargo.lock",
    });
  });

  it("detects python ecosystems (pip + poetry) and may report both", () => {
    const dir = tmp();
    write(dir, "requirements.txt", "flask\n");
    write(dir, "pyproject.toml", "[tool.poetry]\nname = \"x\"\n");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.toolchains).toContainEqual({ manager: "pip", manifest: "requirements.txt" });
    expect(snap.toolchains).toContainEqual({ manager: "poetry", manifest: "pyproject.toml" });
  });

  it("classifies a plain pyproject.toml as python (not poetry)", () => {
    const dir = tmp();
    write(dir, "pyproject.toml", "[build-system]\nrequires = []\n");
    expect(collectRepoContext({ workspace: dir }).toolchains).toContainEqual({
      manager: "python",
      manifest: "pyproject.toml",
    });
  });
});

describe("canonical command detection", () => {
  it("reads build/test/typecheck/lint from package.json scripts", () => {
    const dir = tmp();
    write(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." } }),
    );
    const { commands } = collectRepoContext({ workspace: dir });
    expect(commands.build).toEqual({ source: "package.json", command: "tsc" });
    expect(commands.test).toEqual({ source: "package.json", command: "vitest run" });
    expect(commands.typecheck).toEqual({ source: "package.json", command: "tsc --noEmit" });
    expect(commands.lint).toEqual({ source: "package.json", command: "eslint ." });
  });

  it("accepts type-check / tsc fallbacks for the typecheck command", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { "type-check": "tsc --noEmit" } }));
    expect(collectRepoContext({ workspace: dir }).commands.typecheck).toEqual({
      source: "package.json",
      command: "tsc --noEmit",
    });
  });

  it("reads canonical targets from a Makefile", () => {
    const dir = tmp();
    write(dir, "Makefile", "build:\n\techo build\n\ntest:\n\techo test\n\nlint: build\n\techo lint\n");
    const { commands } = collectRepoContext({ workspace: dir });
    expect(commands.build).toEqual({ source: "Makefile", command: "make build" });
    expect(commands.test).toEqual({ source: "Makefile", command: "make test" });
    expect(commands.lint).toEqual({ source: "Makefile", command: "make lint" });
    expect(commands.typecheck).toBeNull();
  });

  it("infers commands from pyproject tool sections", () => {
    const dir = tmp();
    write(
      dir,
      "pyproject.toml",
      "[tool.pytest.ini_options]\nminversion = 6\n\n[tool.mypy]\nstrict = true\n\n[tool.ruff]\nline-length = 100\n",
    );
    const { commands } = collectRepoContext({ workspace: dir });
    expect(commands.test).toEqual({ source: "pyproject.toml", command: "pytest" });
    expect(commands.typecheck).toEqual({ source: "pyproject.toml", command: "mypy" });
    expect(commands.lint).toEqual({ source: "pyproject.toml", command: "ruff" });
  });

  it("prefers package.json over Makefile for the same canonical command", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(dir, "Makefile", "test:\n\techo make-test\n");
    expect(collectRepoContext({ workspace: dir }).commands.test).toEqual({
      source: "package.json",
      command: "vitest run",
    });
  });

  it("reports null for every canonical command when none are defined", () => {
    const dir = tmp();
    const { commands } = collectRepoContext({ workspace: dir });
    expect(commands).toEqual({ build: null, test: null, typecheck: null, lint: null });
  });
});

describe("language detection", () => {
  it("groups TypeScript extensions and counts files", () => {
    const dir = tmp();
    write(dir, "src/a.ts", "");
    write(dir, "src/b.tsx", "");
    write(dir, "src/c.js", "");
    const snap = collectRepoContext({ workspace: dir });
    const ts = snap.languages.find((l) => l.language === "TypeScript");
    expect(ts?.files).toBe(2);
    expect(ts?.extensions).toEqual([".ts", ".tsx"]);
    expect(snap.languages.find((l) => l.language === "JavaScript")?.files).toBe(1);
  });

  it("does not descend into skipped directories (node_modules, .git)", () => {
    const dir = tmp();
    write(dir, "src/app.ts", "");
    write(dir, "node_modules/dep/index.js", "");
    write(dir, ".git/hooks/pre-commit.js", "");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.filesScanned).toBe(1);
    expect(snap.languages.find((l) => l.language === "JavaScript")).toBeUndefined();
  });

  it("buckets unmapped extensions into Other", () => {
    const dir = tmp();
    write(dir, "data.xyz", "");
    write(dir, "notes.md", "");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.languages.find((l) => l.language === "Other")?.extensions).toContain(".xyz");
  });

  it("flags languagesTruncated when distinct languages exceed the cap", () => {
    const dir = tmp();
    const exts = [
      ".ts", ".py", ".rs", ".go", ".java", ".rb", ".php", ".c", ".cpp", ".cs",
      ".swift", ".kt", ".scala", ".sh", ".md", ".json", ".yaml", ".toml", ".html",
      ".css", ".sql", ".vue", ".dart", ".lua", ".r", ".js",
    ];
    for (const ext of exts) write(dir, `f${ext}`, "");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.languages.length).toBe(25);
    expect(snap.languagesTruncated).toBe(true);
  });
});

describe("structure outline", () => {
  it("lists top-level entries sorted, marking directories", () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(dir, "README.md", "");
    write(dir, "package.json", "{}");
    const snap = collectRepoContext({ workspace: dir });
    const names = snap.structure.map((e) => `${e.name}:${e.type}`);
    expect(names).toEqual(["README.md:file", "package.json:file", "src:dir"]);
    expect(snap.structureOverflow).toBe(0);
  });

  it("bounds the outline and reports overflow beyond the cap", () => {
    const dir = tmp();
    for (let i = 0; i < 205; i++) write(dir, `file-${String(i).padStart(3, "0")}.txt`, "");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.structure.length).toBe(200);
    expect(snap.structureOverflow).toBe(5);
  });
});

describe("VCS state", () => {
  it("reports branch and clean state for a fresh repo", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    initRepo(dir);
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.vcs.repo).toBe(true);
    expect(snap.vcs.detached).toBe(false);
    expect(snap.vcs.branch).not.toBeNull();
    expect(snap.vcs.clean).toBe(true);
    expect(snap.vcs.dirtyCount).toBe(0);
  });

  it("counts uncommitted changes as dirty", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    initRepo(dir);
    write(dir, "scratch.txt", "uncommitted");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.vcs.clean).toBe(false);
    expect(snap.vcs.dirtyCount).toBeGreaterThanOrEqual(1);
  });

  it("reports a non-repository directory distinctly", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.vcs.repo).toBe(false);
    expect(snap.vcs.branch).toBeNull();
  });
});

describe("redaction, bounding, and determinism", () => {
  it("redacts secret-shaped values in detected commands", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    const snap = collectRepoContext({ workspace: dir });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(snap.commands.test?.command).toContain("[REDACTED]");
  });

  it("redacts a secret-shaped branch name", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    initRepo(dir);
    git(dir, ["checkout", "-q", "-b", `feature-${SECRET}`]);
    const snap = collectRepoContext({ workspace: dir });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
  });

  it("is deterministic and never leaks the workspace path", () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(dir, "package.json", JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    initRepo(dir);
    const a = JSON.stringify(collectRepoContext({ workspace: dir }));
    const b = JSON.stringify(collectRepoContext({ workspace: dir }));
    expect(a).toBe(b);
    expect(a).not.toContain(SECRET);
    expect(a).not.toContain(dir);
  });
});

describe("graceful degradation", () => {
  it("reports an empty, non-repo directory with unknowns", () => {
    const dir = tmp();
    const snap = collectRepoContext({ workspace: dir });
    expect(snap.schema).toBe(REPO_CONTEXT_SCHEMA);
    expect(snap.v).toBe(REPO_CONTEXT_VERSION);
    expect(snap.toolchains).toEqual([]);
    expect(snap.commands).toEqual({ build: null, test: null, typecheck: null, lint: null });
    expect(snap.languages).toEqual([]);
    expect(snap.structure).toEqual([]);
    expect(snap.vcs.repo).toBe(false);
  });
});

describe("formatRepoContext", () => {
  it("renders a populated snapshot with every section", () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run", typecheck: "tsc --noEmit" } }),
    );
    write(dir, "package-lock.json", "{}");
    initRepo(dir);
    const text = formatRepoContext(collectRepoContext({ workspace: dir }));
    expect(text).toContain("Repository context (oh-my-cli.repo-context v1)");
    expect(text).toContain("Toolchains : npm (package.json, package-lock.json)");
    expect(text).toContain("build");
    expect(text).toContain("[package.json] tsc");
    expect(text).toContain("lint");
    expect(text).toContain("—");
    expect(text).toContain("Languages  :");
    expect(text).toContain("TypeScript (1 file; .ts)");
    expect(text).toContain("VCS        : on");
  });

  it("renders an empty, non-repo directory with unknown placeholders", () => {
    const text = formatRepoContext(collectRepoContext({ workspace: tmp() }));
    expect(text).toContain("Toolchains : unknown");
    expect(text).toContain("Languages  : unknown");
    expect(text).toContain("Structure  : (empty)");
    expect(text).toContain("VCS        : not a git repository");
  });
});
