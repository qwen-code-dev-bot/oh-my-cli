import { describe, it, expect } from "vitest";
import {
  createFailureTaxonomyCollector,
  formatFailureTaxonomyReport,
  FAILURE_CATEGORIES,
  FAILURE_TAXONOMY_SCHEMA,
  FAILURE_TAXONOMY_VERSION,
} from "../../src/run-failure-taxonomy.js";

describe("createFailureTaxonomyCollector / build", () => {
  it("counts each failure cause and reports the total and terminal reason", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    collector.record("policy_denied");
    collector.record("policy_denied");
    collector.record("tool_error");
    const report = build(5000, "provider_error");

    expect(report.schema).toBe(FAILURE_TAXONOMY_SCHEMA);
    expect(report.v).toBe(FAILURE_TAXONOMY_VERSION);
    expect(report.elapsedMs).toBe(5000);
    expect(report.reason).toBe("provider_error");
    expect(report.totalFailures).toBe(3);
    expect(report.byCategory).toEqual({ policy_denied: 2, tool_error: 1 });
  });

  it("emits byCategory in canonical taxonomy order regardless of insertion order", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    collector.record("tool_error");
    collector.record("approval_denied");
    collector.record("policy_denied");
    const report = build(100, "completed");
    // Canonical order: policy_denied before approval_denied before tool_error.
    expect(Object.keys(report.byCategory)).toEqual(["policy_denied", "approval_denied", "tool_error"]);
  });

  it("buckets an unrecognized category into 'other'", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    // Cast to exercise the defensive path for a category outside the fixed set.
    collector.record("brand_new_failure" as never);
    const report = build(100, "completed");
    expect(report.byCategory).toEqual({ other: 1 });
    expect(report.totalFailures).toBe(1);
  });

  it("includes only non-zero categories", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    collector.record("hook_denied");
    const report = build(100, "completed");
    expect(Object.keys(report.byCategory)).toEqual(["hook_denied"]);
    for (const category of FAILURE_CATEGORIES) {
      if (category !== "hook_denied") expect(report.byCategory[category]).toBeUndefined();
    }
  });

  it("sanitizes control characters out of the terminal reason", () => {
    const { build } = createFailureTaxonomyCollector();
    const report = build(100, "bad\u0000reason\u001f");
    expect(report.reason).toBe("bad_reason_");
    expect(report.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("clamps a negative elapsed time to zero", () => {
    const { build } = createFailureTaxonomyCollector();
    expect(build(-50, "completed").elapsedMs).toBe(0);
  });

  it("reports zero failures with an empty byCategory when nothing failed", () => {
    const { build } = createFailureTaxonomyCollector();
    const report = build(1000, "completed");
    expect(report.totalFailures).toBe(0);
    expect(report.byCategory).toEqual({});
  });
});

describe("formatFailureTaxonomyReport", () => {
  it("renders a human-readable taxonomy with per-category counts", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    collector.record("policy_denied");
    collector.record("policy_denied");
    collector.record("path_escape");
    const text = formatFailureTaxonomyReport(build(12345, "max_rounds"));
    expect(text).toContain(`Failure taxonomy (${FAILURE_TAXONOMY_SCHEMA} v${FAILURE_TAXONOMY_VERSION})`);
    expect(text).toContain("elapsed:   12.3s");
    expect(text).toContain("terminal:  max_rounds");
    expect(text).toContain("failures:  3");
    expect(text).toContain("policy_denied");
    expect(text).toContain("2");
    expect(text).toContain("path_escape");
  });

  it("renders an explicit no-failures line when nothing failed", () => {
    const { build } = createFailureTaxonomyCollector();
    const text = formatFailureTaxonomyReport(build(1000, "completed"));
    expect(text).toContain("failures:  0 (none)");
  });

  it("carries no channel for error text or content (metadata only)", () => {
    const { collector, build } = createFailureTaxonomyCollector();
    collector.record("tool_error");
    const text = formatFailureTaxonomyReport(build(100, "completed"));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Error:");
  });
});
