import { describe, it, expect } from "vitest";
import {
  collectGoalPendingApprovals,
  formatGoalApprovals,
  renderGoalStatusWithApprovals,
  GOAL_APPROVALS_SCHEMA,
  GOAL_APPROVALS_VERSION,
} from "../../src/goal-approvals.js";
import type { ApprovalEntry } from "../../src/approval-inbox.js";

// Behavior-sensitive coverage for the Goal pending-approvals projection
// (Issue #458): pending-only filtering, ordering, waiting-time computation,
// redaction, stale-head carry-through, empty rendering, composition, and
// determinism.

const NOW = 1_000_000_000;

const entry = (over: Partial<ApprovalEntry>): ApprovalEntry => ({
  id: "ap-1",
  actionSummary: "write src/config.json",
  riskLevel: "low",
  requestedBy: "agent",
  requestedAt: NOW - 45_000,
  expiresAt: NOW + 300_000,
  headSha: "abc123",
  state: "pending",
  staleHead: false,
  ...over,
});

// --- filtering --------------------------------------------------------------

describe("pending-only filtering", () => {
  it("returns only pending entries", () => {
    const view = collectGoalPendingApprovals(
      [
        entry({ id: "p1" }),
        entry({ id: "a1", state: "approved", decidedBy: "user", decidedAt: NOW }),
        entry({ id: "r1", state: "rejected", decidedBy: "user", decidedAt: NOW }),
        entry({ id: "e1", state: "expired" }),
      ],
      NOW,
    );
    expect(view.pendingCount).toBe(1);
    expect(view.pending.map((p) => p.id)).toEqual(["p1"]);
  });

  it("reports zero for an empty inbox", () => {
    const view = collectGoalPendingApprovals([], NOW);
    expect(view.pendingCount).toBe(0);
    expect(view.pending).toEqual([]);
    expect(view.hasStaleHead).toBe(false);
    expect(view.schema).toBe(GOAL_APPROVALS_SCHEMA);
    expect(view.v).toBe(GOAL_APPROVALS_VERSION);
  });
});

// --- ordering and waiting time ----------------------------------------------

describe("ordering and waiting time", () => {
  it("orders pending entries oldest first", () => {
    const view = collectGoalPendingApprovals(
      [
        entry({ id: "newer", requestedAt: NOW - 5_000 }),
        entry({ id: "oldest", requestedAt: NOW - 90_000 }),
        entry({ id: "middle", requestedAt: NOW - 30_000 }),
      ],
      NOW,
    );
    expect(view.pending.map((p) => p.id)).toEqual(["oldest", "middle", "newer"]);
  });

  it("breaks requestedAt ties deterministically by id", () => {
    const view = collectGoalPendingApprovals(
      [entry({ id: "zz" }), entry({ id: "aa" })],
      NOW,
    );
    expect(view.pending.map((p) => p.id)).toEqual(["aa", "zz"]);
  });

  it("computes waiting time from the supplied now", () => {
    const view = collectGoalPendingApprovals(
      [entry({ id: "w", requestedAt: NOW - 45_000 })],
      NOW,
    );
    expect(view.pending[0].waitingMs).toBe(45_000);
  });

  it("clamps waiting time at zero for future-dated requests", () => {
    const view = collectGoalPendingApprovals(
      [entry({ id: "f", requestedAt: NOW + 10_000 })],
      NOW,
    );
    expect(view.pending[0].waitingMs).toBe(0);
  });
});

// --- redaction and stale head ------------------------------------------------

describe("redaction and stale head", () => {
  it("redacts secret-shaped action summaries", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const view = collectGoalPendingApprovals(
      [entry({ id: "s", actionSummary: `curl with ${token} in the URL` })],
      NOW,
    );
    expect(view.pending[0].actionSummary).not.toContain(token);
    expect(view.pending[0].actionSummary).toContain("[REDACTED]");
  });

  it("carries stale-head flags and aggregates hasStaleHead", () => {
    const view = collectGoalPendingApprovals(
      [entry({ id: "fresh" }), entry({ id: "stale", staleHead: true })],
      NOW,
    );
    expect(view.pending.find((p) => p.id === "stale")?.staleHead).toBe(true);
    expect(view.pending.find((p) => p.id === "fresh")?.staleHead).toBe(false);
    expect(view.hasStaleHead).toBe(true);
  });
});

// --- formatting --------------------------------------------------------------

describe("formatGoalApprovals", () => {
  it("renders count and per-entry lines with risk, wait, and stale marker", () => {
    const view = collectGoalPendingApprovals(
      [
        entry({ id: "old", riskLevel: "high", requestedAt: NOW - 125_000, staleHead: true }),
        entry({ id: "new", riskLevel: "low", requestedAt: NOW - 10_000 }),
      ],
      NOW,
    );
    const output = formatGoalApprovals(view);
    expect(output).toContain("Pending approvals: 2");
    expect(output).toContain("[high] write src/config.json (waiting 2m 5s, STALE HEAD)");
    expect(output).toContain("[low] write src/config.json (waiting 10s)");
    // Oldest entry renders first.
    expect(output.indexOf("STALE HEAD")).toBeLessThan(output.indexOf("(waiting 10s)"));
  });

  it("renders an explicit none line when nothing is pending", () => {
    expect(formatGoalApprovals(collectGoalPendingApprovals([], NOW))).toBe(
      "Pending approvals: none",
    );
  });

  it("formats hour-scale waits", () => {
    const view = collectGoalPendingApprovals(
      [entry({ id: "h", requestedAt: NOW - 3_725_000 })],
      NOW,
    );
    expect(formatGoalApprovals(view)).toContain("waiting 1h 2m");
  });
});

// --- composition --------------------------------------------------------------

describe("renderGoalStatusWithApprovals", () => {
  it("composes the Goal status text with the approvals section", () => {
    const view = collectGoalPendingApprovals([entry({ id: "c" })], NOW);
    const output = renderGoalStatusWithApprovals("Goal: active\n  revision: 3", view);
    expect(output).toContain("Goal: active");
    expect(output).toContain("Pending approvals: 1");
  });

  it("is deterministic for identical inputs", () => {
    const entries = [entry({ id: "d1" }), entry({ id: "d2", staleHead: true })];
    const a = renderGoalStatusWithApprovals("Goal: active", collectGoalPendingApprovals(entries, NOW));
    const b = renderGoalStatusWithApprovals("Goal: active", collectGoalPendingApprovals(entries, NOW));
    expect(a).toBe(b);
  });
});
