import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  estimateTokens,
  composeContext,
  formatComposedContext,
  composedContextsEqual,
  type ComposerOptions,
} from "../../src/context-composer.js";
import { createContextReference } from "../../src/context-reference.js";

// Fixture-based coverage for the context composer (Issue #334): token
// estimation, provenance tracking, exclusion reasons, trust flags, budget
// enforcement, and surface independence. Fixtures are built in a temp
// workspace; nothing outside it is touched.

let tmpDir: string;
let ws: Workspace;

const DEFAULT_OPTS: ComposerOptions = { trusted: true, ignore: true };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-test-"));
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

// --- token estimation -------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates tokens from character count", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// --- basic composition ------------------------------------------------------

describe("composeContext", () => {
  it("includes a simple file with provenance and token estimate", () => {
    write("src/app.ts", "export function main() {\n  return 42;\n}\n");

    const ref = createContextReference("src/app.ts", "tree");
    const ctx = composeContext(ws, [ref], DEFAULT_OPTS);

    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].ref.path).toBe("src/app.ts");
    expect(ctx.items[0].provenance).toBe("tree");
    expect(ctx.items[0].trusted).toBe(true);
    expect(ctx.items[0].estimatedTokens).toBeGreaterThan(0);
    expect(ctx.items[0].lines.length).toBe(4);
    expect(ctx.items[0].startLine).toBe(1);
    expect(ctx.exclusions.length).toBe(0);
    expect(ctx.usedTokens).toBe(ctx.items[0].estimatedTokens);
    expect(ctx.remainingTokens).toBe(ctx.budget - ctx.usedTokens);
  });

  it("respects line ranges from references", () => {
    write("a.ts", "line1\nline2\nline3\nline4\nline5\n");

    const ref = createContextReference("a.ts", "search", { start: 2, end: 4 });
    const ctx = composeContext(ws, [ref], DEFAULT_OPTS);

    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].lines).toEqual(["line2", "line3", "line4"]);
    expect(ctx.items[0].startLine).toBe(2);
    expect(ctx.items[0].totalLines).toBe(6); // includes trailing empty
  });

  it("composes multiple references in order", () => {
    write("a.ts", "aaa\n");
    write("b.ts", "bbb\n");

    const refs = [
      createContextReference("a.ts", "tree"),
      createContextReference("b.ts", "search"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);

    expect(ctx.items.length).toBe(2);
    expect(ctx.items[0].ref.path).toBe("a.ts");
    expect(ctx.items[1].ref.path).toBe("b.ts");
    expect(ctx.items[0].provenance).toBe("tree");
    expect(ctx.items[1].provenance).toBe("search");
  });
});

// --- exclusion reasons ------------------------------------------------------

describe("exclusions", () => {
  it("excludes ignored paths with reason", () => {
    write(".gitignore", "*.log");
    write("debug.log", "log content");
    write("app.ts", "code");

    const refs = [
      createContextReference("debug.log", "manual"),
      createContextReference("app.ts", "manual"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);

    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].ref.path).toBe("app.ts");
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].path).toBe("debug.log");
    expect(ctx.exclusions[0].reason).toBe("ignored");
  });

  it("excludes paths under built-in skip directories", () => {
    write("node_modules/pkg/index.js", "module.exports = {}");
    write("src/app.ts", "code");

    const refs = [
      createContextReference("node_modules/pkg/index.js", "picker"),
      createContextReference("src/app.ts", "tree"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);

    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].ref.path).toBe("src/app.ts");
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].path).toBe("node_modules/pkg/index.js");
    expect(ctx.exclusions[0].reason).toBe("ignored");
  });

  it("excludes binary files with reason", () => {
    writeBinary("image.png");

    const ref = createContextReference("image.png", "manual");
    const ctx = composeContext(ws, [ref], DEFAULT_OPTS);

    expect(ctx.items.length).toBe(0);
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].reason).toBe("binary");
  });

  it("excludes secret paths with reason", () => {
    write(".env", "SECRET=abc");
    write("id_rsa", "private key");

    const refs = [
      createContextReference(".env", "manual"),
      createContextReference("id_rsa", "manual"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);

    expect(ctx.items.length).toBe(0);
    expect(ctx.exclusions.length).toBe(2);
    expect(ctx.exclusions[0].reason).toBe("secret");
    expect(ctx.exclusions[1].reason).toBe("secret");
  });

  it("excludes oversized files with reason", () => {
    write("big.ts", "x".repeat(600_000));

    const ref = createContextReference("big.ts", "manual");
    const ctx = composeContext(ws, [ref], { ...DEFAULT_OPTS, maxFileBytes: 512 * 1024 });

    expect(ctx.items.length).toBe(0);
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].reason).toBe("oversized");
    expect(ctx.exclusions[0].detail).toContain("bytes");
  });

  it("excludes unreadable files with reason", () => {
    const ref = createContextReference("nonexistent.ts", "manual");
    const ctx = composeContext(ws, [ref], DEFAULT_OPTS);

    expect(ctx.items.length).toBe(0);
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].reason).toBe("unreadable");
  });

  it("excludes paths with .. as outside-workspace", () => {
    // createContextReference validates and throws for .. paths, so test
    // composeContext directly with a raw reference-shaped object.
    const ctx = composeContext(ws, [{
      schema: "oh-my-cli.context-reference" as const,
      v: 1 as const,
      path: "../escape.ts",
      provenance: "manual" as const,
    }], DEFAULT_OPTS);

    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].reason).toBe("outside-workspace");
  });

  it("excludes untrusted workspace entirely", () => {
    write("a.ts", "code");

    const ref = createContextReference("a.ts", "manual");
    const ctx = composeContext(ws, [ref], { trusted: false });

    expect(ctx.items.length).toBe(0);
    expect(ctx.exclusions.length).toBe(1);
    expect(ctx.exclusions[0].reason).toBe("untrusted");
  });
});

// --- budget enforcement -----------------------------------------------------

describe("budget enforcement", () => {
  it("drops items that exceed the budget", () => {
    write("small.ts", "ok\n");
    write("large.ts", "x".repeat(40_000)); // ~10k tokens

    const refs = [
      createContextReference("small.ts", "tree"),
      createContextReference("large.ts", "tree"),
    ];
    // Budget of 100 tokens: small.ts fits, large.ts does not.
    const ctx = composeContext(ws, refs, { ...DEFAULT_OPTS, budget: 100 });

    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].ref.path).toBe("small.ts");
    expect(ctx.budgetExceeded).toBe(true);
    expect(ctx.exclusions.some((e) => e.reason === "over-budget")).toBe(true);
  });

  it("tracks used and remaining tokens", () => {
    write("a.ts", "aaaa\n"); // 5 chars + newline = ~2 tokens

    const ref = createContextReference("a.ts", "manual");
    const ctx = composeContext(ws, [ref], { ...DEFAULT_OPTS, budget: 1000 });

    expect(ctx.usedTokens).toBeGreaterThan(0);
    expect(ctx.remainingTokens).toBe(1000 - ctx.usedTokens);
    expect(ctx.budgetExceeded).toBe(false);
  });
});

// --- trust flags ------------------------------------------------------------

describe("trust flags", () => {
  it("marks all items as trusted in a trusted workspace", () => {
    write("a.ts", "code");
    write("b.ts", "code");

    const refs = [
      createContextReference("a.ts", "tree"),
      createContextReference("b.ts", "search"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);

    expect(ctx.hasUntrusted).toBe(false);
    expect(ctx.items.every((i) => i.trusted)).toBe(true);
  });
});

// --- surface independence ---------------------------------------------------

describe("surface independence", () => {
  it("produces identical output for the same references regardless of provenance label", () => {
    write("src/mod.ts", "export const x = 1;\n");

    // Same path, different provenance (simulating TUI vs Desktop source).
    const refTree = createContextReference("src/mod.ts", "tree");
    const refPicker = createContextReference("src/mod.ts", "picker");

    const ctxA = composeContext(ws, [refTree], DEFAULT_OPTS);
    const ctxB = composeContext(ws, [refPicker], DEFAULT_OPTS);

    // Content and token estimates are identical.
    expect(ctxA.items[0].lines).toEqual(ctxB.items[0].lines);
    expect(ctxA.items[0].estimatedTokens).toBe(ctxB.items[0].estimatedTokens);
    expect(ctxA.usedTokens).toBe(ctxB.usedTokens);
    expect(ctxA.exclusions).toEqual(ctxB.exclusions);
  });

  it("composedContextsEqual verifies structural equality", () => {
    write("a.ts", "code\n");

    const ref = createContextReference("a.ts", "tree");
    const ctxA = composeContext(ws, [ref], DEFAULT_OPTS);
    const ctxB = composeContext(ws, [ref], DEFAULT_OPTS);

    expect(composedContextsEqual(ctxA, ctxB)).toBe(true);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatComposedContext", () => {
  it("renders budget, items, and exclusions", () => {
    write("app.ts", "hello\n");
    write(".env", "SECRET=x");

    const refs = [
      createContextReference("app.ts", "tree"),
      createContextReference(".env", "manual"),
    ];
    const ctx = composeContext(ws, refs, DEFAULT_OPTS);
    const output = formatComposedContext(ctx);

    expect(output).toContain("Context Composition");
    expect(output).toContain("tokens");
    expect(output).toContain("app.ts");
    expect(output).toContain("[tree]");
    expect(output).toContain(".env");
    expect(output).toContain("secret");
  });

  it("shows budget warning when exceeded", () => {
    write("big.ts", "x".repeat(4000));

    const ref = createContextReference("big.ts", "manual");
    const ctx = composeContext(ws, [ref], { ...DEFAULT_OPTS, budget: 10 });
    const output = formatComposedContext(ctx);

    expect(output).toContain("Budget exceeded");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("does not mutate the workspace", () => {
    write("a.ts", "original");
    const before = fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8");

    const ref = createContextReference("a.ts", "manual");
    composeContext(ws, [ref], DEFAULT_OPTS);

    expect(fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8")).toBe(before);
  });
});
