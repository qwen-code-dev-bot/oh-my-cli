import { describe, it, expect } from "vitest";
import {
  redactGoalSurfaces,
  formatRedactionReport,
  GOAL_SURFACE_ORDER,
  GOAL_REDACTION_SCHEMA,
  GOAL_REDACTION_VERSION,
} from "../../src/goal-redaction.js";
import type { GoalSurfaceTexts } from "../../src/goal-redaction.js";

// Behavior-sensitive coverage for the Goal surface redaction sweep (Issue
// #460): per-surface stripping, aggregate counts, content preservation, empty
// inputs, residual-pattern audit, report content/ordering, and determinism.

const TOKEN = ["ghp", "_", "a".repeat(24)].join("");
const SK_TOKEN = "sk-" + "x".repeat(20);
const URL_SECRET = "https://user:passw0rd@internal.example/path";
const BEARER = "Bearer " + "tok" + "abcdef-ghijkl.mno";

const EMPTY: GoalSurfaceTexts = {
  summary: "",
  events: [],
  exportText: "",
  diagnostics: [],
};

// --- per-surface stripping ----------------------------------------------------

describe("per-surface stripping", () => {
  it("strips one secret per surface and counts each", () => {
    const result = redactGoalSurfaces({
      summary: `Goal achieved using ${TOKEN}`,
      events: [`step ran with ${URL_SECRET}`],
      exportText: `exported with ${BEARER}`,
      diagnostics: [`diag shows ${SK_TOKEN}`],
    });
    expect(result.stripped.summary).toBe(1);
    expect(result.stripped.events).toBe(1);
    expect(result.stripped.export).toBe(1);
    expect(result.stripped.diagnostics).toBe(1);
    expect(result.totalStripped).toBe(4);
    expect(result.hadSecrets).toBe(true);
    expect(result.schema).toBe(GOAL_REDACTION_SCHEMA);
    expect(result.v).toBe(GOAL_REDACTION_VERSION);
  });

  it("strips multiple secrets within one text", () => {
    const result = redactGoalSurfaces({
      ...EMPTY,
      summary: `used ${TOKEN} and ${URL_SECRET}`,
    });
    expect(result.stripped.summary).toBe(2);
    expect(result.totalStripped).toBe(2);
  });

  it("sums secrets across multiple events and diagnostics", () => {
    const result = redactGoalSurfaces({
      ...EMPTY,
      events: [`a ${TOKEN}`, `b ${SK_TOKEN}`, "clean event"],
      diagnostics: [`d1 ${URL_SECRET}`, "clean line"],
    });
    expect(result.stripped.events).toBe(2);
    expect(result.stripped.diagnostics).toBe(1);
  });

  it("leaves no residual secret patterns in redacted output", () => {
    const result = redactGoalSurfaces({
      summary: `token ${TOKEN}`,
      events: [`url ${URL_SECRET}`, `auth ${BEARER}`],
      exportText: `sk ${SK_TOKEN}`,
      diagnostics: ["clean"],
    });
    const all = [
      result.redacted.summary,
      ...result.redacted.events,
      result.redacted.exportText,
      ...result.redacted.diagnostics,
    ].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(SK_TOKEN);
    expect(all).not.toContain("passw0rd@");
    expect(all).not.toContain("tok" + "abcdef-ghijkl.mno");
    expect(all).toContain("[REDACTED]");
  });

  it("preserves non-secret content", () => {
    const result = redactGoalSurfaces({
      summary: `Deploy step finished cleanly despite ${TOKEN}`,
      events: ["step 1 completed"],
      exportText: "session export for review",
      diagnostics: ["no issues"],
    });
    expect(result.redacted.summary).toContain("Deploy step finished cleanly");
    expect(result.redacted.events).toEqual(["step 1 completed"]);
    expect(result.redacted.exportText).toBe("session export for review");
    expect(result.redacted.diagnostics).toEqual(["no issues"]);
    expect(result.hadSecrets).toBe(true);
  });
});

// --- empty and clean inputs ---------------------------------------------------

describe("empty and clean inputs", () => {
  it("reports zero counts for empty input", () => {
    const result = redactGoalSurfaces(EMPTY);
    expect(result.totalStripped).toBe(0);
    expect(result.hadSecrets).toBe(false);
    for (const surface of GOAL_SURFACE_ORDER) {
      expect(result.stripped[surface]).toBe(0);
    }
  });

  it("reports no secrets for clean text", () => {
    const result = redactGoalSurfaces({
      summary: "all good",
      events: ["fine"],
      exportText: "fine",
      diagnostics: ["fine"],
    });
    expect(result.hadSecrets).toBe(false);
    expect(result.totalStripped).toBe(0);
    expect(result.redacted.summary).toBe("all good");
  });
});

// --- report -------------------------------------------------------------------

describe("formatRedactionReport", () => {
  it("renders per-surface counts in fixed order plus aggregate and result", () => {
    const result = redactGoalSurfaces({
      summary: `s ${TOKEN}`,
      events: [`e ${TOKEN}`, `e2 ${SK_TOKEN}`],
      exportText: "clean",
      diagnostics: [],
    });
    const report = formatRedactionReport(result);
    expect(report).toContain(GOAL_REDACTION_SCHEMA);
    expect(report).toContain("summary: 1 secret stripped");
    expect(report).toContain("events: 2 secrets stripped");
    expect(report).toContain("export: 0 secrets stripped");
    expect(report).toContain("diagnostics: 0 secrets stripped");
    expect(report).toContain("Total: 3 secrets stripped");
    expect(report).toContain("Result: SECRETS STRIPPED");
    // Fixed surface order.
    expect(report.indexOf("summary:")).toBeLessThan(report.indexOf("events:"));
    expect(report.indexOf("events:")).toBeLessThan(report.indexOf("export:"));
    expect(report.indexOf("export:")).toBeLessThan(report.indexOf("diagnostics:"));
  });

  it("never includes secret material in the report", () => {
    const result = redactGoalSurfaces({
      summary: `${TOKEN} ${URL_SECRET}`,
      events: [BEARER],
      exportText: SK_TOKEN,
      diagnostics: [],
    });
    const report = formatRedactionReport(result);
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain(SK_TOKEN);
    expect(report).not.toContain("passw0rd");
    expect(report).toContain("Result: SECRETS STRIPPED");
  });

  it("renders the no-secrets result", () => {
    const report = formatRedactionReport(redactGoalSurfaces(EMPTY));
    expect(report).toContain("Total: 0 secrets stripped");
    expect(report).toContain("Result: NO SECRETS FOUND");
  });

  it("is deterministic", () => {
    const input: GoalSurfaceTexts = {
      summary: `x ${TOKEN}`,
      events: [`y ${SK_TOKEN}`],
      exportText: "z",
      diagnostics: [],
    };
    expect(formatRedactionReport(redactGoalSurfaces(input))).toBe(
      formatRedactionReport(redactGoalSurfaces(input)),
    );
  });
});

// --- purity -------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input", () => {
    const input: GoalSurfaceTexts = {
      summary: `s ${TOKEN}`,
      events: [`e ${TOKEN}`],
      exportText: `x ${SK_TOKEN}`,
      diagnostics: [`d ${URL_SECRET}`],
    };
    const snapshot = JSON.stringify(input);
    redactGoalSurfaces(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
