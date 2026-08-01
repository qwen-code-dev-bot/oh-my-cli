import { describe, it, expect } from "vitest";
import {
  BrowserActionClassifier,
  classifyRisk,
  requiresApproval,
  formatClassifiedAction,
  formatClassifierSummary,
  type BrowserActionType,
} from "../../src/browser-classifier.js";

// Pure-function coverage for browser action classifier (Issue #383):
// classification, approval boundaries, evidence binding, multi-action,
// read-only posture, and formatting.

const EVIDENCE = { url: "https://example.com", timestamp: 100_000, taskRevision: "abc123def456" };

// --- risk classification ----------------------------------------------------

describe("risk classification", () => {
  it("classifies read-only actions", () => {
    expect(classifyRisk("navigate")).toBe("read-only");
    expect(classifyRisk("dom-inspect")).toBe("read-only");
    expect(classifyRisk("screenshot")).toBe("read-only");
    expect(classifyRisk("text-extract")).toBe("read-only");
  });

  it("classifies click as low risk", () => {
    expect(classifyRisk("click")).toBe("low");
  });

  it("classifies form-submit as medium risk", () => {
    expect(classifyRisk("form-submit")).toBe("medium");
  });

  it("classifies download/upload as high risk", () => {
    expect(classifyRisk("download")).toBe("high");
    expect(classifyRisk("upload")).toBe("high");
  });

  it("classifies authenticate as critical risk", () => {
    expect(classifyRisk("authenticate")).toBe("critical");
  });
});

// --- approval boundaries ----------------------------------------------------

describe("approval boundaries", () => {
  it("read-only and low actions need no approval", () => {
    expect(requiresApproval("read-only")).toBe(false);
    expect(requiresApproval("low")).toBe(false);
  });

  it("medium, high, and critical require approval", () => {
    expect(requiresApproval("medium")).toBe(true);
    expect(requiresApproval("high")).toBe(true);
    expect(requiresApproval("critical")).toBe(true);
  });
});

// --- classifier -------------------------------------------------------------

describe("classifier", () => {
  it("classifies and records actions with evidence", () => {
    const classifier = new BrowserActionClassifier();
    const action = classifier.classify({
      id: "a1", actionType: "navigate", target: "https://docs.example.com",
      ...EVIDENCE,
    });

    expect(action.riskLevel).toBe("read-only");
    expect(action.approvalRequired).toBe(false);
    expect(action.evidence.url).toBe("https://example.com");
    expect(action.evidence.taskRevision).toBe("abc123def456");
  });

  it("separates read-only from approval-required actions", () => {
    const classifier = new BrowserActionClassifier();
    classifier.classify({ id: "a1", actionType: "navigate", target: "/", ...EVIDENCE });
    classifier.classify({ id: "a2", actionType: "click", target: "#btn", ...EVIDENCE });
    classifier.classify({ id: "a3", actionType: "form-submit", target: "#form", ...EVIDENCE });
    classifier.classify({ id: "a4", actionType: "authenticate", target: "/login", ...EVIDENCE });

    expect(classifier.size).toBe(4);
    expect(classifier.getReadOnly()).toHaveLength(1);
    expect(classifier.getRequiringApproval()).toHaveLength(2); // form-submit, authenticate
    expect(classifier.getByRisk("low")).toHaveLength(1); // click
  });
});

// --- evidence binding -------------------------------------------------------

describe("evidence binding", () => {
  it("captures URL, timestamp, and task revision", () => {
    const classifier = new BrowserActionClassifier();
    const action = classifier.classify({
      id: "a1", actionType: "screenshot", target: "viewport",
      url: "https://app.example.com/dashboard",
      timestamp: 123_456,
      taskRevision: "deadbeef1234",
    });

    expect(action.evidence.url).toBe("https://app.example.com/dashboard");
    expect(action.evidence.timestamp).toBe(123_456);
    expect(action.evidence.taskRevision).toBe("deadbeef1234");
  });
});

// --- multi-action fixture ---------------------------------------------------

describe("multi-action fixture", () => {
  it("classifies a full research session", () => {
    const classifier = new BrowserActionClassifier();
    classifier.classify({ id: "a1", actionType: "navigate", target: "https://docs.rs", ...EVIDENCE });
    classifier.classify({ id: "a2", actionType: "text-extract", target: "article", ...EVIDENCE });
    classifier.classify({ id: "a3", actionType: "screenshot", target: "figure-1", ...EVIDENCE });
    classifier.classify({ id: "a4", actionType: "click", target: "nav-next", ...EVIDENCE });
    classifier.classify({ id: "a5", actionType: "download", target: "spec.pdf", ...EVIDENCE });

    expect(classifier.size).toBe(5);
    expect(classifier.getReadOnly()).toHaveLength(3);
    expect(classifier.getRequiringApproval()).toHaveLength(1); // download
    expect(classifier.getByRisk("low")).toHaveLength(1); // click
  });
});

// --- read-only posture ------------------------------------------------------

describe("read-only posture", () => {
  it("navigation and inspection are read-only by default", () => {
    const types: BrowserActionType[] = ["navigate", "dom-inspect", "screenshot", "text-extract"];
    for (const t of types) {
      expect(classifyRisk(t)).toBe("read-only");
      expect(requiresApproval(classifyRisk(t))).toBe(false);
    }
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("renders classified action with risk and approval", () => {
    const classifier = new BrowserActionClassifier();
    classifier.classify({ id: "a1", actionType: "form-submit", target: "#login-form", ...EVIDENCE });

    const output = formatClassifiedAction(classifier.list()[0]);
    expect(output).toContain("form-submit");
    expect(output).toContain("medium");
    expect(output).toContain("APPROVAL REQUIRED");
    expect(output).toContain("abc123def456");
  });

  it("renders classifier summary", () => {
    const classifier = new BrowserActionClassifier();
    classifier.classify({ id: "a1", actionType: "navigate", target: "/", ...EVIDENCE });
    classifier.classify({ id: "a2", actionType: "authenticate", target: "/login", ...EVIDENCE });

    const output = formatClassifierSummary(classifier);
    expect(output).toContain("Browser Action Classification");
    expect(output).toContain("Actions: 2");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("classification does not execute browser actions", () => {
    const classifier = new BrowserActionClassifier();
    classifier.classify({ id: "a1", actionType: "navigate", target: "/", ...EVIDENCE });

    // Pure data model — no side effects.
    expect(classifier.size).toBe(1);
  });
});
