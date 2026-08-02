import { describe, it, expect } from "vitest";
import {
  setWaitReason,
  clearWaitReason,
  computeElapsed,
  formatWaitState,
  waitReasonLabel,
  type WaitReason,
} from "../../src/wait-reason.js";

// Pure-function coverage for wait reason (Issue #418): wait reason setting,
// elapsed time, formatting, and determinism.

// --- wait reason setting ----------------------------------------------------

describe("setWaitReason", () => {
  it("creates a wait state with reason", () => {
    const state = setWaitReason("model-response", 1000);
    expect(state.reason).toBe("model-response");
    expect(state.startedAt).toBe(1000);
    expect(state.isWaiting).toBe(true);
    expect(state.elapsedMs).toBe(0);
  });

  it("includes optional detail", () => {
    const state = setWaitReason("approval", 1000, "Waiting for user to approve plan");
    expect(state.detail).toBe("Waiting for user to approve plan");
  });

  it("redacts secrets in detail", () => {
    const state = setWaitReason("tool-execution", 1000, "Running --token=supersecretvalue123");
    expect(state.detail).toContain("[REDACTED]");
    expect(state.detail).not.toContain("supersecretvalue123");
  });

  it("bounds detail at 200 chars", () => {
    const state = setWaitReason("dependency", 1000, "x".repeat(500));
    expect(state.detail!.length).toBeLessThanOrEqual(200);
  });

  it("supports all wait reasons", () => {
    const reasons: WaitReason[] = [
      "model-response", "approval", "tool-execution",
      "retry-backoff", "dependency", "user-input",
    ];
    for (const reason of reasons) {
      const state = setWaitReason(reason, 1000);
      expect(state.reason).toBe(reason);
      expect(state.isWaiting).toBe(true);
    }
  });
});

// --- clear wait state -------------------------------------------------------

describe("clearWaitReason", () => {
  it("returns null to clear wait state", () => {
    expect(clearWaitReason()).toBeNull();
  });
});

// --- elapsed time -----------------------------------------------------------

describe("computeElapsed", () => {
  it("computes elapsed time", () => {
    const state = setWaitReason("model-response", 1000);
    const computed = computeElapsed(state, 6000);
    expect(computed.elapsedMs).toBe(5000);
  });

  it("does not compute for non-waiting state", () => {
    const state = setWaitReason("model-response", 1000);
    const cleared = clearWaitReason();
    // clearWaitReason returns null, so computeElapsed on a non-waiting state
    // should return the state unchanged.
    const notWaiting = { ...state, isWaiting: false };
    const computed = computeElapsed(notWaiting, 6000);
    expect(computed.elapsedMs).toBe(0); // Unchanged.
  });
});

// --- formatting -------------------------------------------------------------

describe("formatWaitState", () => {
  it("formats waiting state with reason and elapsed time", () => {
    const state = setWaitReason("model-response", 1000);
    const computed = computeElapsed(state, 31000); // 30s elapsed
    const output = formatWaitState(computed);

    expect(output).toContain("⏳");
    expect(output).toContain("Waiting for model response");
    expect(output).toContain("30s");
  });

  it("formats approval wait with detail", () => {
    const state = setWaitReason("approval", 1000, "Plan approval pending");
    const computed = computeElapsed(state, 61000); // 60s = 1m0s
    const output = formatWaitState(computed);

    expect(output).toContain("🔒");
    expect(output).toContain("Waiting for approval");
    expect(output).toContain("1m0s");
    expect(output).toContain("Plan approval pending");
  });

  it("formats non-waiting state", () => {
    const output = formatWaitState(null);
    expect(output).toBe("Not waiting.");
  });

  it("formats hours correctly", () => {
    const state = setWaitReason("dependency", 0);
    const computed = computeElapsed(state, 3_660_000); // 1h1m
    const output = formatWaitState(computed);
    expect(output).toContain("1h1m");
  });

  it("is deterministic", () => {
    const state = setWaitReason("tool-execution", 1000);
    const computed = computeElapsed(state, 5000);
    const a = formatWaitState(computed);
    const b = formatWaitState(computed);
    expect(a).toBe(b);
  });
});

// --- wait reason labels -----------------------------------------------------

describe("waitReasonLabel", () => {
  it("returns human-readable labels", () => {
    expect(waitReasonLabel("model-response")).toBe("Waiting for model response");
    expect(waitReasonLabel("approval")).toBe("Waiting for approval");
    expect(waitReasonLabel("tool-execution")).toBe("Waiting for tool execution");
    expect(waitReasonLabel("retry-backoff")).toBe("Waiting for retry backoff");
    expect(waitReasonLabel("dependency")).toBe("Waiting for dependency");
    expect(waitReasonLabel("user-input")).toBe("Waiting for user input");
  });
});
