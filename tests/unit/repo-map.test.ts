import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  languageForPath,
  extractSymbols,
  scoreMapFile,
  buildRepoMap,
  collectRepoMap,
  formatRepoMap,
  tokensToBudgetChars,
  DEFAULT_MAP_BUDGET_CHARS,
} from "../../src/repo-map.js";
import type { MapFileInput } from "../../src/repo-map.js";

// Pure-function and filesystem-backed coverage for the bounded repository-map
// engine (Issue #205, acceptance criteria 1-5): symbol extraction across
// languages, relevance ranking, token/char budgeting and truncation, ignore /
// binary / secret exclusion, workspace containment (no symlink escape), and the
// explicit empty / untrusted / unreadable refusals. Fixtures are built in a temp
// workspace; nothing outside it is touched.

describe("languageForPath", () => {
  it("maps recognized source extensions to a language", () => {
    expect(languageForPath("src/index.ts")).toBe("ts");
    expect(languageForPath("a.jsx")).toBe("js");
    expect(languageForPath("a.py")).toBe("py");
    expect(languageForPath("a.rs")).toBe("rs");
    expect(languageForPath("a.go")).toBe("go");
    expect(languageForPath("Main.java")).toBe("java");
    expect(languageForPath("a.cpp")).toBe("clike");
  });

  it("returns null for non-code files so they never enter the map", () => {
    expect(languageForPath("README.md")).toBeNull();
    expect(languageForPath("package.json")).toBeNull();
    expect(languageForPath("logo.png")).toBeNull();
    expect(languageForPath("notes.txt")).toBeNull();
  });
});

describe("extractSymbols", () => {
  it("extracts top-level TypeScript declarations by kind", () => {
    const src = [
      "export function runAgent(opts: Opts): Promise<R> {",
      "  return helper();", // nested body line, not a declaration
      "}",
      "export class Agent {",
      "  private field = 1;", // nested member, not top-level
      "}",
      "export interface Options {",
      "export type Result = {",
      "export const MAX = 10;",
      "export enum Color {",
    ].join("\n");
    const syms = extractSymbols("src/agent.ts", src);
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get("runAgent")).toBe("function");
    expect(byName.get("Agent")).toBe("class");
    expect(byName.get("Options")).toBe("interface");
    expect(byName.get("Result")).toBe("type");
    expect(byName.get("MAX")).toBe("const");
    expect(byName.get("Color")).toBe("enum");
    // Nested members are not mapped.
    expect(byName.has("helper")).toBe(false);
    expect(byName.has("field")).toBe(false);
  });

  it("extracts Python top-level defs and classes only", () => {
    const src = [
      "class Service:",
      "    def method(self):", // indented -> nested, ignored
      "        return 1",
      "def top_level(arg):",
      "    return arg",
      "async def fetch():",
      "    pass",
    ].join("\n");
    const syms = extractSymbols("svc.py", src);
    const names = syms.map((s) => s.name);
    expect(names).toContain("Service");
    expect(names).toContain("top_level");
    expect(names).toContain("fetch");
    expect(names).not.toContain("method");
  });

  it("extracts Rust and Go declarations", () => {
    const rs = ["pub fn parse(input: &str) -> Ast {", "struct Engine {", "impl Engine {", "trait Mappable {"].join("\n");
    const rsNames = new Set(extractSymbols("e.rs", rs).map((s) => s.name));
    expect(rsNames).toContain("parse");
    expect(rsNames).toContain("Engine");
    expect(rsNames).toContain("Mappable");

    const go = ["func (s *Server) Start() error {", "func main() {", "type Config struct {"].join("\n");
    const goNames = new Set(extractSymbols("m.go", go).map((s) => s.name));
    expect(goNames).toContain("Start");
    expect(goNames).toContain("main");
    expect(goNames).toContain("Config");
  });

  it("returns nothing for unrecognized languages", () => {
    expect(extractSymbols("README.md", "# Title\n\nsome text")).toHaveLength(0);
    expect(extractSymbols("data.json", '{"a": 1}')).toHaveLength(0);
  });

  it("bounds the number of symbols per file", () => {
    const many = Array.from({ length: 60 }, (_v, i) => `export function fn${i}() {`).join("\n");
    expect(extractSymbols("big.ts", many).length).toBe(40);
  });

  it("redacts secret-shaped values inside a signature", () => {
    // Low-entropy decoy: redacted by the product's known-token rule but not a
    // scanner-flaggable secret, so it never trips the repo's own secret scan.
    const src = 'export const API_KEY = "sk-aaaaaaaaaaaaaaaaaaaa";';
    const sig = extractSymbols("cfg.ts", src)[0].signature;
    expect(sig).not.toContain("sk-aaaa");
  });
});

describe("scoreMapFile", () => {
  it("ranks files with more symbols higher", () => {
    expect(scoreMapFile("src/a.ts", 5)).toBeGreaterThan(scoreMapFile("src/b.ts", 1));
  });

  it("bonuses entry-point names and top-level source dirs", () => {
    expect(scoreMapFile("src/index.ts", 2)).toBeGreaterThan(scoreMapFile("src/util.ts", 2));
    expect(scoreMapFile("src/x.ts", 2)).toBeGreaterThan(scoreMapFile("vendor/x.ts", 2));
  });

  it("penalizes depth and test files", () => {
    expect(scoreMapFile("a.ts", 2)).toBeGreaterThan(scoreMapFile("a/b/c/d.ts", 2));
    expect(scoreMapFile("src/thing.ts", 2)).toBeGreaterThan(scoreMapFile("src/thing.test.ts", 2));
  });
});

describe("buildRepoMap (pure engine)", () => {
  const inputs: MapFileInput[] = [
    { path: "src/index.ts", content: "export function main() {\nexport class App {\n" },
    { path: "src/util.ts", content: "export function helper() {\n" },
    { path: "README.md", content: "# docs\n\nno symbols here\n" },
  ];

  it("keeps only symbol-bearing files and ranks the richer one first", () => {
    const map = buildRepoMap(inputs, { budgetChars: 100_000 });
    expect(map.files.map((f) => f.path)).toEqual(["src/index.ts", "src/util.ts"]);
    expect(map.totalFiles).toBe(2);
    expect(map.truncated).toBe(false);
  });

  it("truncates to the budget and flags it", () => {
    const small = buildRepoMap(inputs, { budgetChars: 35 });
    expect(small.files.length).toBe(1);
    expect(small.files[0].path).toBe("src/index.ts");
    expect(small.truncated).toBe(true);
    expect(small.usedChars).toBeLessThanOrEqual(35);
  });

  it("cuts symbols within a file when the budget runs out mid-file", () => {
    const oneBig: MapFileInput[] = [
      {
        path: "big.ts",
        content: Array.from({ length: 10 }, (_v, i) => `export function fn${i}(argNumber${i}: T) {`).join("\n"),
      },
    ];
    const full = buildRepoMap(oneBig, { budgetChars: 100_000 });
    const cut = buildRepoMap(oneBig, { budgetChars: 80 });
    expect(full.files[0].symbols.length).toBe(10);
    expect(cut.files[0].symbols.length).toBeLessThan(10);
    expect(cut.files[0].symbols.length).toBeGreaterThan(0);
    expect(cut.truncated).toBe(true);
  });

  it("is deterministic for a fixed input", () => {
    const a = buildRepoMap(inputs, { budgetChars: 100_000 });
    const b = buildRepoMap(inputs, { budgetChars: 100_000 });
    expect(a).toEqual(b);
  });
});

describe("tokensToBudgetChars", () => {
  it("approximates 4 chars per token", () => {
    expect(tokensToBudgetChars(1024)).toBe(4096);
    expect(tokensToBudgetChars(1)).toBe(4);
  });

  it("falls back to the default budget for non-positive or invalid input", () => {
    expect(tokensToBudgetChars(0)).toBe(DEFAULT_MAP_BUDGET_CHARS);
    expect(tokensToBudgetChars(-5)).toBe(DEFAULT_MAP_BUDGET_CHARS);
    expect(tokensToBudgetChars(Number.NaN)).toBe(DEFAULT_MAP_BUDGET_CHARS);
  });
});

describe("formatRepoMap", () => {
  it("renders the header, files, and signatures", () => {
    const map = buildRepoMap(
      [{ path: "src/index.ts", content: "export function main() {\nexport class App {\n" }],
      { budgetChars: 100_000 },
    );
    const snapshot = collectFromCore(map);
    const text = formatRepoMap(snapshot);
    expect(text).toContain("Repository map (oh-my-cli.repo-map v1)");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("export function main()");
    expect(text).toContain("export class App");
  });

  it("renders refusal states explicitly", () => {
    expect(formatRepoMap(emptySnapshot("untrusted"))).toContain("untrusted");
    expect(formatRepoMap(emptySnapshot("unreadable"))).toContain("unreadable");
    expect(formatRepoMap(emptySnapshot("empty"))).toContain("empty");
  });
});

// --- filesystem-backed collection -------------------------------------------

describe("collectRepoMap", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-map-"));
    ws = new Workspace(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = "export const x = 1;\n"): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it("maps symbol-bearing source files in the workspace", () => {
    write("src/index.ts", "export function main() {\n");
    write("src/util.ts", "export function helper() {\n");
    const map = collectRepoMap(ws);
    expect(map.state).toBe("ok");
    expect(map.files.map((f) => f.path)).toContain("src/index.ts");
    expect(map.files.map((f) => f.path)).toContain("src/util.ts");
  });

  it("honors .gitignore and skips generated directories", () => {
    write(".gitignore", "generated/\n");
    write("src/keep.ts", "export function keep() {\n");
    write("generated/skip.ts", "export function skip() {\n");
    write("node_modules/pkg/index.ts", "export function dep() {\n");
    const map = collectRepoMap(ws);
    const paths = map.files.map((f) => f.path);
    expect(paths).toContain("src/keep.ts");
    expect(paths).not.toContain("generated/skip.ts");
    expect(paths).not.toContain("node_modules/pkg/index.ts");
    expect(map.excluded.ignored).toBeGreaterThan(0);
  });

  it("excludes binary files by content sniff", () => {
    write("src/app.ts", "export function app() {\n");
    // A .ts file carrying a NUL byte is binary and must be skipped.
    write("src/blob.ts", "export function a() {\n\u0000\u0000\u0000\n");
    const map = collectRepoMap(ws);
    const paths = map.files.map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("src/blob.ts");
    expect(map.excluded.binary).toBeGreaterThan(0);
  });

  it("excludes likely-secret material", () => {
    write("src/main.ts", "export function main() {\n");
    write("secrets/credentials.json", '{"token": "x"}');
    const map = collectRepoMap(ws);
    const paths = map.files.map((f) => f.path);
    expect(paths).toContain("src/main.ts");
    expect(paths).not.toContain("secrets/credentials.json");
    expect(map.excluded.secret).toBeGreaterThan(0);
  });

  it("never follows symlinks (workspace containment)", () => {
    write("inside.ts", "export function inside() {\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omc-map-out-"));
    try {
      fs.writeFileSync(path.join(outside, "leak.ts"), "export function leak() {\n");
      fs.symlinkSync(outside, path.join(root, "link"));
      const map = collectRepoMap(ws);
      const paths = map.files.map((f) => f.path);
      expect(paths).toContain("inside.ts");
      expect(paths.some((p) => p.startsWith("link/") || p.includes("leak"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("clips to the budget and reports truncation", () => {
    for (let i = 0; i < 20; i++) {
      write(`src/mod${i}.ts`, `export function fn${i}(arg: Type${i}): Result${i} {\n`);
    }
    const map = collectRepoMap(ws, { budgetChars: 200 });
    expect(map.state).toBe("ok");
    expect(map.usedChars).toBeLessThanOrEqual(200);
    expect(map.includedFiles).toBeLessThan(map.totalFiles);
    expect(map.truncated).toBe(true);
  });

  it("reports an empty workspace explicitly", () => {
    const map = collectRepoMap(ws);
    expect(map.state).toBe("empty");
    expect(map.files).toHaveLength(0);
  });

  it("refuses an untrusted workspace without walking", () => {
    write("a.ts", "export function a() {\n");
    const map = collectRepoMap(ws, { trusted: false });
    expect(map.state).toBe("untrusted");
    expect(map.files).toHaveLength(0);
    expect(map.filesScanned).toBe(0);
  });

  it("reports an unreadable workspace root explicitly", () => {
    const missing = new Workspace(path.join(root, "does-not-exist"));
    const map = collectRepoMap(missing);
    expect(map.state).toBe("unreadable");
  });
});

// --- helpers ----------------------------------------------------------------

// Build a minimal snapshot around a pure core for format tests.
function collectFromCore(core: ReturnType<typeof buildRepoMap>) {
  return {
    schema: "oh-my-cli.repo-map" as const,
    v: 1 as const,
    files: core.files,
    totalFiles: core.totalFiles,
    includedFiles: core.files.length,
    budgetChars: core.budgetChars,
    usedChars: core.usedChars,
    truncated: core.truncated,
    filesScanned: core.files.length,
    excluded: { binary: 0, secret: 0, ignored: 0 },
    state: "ok" as const,
  };
}

function emptySnapshot(state: "untrusted" | "unreadable" | "empty") {
  return {
    schema: "oh-my-cli.repo-map" as const,
    v: 1 as const,
    files: [],
    totalFiles: 0,
    includedFiles: 0,
    budgetChars: DEFAULT_MAP_BUDGET_CHARS,
    usedChars: 0,
    truncated: false,
    filesScanned: 0,
    excluded: { binary: 0, secret: 0, ignored: 0 },
    state,
  };
}
