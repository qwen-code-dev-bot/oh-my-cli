import { describe, it, expect } from "vitest";
import {
  assembleNavigationResult,
  checkNavigationPolicy,
  symbolToReference,
  referenceToReference,
  formatNavigationResult,
  type NavigationPolicy,
  type GitBadge,
} from "../../src/semantic-navigation.js";

// Pure-function coverage for semantic navigation (Issue #333): symbol
// search, references, diagnostics, git-aware badges, policy enforcement,
// canonical reference conversion, and formatting.

const TRUSTED: NavigationPolicy = { trusted: true, ignore: true };
const UNTRUSTED: NavigationPolicy = { trusted: false, ignore: true };

// --- policy enforcement -----------------------------------------------------

describe("policy enforcement", () => {
  it("allows normal source files", () => {
    expect(checkNavigationPolicy("src/app.ts", TRUSTED)).toEqual({ allowed: true });
  });

  it("blocks untrusted workspace", () => {
    const result = checkNavigationPolicy("src/app.ts", UNTRUSTED);
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe("untrusted");
  });

  it("blocks ignored directories", () => {
    const result = checkNavigationPolicy("node_modules/pkg/index.js", TRUSTED);
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe("ignored");
  });

  it("blocks binary files", () => {
    const result = checkNavigationPolicy("assets/logo.png", TRUSTED);
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe("binary");
  });

  it("blocks secret-bearing files", () => {
    expect(checkNavigationPolicy("config/.env", TRUSTED).allowed).toBe(false);
    expect(checkNavigationPolicy("config/api_key.json", TRUSTED).allowed).toBe(false);
    expect(checkNavigationPolicy("secrets/credentials.json", TRUSTED).allowed).toBe(false);
  });

  it("allows normal source files with auth-like names", () => {
    expect(checkNavigationPolicy("src/auth.ts", TRUSTED).allowed).toBe(true);
    expect(checkNavigationPolicy("src/token.service.ts", TRUSTED).allowed).toBe(true);
  });
});

// --- symbol results with git badges -----------------------------------------

describe("symbol results", () => {
  it("assembles symbols with git badges and policy checks", () => {
    const gitStatus = new Map<string, GitBadge>([
      ["src/app.ts", "modified"],
      ["src/util.ts", "staged"],
    ]);

    const result = assembleNavigationResult({
      symbols: [
        { name: "main", kind: "function", filePath: "src/app.ts", range: { start: 1, end: 10 } },
        { name: "helper", kind: "function", filePath: "src/util.ts", range: { start: 5, end: 15 } },
        { name: "secret", kind: "variable", filePath: "config/.env", range: { start: 1, end: 1 } },
      ],
      references: [],
      diagnostics: [],
      policy: TRUSTED,
      gitStatus,
    });

    expect(result.symbols).toHaveLength(3);
    expect(result.symbols[0].gitBadge).toBe("modified");
    expect(result.symbols[1].gitBadge).toBe("staged");
    expect(result.symbols[0].policyAllowed).toBe(true);
    expect(result.symbols[2].policyAllowed).toBe(false); // secret file
    expect(result.symbols[2].policyRefusal).toBe("secret");
  });
});

// --- references -------------------------------------------------------------

describe("references", () => {
  it("assembles references with badges", () => {
    const result = assembleNavigationResult({
      symbols: [],
      references: [
        { symbolName: "main", filePath: "src/index.ts", line: 5 },
        { symbolName: "main", filePath: "tests/app.test.ts", line: 12 },
      ],
      diagnostics: [],
      policy: TRUSTED,
    });

    expect(result.references).toHaveLength(2);
    expect(result.references[0].gitBadge).toBe("clean");
    expect(result.references[0].policyAllowed).toBe(true);
  });
});

// --- diagnostics ------------------------------------------------------------

describe("diagnostics", () => {
  it("assembles diagnostics with severity", () => {
    const result = assembleNavigationResult({
      symbols: [],
      references: [],
      diagnostics: [
        { filePath: "src/app.ts", severity: "error", message: "Type mismatch", line: 42 },
        { filePath: "src/util.ts", severity: "warning", message: "Unused import", line: 3 },
      ],
      policy: TRUSTED,
    });

    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].severity).toBe("error");
    expect(result.diagnostics[1].severity).toBe("warning");
  });
});

// --- canonical reference conversion -----------------------------------------

describe("canonical reference conversion", () => {
  it("converts allowed symbol to canonical reference", () => {
    const result = assembleNavigationResult({
      symbols: [
        { name: "main", kind: "function", filePath: "src/app.ts", range: { start: 1, end: 10 } },
      ],
      references: [],
      diagnostics: [],
      policy: TRUSTED,
    });

    const ref = symbolToReference(result.symbols[0]);
    expect(ref).not.toBeNull();
    expect(ref!.path).toBe("src/app.ts");
    expect(ref!.symbol).toBe("main");
    expect(ref!.lines).toEqual({ start: 1, end: 10 });
    expect(ref!.provenance).toBe("search");
  });

  it("returns null for policy-blocked symbol", () => {
    const result = assembleNavigationResult({
      symbols: [
        { name: "key", kind: "variable", filePath: "config/.env", range: { start: 1, end: 1 } },
      ],
      references: [],
      diagnostics: [],
      policy: TRUSTED,
    });

    expect(symbolToReference(result.symbols[0])).toBeNull();
  });

  it("converts allowed reference to canonical reference", () => {
    const result = assembleNavigationResult({
      symbols: [],
      references: [
        { symbolName: "main", filePath: "src/index.ts", line: 5 },
      ],
      diagnostics: [],
      policy: TRUSTED,
    });

    const ref = referenceToReference(result.references[0]);
    expect(ref).not.toBeNull();
    expect(ref!.path).toBe("src/index.ts");
    expect(ref!.lines).toEqual({ start: 5, end: 5 });
  });
});

// --- bounding ---------------------------------------------------------------

describe("bounding", () => {
  it("truncates results beyond limits", () => {
    const symbols = Array.from({ length: 60 }, (_, i) => ({
      name: `sym${i}`, kind: "function" as const, filePath: `src/f${i}.ts`, range: { start: 1, end: 1 },
    }));

    const result = assembleNavigationResult({
      symbols, references: [], diagnostics: [], policy: TRUSTED,
    });

    expect(result.symbols).toHaveLength(50);
    expect(result.totalBeforeBound).toBe(60);
    expect(result.truncated).toBe(true);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatNavigationResult", () => {
  it("renders symbols, references, and diagnostics", () => {
    const gitStatus = new Map<string, GitBadge>([["src/app.ts", "modified"]]);
    const result = assembleNavigationResult({
      symbols: [
        { name: "main", kind: "function", filePath: "src/app.ts", range: { start: 1, end: 10 } },
      ],
      references: [
        { symbolName: "main", filePath: "src/index.ts", line: 5 },
      ],
      diagnostics: [
        { filePath: "src/app.ts", severity: "warning", message: "Unused var", line: 3 },
      ],
      policy: TRUSTED,
      gitStatus,
    });

    const output = formatNavigationResult(result);
    expect(output).toContain("Semantic Navigation");
    expect(output).toContain("function main");
    expect(output).toContain("●"); // modified badge
    expect(output).toContain("References");
    expect(output).toContain("Diagnostics");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("assembly does not modify inputs", () => {
    const symbols = [
      { name: "main", kind: "function" as const, filePath: "src/app.ts", range: { start: 1, end: 10 } },
    ];
    const before = JSON.stringify(symbols);

    assembleNavigationResult({ symbols, references: [], diagnostics: [], policy: TRUSTED });
    expect(JSON.stringify(symbols)).toBe(before);
  });
});
