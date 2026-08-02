import { describe, it, expect } from "vitest";
import {
  detectScopeExpansion,
  formatScopeExpansionWarning,
} from "../../src/scope-expansion-detector.js";

// Pure-function coverage for scope expansion detector (Issue #452):
// expansion detection, heuristic evaluation, warning formatting, and
// determinism.

// --- no expansion -----------------------------------------------------------

describe("no expansion", () => {
  it("detects similar scope", () => {
    const result = detectScopeExpansion(
      "Fix the login bug",
      "Fix the login authentication bug",
    );

    expect(result.expanded).toBe(false);
    expect(result.reason).toContain("similar");
  });

  it("detects narrower scope", () => {
    const result = detectScopeExpansion(
      "Fix the login and registration bugs",
      "Fix the login bug",
    );

    expect(result.expanded).toBe(false);
  });
});

// --- word count expansion ---------------------------------------------------

describe("word count expansion", () => {
  it("detects word count increase > 50%", () => {
    const result = detectScopeExpansion(
      "Fix login bug",
      "Fix login bug and add registration and password reset and email verification",
    );

    expect(result.expanded).toBe(true);
    expect(result.reason).toContain("word count increased");
    expect(result.previousWordCount).toBe(3);
    expect(result.newWordCount).toBeGreaterThan(3);
  });
});

// --- broad keyword expansion ------------------------------------------------

describe("broad keyword expansion", () => {
  it("detects broad keywords", () => {
    const result = detectScopeExpansion(
      "Fix the login bug",
      "Refactor the entire authentication system",
    );

    expect(result.expanded).toBe(true);
    expect(result.newKeywords).toContain("refactor");
    expect(result.newKeywords).toContain("entire");
    expect(result.reason).toContain("broad keywords");
  });

  it("detects broad verbs", () => {
    const result = detectScopeExpansion(
      "Fix the bug",
      "Fix the bug and add tests and implement caching",
    );

    expect(result.expanded).toBe(true);
    expect(result.newKeywords.some((k) => ["add", "implement"].includes(k))).toBe(true);
  });
});

// --- new keywords -----------------------------------------------------------

describe("new keywords", () => {
  it("identifies new keywords", () => {
    const result = detectScopeExpansion(
      "Fix the login bug",
      "Fix the login bug and add OAuth2 support",
    );

    expect(result.newKeywords).toContain("oauth2");
    expect(result.newKeywords).toContain("support");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatScopeExpansionWarning", () => {
  it("renders expansion warning", () => {
    const result = detectScopeExpansion(
      "Fix login bug",
      "Refactor the entire authentication system and add OAuth2",
    );
    const output = formatScopeExpansionWarning(result);

    expect(output).toContain("SCOPE EXPANSION");
    expect(output).toContain("⚠");
    expect(output).toContain("Fix login bug");
    expect(output).toContain("Refactor the entire authentication system");
    expect(output).toContain("Words:");
    expect(output).toContain("New keywords:");
  });

  it("renders scope OK", () => {
    const result = detectScopeExpansion("Fix login bug", "Fix login bug");
    const output = formatScopeExpansionWarning(result);

    expect(output).toContain("SCOPE OK");
    expect(output).toContain("✓");
  });

  it("is deterministic", () => {
    const result = detectScopeExpansion("Fix bug", "Refactor everything");
    const a = formatScopeExpansionWarning(result);
    const b = formatScopeExpansionWarning(result);
    expect(a).toBe(b);
  });
});
