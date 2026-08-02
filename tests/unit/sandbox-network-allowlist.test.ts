import { describe, it, expect } from "vitest";
import {
  matchHostPattern,
  evaluateHost,
  evaluateHosts,
  summarizeAllowlist,
  formatAllowlistSummary,
  type AllowlistConfig,
} from "../../src/sandbox-network-allowlist.js";

// Pure-function coverage for sandbox network allowlist (Issue #393):
// pattern matching, allowlist evaluation, empty-list backward
// compatibility, structured refusal, explanation, and formatting.

// --- pattern matching -------------------------------------------------------

describe("matchHostPattern", () => {
  it("matches exact hostnames", () => {
    expect(matchHostPattern("registry.npmjs.org", "registry.npmjs.org")).toBe(true);
    expect(matchHostPattern("pypi.org", "pypi.org")).toBe(true);
  });

  it("rejects non-matching exact hostnames", () => {
    expect(matchHostPattern("evil.com", "registry.npmjs.org")).toBe(false);
  });

  it("matches wildcard subdomains", () => {
    expect(matchHostPattern("registry.npmjs.org", "*.npmjs.org")).toBe(true);
    expect(matchHostPattern("foo.bar.npmjs.org", "*.npmjs.org")).toBe(true);
  });

  it("rejects bare domain for wildcard subdomain pattern", () => {
    // *.npmjs.org should NOT match npmjs.org itself.
    expect(matchHostPattern("npmjs.org", "*.npmjs.org")).toBe(false);
  });

  it("matches wildcard-all pattern", () => {
    expect(matchHostPattern("anything.example.com", "*")).toBe(true);
    expect(matchHostPattern("localhost", "*")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchHostPattern("Registry.NPMJS.ORG", "registry.npmjs.org")).toBe(true);
    expect(matchHostPattern("FOO.NPMJS.ORG", "*.npmjs.org")).toBe(true);
  });
});

// --- allowlist evaluation ---------------------------------------------------

describe("evaluateHost", () => {
  const config: AllowlistConfig = {
    patterns: ["registry.npmjs.org", "*.github.com", "pypi.org"],
  };

  it("allows matching hosts", () => {
    const decision = evaluateHost("registry.npmjs.org", config);
    expect(decision.action).toBe("allowed");
    expect(decision.matchedPattern).toBe("registry.npmjs.org");
  });

  it("allows wildcard-matching hosts", () => {
    const decision = evaluateHost("api.github.com", config);
    expect(decision.action).toBe("allowed");
    expect(decision.matchedPattern).toBe("*.github.com");
  });

  it("blocks non-matching hosts with structured refusal", () => {
    const decision = evaluateHost("evil.example.com", config);
    expect(decision.action).toBe("blocked");
    expect(decision.explanation).toContain("does not match");
    expect(decision.explanation).toContain("strictAllowlist");
  });

  it("provides explanation for every decision", () => {
    const allowed = evaluateHost("pypi.org", config);
    expect(allowed.explanation.length).toBeGreaterThan(0);

    const blocked = evaluateHost("unknown.host", config);
    expect(blocked.explanation.length).toBeGreaterThan(0);
  });
});

// --- empty allowlist backward compatibility ---------------------------------

describe("empty allowlist", () => {
  it("returns unrestricted when allowlist is empty", () => {
    const config: AllowlistConfig = { patterns: [] };
    const decision = evaluateHost("anything.example.com", config);
    expect(decision.action).toBe("unrestricted");
    expect(decision.explanation).toContain("unrestricted");
  });
});

// --- batch evaluation -------------------------------------------------------

describe("evaluateHosts", () => {
  it("evaluates multiple hosts", () => {
    const config: AllowlistConfig = { patterns: ["registry.npmjs.org"] };
    const decisions = evaluateHosts(
      ["registry.npmjs.org", "evil.com", "pypi.org"],
      config,
    );

    expect(decisions).toHaveLength(3);
    expect(decisions[0].action).toBe("allowed");
    expect(decisions[1].action).toBe("blocked");
    expect(decisions[2].action).toBe("blocked");
  });
});

// --- summary ----------------------------------------------------------------

describe("summarizeAllowlist", () => {
  it("summarizes active allowlist with decisions", () => {
    const config: AllowlistConfig = { patterns: ["registry.npmjs.org", "*.github.com"] };
    const decisions = evaluateHosts(
      ["registry.npmjs.org", "api.github.com", "evil.com"],
      config,
    );
    const summary = summarizeAllowlist(config, decisions);

    expect(summary.active).toBe(true);
    expect(summary.patternCount).toBe(2);
    expect(summary.allowedCount).toBe(2);
    expect(summary.blockedCount).toBe(1);
  });

  it("summarizes inactive allowlist", () => {
    const config: AllowlistConfig = { patterns: [] };
    const summary = summarizeAllowlist(config, []);

    expect(summary.active).toBe(false);
    expect(summary.patternCount).toBe(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAllowlistSummary", () => {
  it("renders active allowlist with decisions", () => {
    const config: AllowlistConfig = { patterns: ["registry.npmjs.org"] };
    const decisions = evaluateHosts(["registry.npmjs.org", "evil.com"], config);
    const summary = summarizeAllowlist(config, decisions);
    const output = formatAllowlistSummary(summary);

    expect(output).toContain("Sandbox Network Allowlist");
    expect(output).toContain("ACTIVE");
    expect(output).toContain("registry.npmjs.org");
    expect(output).toContain("✓");
    expect(output).toContain("✗");
    expect(output).toContain("Read-only");
  });

  it("renders inactive allowlist", () => {
    const config: AllowlistConfig = { patterns: [] };
    const summary = summarizeAllowlist(config, []);
    const output = formatAllowlistSummary(summary);

    expect(output).toContain("INACTIVE");
    expect(output).toContain("unrestricted");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("evaluation does not modify config", () => {
    const config: AllowlistConfig = { patterns: ["registry.npmjs.org"] };
    const before = JSON.stringify(config);

    evaluateHost("registry.npmjs.org", config);
    expect(JSON.stringify(config)).toBe(before);
  });
});
