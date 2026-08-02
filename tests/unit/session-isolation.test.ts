import { describe, it, expect } from "vitest";
import {
  evaluateIsolation,
  formatIsolationStatus,
  DEFAULT_ISOLATION_POLICY,
  type SessionGoalBinding,
  type GoalIsolationPolicy,
} from "../../src/session-isolation.js";

// Pure-function coverage for session isolation (Issue #442): isolation
// evaluation, staleness detection, and determinism.

const NOW = 1_000_000_000_000;

function binding(overrides: Partial<SessionGoalBinding> = {}): SessionGoalBinding {
  return {
    sessionId: "session-1",
    goalRevision: 2,
    boundAt: NOW - 600_000, // 10 minutes ago
    isStale: false,
    ...overrides,
  };
}

// --- resume evaluation ------------------------------------------------------

describe("resume isolation", () => {
  it("carries over fresh Goal state on resume", () => {
    const evaluation = evaluateIsolation(binding(), "resume", DEFAULT_ISOLATION_POLICY, NOW);

    expect(evaluation.carryOver).toBe(true);
    expect(evaluation.action).toBe("resume");
    expect(evaluation.binding.isStale).toBe(false);
    expect(evaluation.reason).toContain("fresh");
  });

  it("isolates stale Goal state on resume", () => {
    const staleBinding = binding({ boundAt: NOW - 7_200_000 }); // 2 hours ago
    const evaluation = evaluateIsolation(staleBinding, "resume", DEFAULT_ISOLATION_POLICY, NOW);

    expect(evaluation.carryOver).toBe(false);
    expect(evaluation.binding.isStale).toBe(true);
    expect(evaluation.reason).toContain("stale");
  });

  it("isolates when policy disables resume carry-over", () => {
    const policy: GoalIsolationPolicy = { ...DEFAULT_ISOLATION_POLICY, carryOverOnResume: false };
    const evaluation = evaluateIsolation(binding(), "resume", policy, NOW);

    expect(evaluation.carryOver).toBe(false);
    expect(evaluation.reason).toContain("does not carry over on resume");
  });
});

// --- fork evaluation --------------------------------------------------------

describe("fork isolation", () => {
  it("isolates Goal state on fork by default", () => {
    const evaluation = evaluateIsolation(binding(), "fork", DEFAULT_ISOLATION_POLICY, NOW);

    expect(evaluation.carryOver).toBe(false);
    expect(evaluation.action).toBe("fork");
    expect(evaluation.reason).toContain("does not carry over on fork");
  });

  it("carries over fresh Goal state on fork when policy allows", () => {
    const policy: GoalIsolationPolicy = { ...DEFAULT_ISOLATION_POLICY, carryOverOnFork: true };
    const evaluation = evaluateIsolation(binding(), "fork", policy, NOW);

    expect(evaluation.carryOver).toBe(true);
    expect(evaluation.reason).toContain("fresh");
  });

  it("isolates stale Goal state on fork even when policy allows", () => {
    const policy: GoalIsolationPolicy = { ...DEFAULT_ISOLATION_POLICY, carryOverOnFork: true };
    const staleBinding = binding({ boundAt: NOW - 7_200_000 });
    const evaluation = evaluateIsolation(staleBinding, "fork", policy, NOW);

    expect(evaluation.carryOver).toBe(false);
    expect(evaluation.binding.isStale).toBe(true);
  });
});

// --- staleness detection ----------------------------------------------------

describe("staleness detection", () => {
  it("detects stale binding", () => {
    const staleBinding = binding({ boundAt: NOW - 7_200_000 }); // 2 hours
    const evaluation = evaluateIsolation(staleBinding, "resume", DEFAULT_ISOLATION_POLICY, NOW);

    expect(evaluation.binding.isStale).toBe(true);
  });

  it("detects fresh binding", () => {
    const freshBinding = binding({ boundAt: NOW - 600_000 }); // 10 minutes
    const evaluation = evaluateIsolation(freshBinding, "resume", DEFAULT_ISOLATION_POLICY, NOW);

    expect(evaluation.binding.isStale).toBe(false);
  });

  it("respects custom max staleness", () => {
    const policy: GoalIsolationPolicy = { ...DEFAULT_ISOLATION_POLICY, maxStalenessMs: 300_000 }; // 5 min
    const evaluation = evaluateIsolation(binding({ boundAt: NOW - 600_000 }), "resume", policy, NOW);

    expect(evaluation.binding.isStale).toBe(true); // 10m > 5m
  });
});

// --- formatting -------------------------------------------------------------

describe("formatIsolationStatus", () => {
  it("renders carry-over status", () => {
    const evaluation = evaluateIsolation(binding(), "resume", DEFAULT_ISOLATION_POLICY, NOW);
    const output = formatIsolationStatus(evaluation);

    expect(output).toContain("CARRY OVER");
    expect(output).toContain("Action: resume");
    expect(output).toContain("Session: session-1");
    expect(output).toContain("Goal revision: 2");
    expect(output).toContain("Stale: no");
  });

  it("renders isolated status", () => {
    const evaluation = evaluateIsolation(binding(), "fork", DEFAULT_ISOLATION_POLICY, NOW);
    const output = formatIsolationStatus(evaluation);

    expect(output).toContain("ISOLATED");
    expect(output).toContain("Action: fork");
  });

  it("is deterministic", () => {
    const evaluation = evaluateIsolation(binding(), "resume", DEFAULT_ISOLATION_POLICY, NOW);
    const a = formatIsolationStatus(evaluation);
    const b = formatIsolationStatus(evaluation);
    expect(a).toBe(b);
  });
});
