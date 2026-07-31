import { describe, it, expect } from "vitest";
import {
  FAILURE_PRESENTATION_SCHEMA,
  FAILURE_PRESENTATION_VERSION,
  OUTCOME_CLASSES,
  WAITING_CONDITIONS,
  FAILURE_GUIDANCE,
  DEFAULT_MAX_ATTEMPTS,
  isWaitingCondition,
  classifyOutcome,
  guidanceFor,
  presentFailure,
  collectFailureModel,
  formatFailureModel,
} from "../../src/failure-presentation.js";
import { EVENT_STATUS_RUNTIME_MAPPING } from "../../src/event-presentation.js";

describe("failure presentation constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(FAILURE_PRESENTATION_SCHEMA).toBe("oh-my-cli.failure-presentation");
    expect(FAILURE_PRESENTATION_VERSION).toBe(1);
  });

  it("pins the outcome classes and waiting conditions", () => {
    expect(OUTCOME_CLASSES).toEqual(["ok", "failure", "waiting"]);
    expect(WAITING_CONDITIONS).toEqual([
      "network",
      "rate-limit",
      "ci-queue",
      "service-unavailable",
    ]);
  });
});

describe("waiting vs failure classification", () => {
  it("treats waiting conditions as waiting, not failures", () => {
    for (const condition of WAITING_CONDITIONS) {
      expect(isWaitingCondition(condition)).toBe(true);
      expect(classifyOutcome(condition)).toBe("waiting");
    }
  });

  it("treats real failure categories as failures", () => {
    for (const category of ["policy_denied", "tool_error", "provider_error", "timeout", "other"]) {
      expect(isWaitingCondition(category)).toBe(false);
      expect(classifyOutcome(category)).toBe("failure");
    }
  });
});

describe("guidanceFor", () => {
  it("returns canonical guidance for a known category", () => {
    const guidance = guidanceFor("approval_denied");
    expect(guidance.outcome).toBe("failure");
    expect(guidance.retryable).toBe(false);
    expect(guidance.nextStep.length).toBeGreaterThan(0);
  });

  it("marks every waiting condition retryable", () => {
    for (const condition of WAITING_CONDITIONS) {
      expect(guidanceFor(condition).retryable).toBe(true);
      expect(guidanceFor(condition).outcome).toBe("waiting");
    }
  });

  it("falls back to the bounded 'other' guidance for an unrecognized failure category", () => {
    const guidance = guidanceFor("totally-new-failure");
    expect(guidance.category).toBe("other");
    expect(guidance.outcome).toBe("failure");
    expect(guidance.nextStep.length).toBeGreaterThan(0);
  });

  it("gives every guidance entry a non-empty actionable next step", () => {
    for (const g of FAILURE_GUIDANCE) {
      expect(g.nextStep.length).toBeGreaterThan(0);
    }
  });
});

describe("presentFailure: partial output is preserved and sanitized", () => {
  it("preserves partial output through the #306 mapper", () => {
    const presented = presentFailure({
      category: "tool_error",
      partialSummary: "wrote 3 files",
      partialDetail: "partial diff here",
    });
    expect(presented.partial).not.toBeNull();
    expect(presented.partial!.summary).toBe("wrote 3 files");
    expect(presented.partial!.detail).toBe("partial diff here");
    expect(presented.partial!.status).toBe("failed");
  });

  it("redacts secrets in preserved partial output", () => {
    const presented = presentFailure({
      category: "provider_error",
      partialDetail: "auth sk-abcdefghijklmnopqrst failed",
    });
    expect(presented.partial!.detail).not.toContain("sk-abcdefghijklmnopqrst");
    expect(presented.partial!.detail).toContain("[REDACTED]");
  });

  it("reports null partial when the step produced none", () => {
    const presented = presentFailure({ category: "policy_denied" });
    expect(presented.partial).toBeNull();
  });
});

describe("presentFailure: outcome uses the #306 canonical semantics", () => {
  it("presents a failure with the canonical 'failed' status and meaning", () => {
    const presented = presentFailure({ category: "tool_error", partialSummary: "x" });
    expect(presented.outcome).toBe("failure");
    expect(presented.partial!.status).toBe("failed");
    // The canonical failure semantic comes from the #306 contract, not a local string.
    expect(EVENT_STATUS_RUNTIME_MAPPING.failed).toContain("errored");
  });

  it("presents a waiting condition with the canonical 'waiting' status", () => {
    const presented = presentFailure({ category: "rate-limit", partialSummary: "queued" });
    expect(presented.outcome).toBe("waiting");
    expect(presented.partial!.status).toBe("waiting");
    expect(EVENT_STATUS_RUNTIME_MAPPING.waiting).toContain("rate-limit");
  });
});

describe("presentFailure: bounded retry semantics", () => {
  it("surfaces attempt number and marks retries exhausted at the bound", () => {
    const first = presentFailure({ category: "tool_error", attempt: 1 });
    expect(first.attempt).toBe(1);
    expect(first.retryable).toBe(true);
    expect(first.retriesExhausted).toBe(false);

    const last = presentFailure({ category: "tool_error", attempt: DEFAULT_MAX_ATTEMPTS });
    expect(last.retriesExhausted).toBe(true);
  });

  it("never marks a non-retryable denial as retries-exhausted", () => {
    const presented = presentFailure({ category: "approval_denied", attempt: 5 });
    expect(presented.retryable).toBe(false);
    expect(presented.retriesExhausted).toBe(false);
  });

  it("floors invalid attempt/maxAttempts to safe bounds", () => {
    const presented = presentFailure({ category: "tool_error", attempt: -3, maxAttempts: 0 });
    expect(presented.attempt).toBe(1);
    // maxAttempts floored to 1, attempt 1 >= 1, retryable -> exhausted
    expect(presented.retriesExhausted).toBe(true);
  });
});

describe("collectFailureModel / formatFailureModel", () => {
  it("collects the canonical guidance model", () => {
    const model = collectFailureModel();
    expect(model.schema).toBe(FAILURE_PRESENTATION_SCHEMA);
    expect(model.outcomes).toEqual([...OUTCOME_CLASSES]);
    expect(model.waitingConditions).toEqual([...WAITING_CONDITIONS]);
    expect(model.defaultMaxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(model.guidance.length).toBe(FAILURE_GUIDANCE.length);
  });

  it("renders the guidance with categories, outcome, and next step", () => {
    const out = formatFailureModel(collectFailureModel());
    expect(out).toContain(FAILURE_PRESENTATION_SCHEMA);
    expect(out).toContain("approval_denied [failure] no-retry");
    expect(out).toContain("rate-limit [waiting] retryable");
    expect(out).toContain(`Default max attempts: ${DEFAULT_MAX_ATTEMPTS}`);
  });
});
