import { describe, it, expect } from "vitest";
import {
  ApprovalInbox,
  assembleInboxView,
  formatApprovalEntry,
  formatInboxSummary,
} from "../../src/approval-inbox.js";

// Pure-function coverage for approval inbox (Issue #381): pending,
// approved, rejected, expired, stale-head, multi-approval, and
// read-only guarantee.

const NOW = 100_000;
const HEAD = "abc123def456";

function requestOpts(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    actionSummary: `Execute ${id}`,
    riskLevel: "medium" as const,
    requestedBy: "agent-1",
    requestedAt: NOW - 10_000,
    expiresAt: NOW + 60_000,
    headSha: HEAD,
    ...overrides,
  };
}

// --- pending approvals ------------------------------------------------------

describe("pending approvals", () => {
  it("creates a pending approval request", () => {
    const inbox = new ApprovalInbox();
    const entry = inbox.request(requestOpts("a1"));

    expect(entry.state).toBe("pending");
    expect(entry.staleHead).toBe(false);
    expect(inbox.getPending()).toHaveLength(1);
  });
});

// --- decisions --------------------------------------------------------------

describe("decisions", () => {
  it("records approval", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1"));
    inbox.decide("a1", "approved", "reviewer-1", NOW + 5_000);

    const entry = inbox.get("a1")!;
    expect(entry.state).toBe("approved");
    expect(entry.decidedBy).toBe("reviewer-1");
    expect(entry.decidedAt).toBe(NOW + 5_000);
  });

  it("records rejection", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1"));
    inbox.decide("a1", "rejected", "reviewer-2", NOW + 5_000);

    expect(inbox.get("a1")!.state).toBe("rejected");
  });

  it("ignores decisions on non-pending approvals", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1"));
    inbox.decide("a1", "approved", "r1", NOW);
    inbox.decide("a1", "rejected", "r2", NOW + 1000); // Should be ignored.

    expect(inbox.get("a1")!.state).toBe("approved");
    expect(inbox.get("a1")!.decidedBy).toBe("r1");
  });
});

// --- expiry -----------------------------------------------------------------

describe("expiry", () => {
  it("expires pending approvals past their expiry time", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { expiresAt: NOW - 1 })); // Already expired.
    inbox.refresh(NOW, HEAD);

    expect(inbox.get("a1")!.state).toBe("expired");
    expect(inbox.getExpired()).toHaveLength(1);
  });

  it("does not expire decided approvals", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { expiresAt: NOW - 1 }));
    inbox.decide("a1", "approved", "r1", NOW - 2);
    inbox.refresh(NOW, HEAD);

    expect(inbox.get("a1")!.state).toBe("approved");
  });
});

// --- stale head -------------------------------------------------------------

describe("stale head", () => {
  it("flags stale head when SHA changes", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { headSha: "old-sha" }));
    inbox.refresh(NOW, "new-sha");

    expect(inbox.get("a1")!.staleHead).toBe(true);
    expect(inbox.getStaleHead()).toHaveLength(1);
  });

  it("does not flag when SHA matches", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { headSha: HEAD }));
    inbox.refresh(NOW, HEAD);

    expect(inbox.get("a1")!.staleHead).toBe(false);
  });
});

// --- multi-approval fixture -------------------------------------------------

describe("multi-approval fixture", () => {
  it("tracks multiple approvals with mixed states", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { riskLevel: "low" }));
    inbox.request(requestOpts("a2", { riskLevel: "high" }));
    inbox.request(requestOpts("a3", { riskLevel: "critical", expiresAt: NOW - 1 }));

    inbox.decide("a1", "approved", "reviewer", NOW);
    inbox.decide("a2", "rejected", "reviewer", NOW);
    inbox.refresh(NOW, HEAD);

    expect(inbox.size).toBe(3);
    expect(inbox.getPending()).toHaveLength(0);
    expect(inbox.getDecided()).toHaveLength(2);
    expect(inbox.getExpired()).toHaveLength(1);
  });
});

// --- inbox view -------------------------------------------------------------

describe("assembleInboxView", () => {
  it("assembles view with counts", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1"));
    inbox.request(requestOpts("a2", { expiresAt: NOW - 1 }));
    inbox.refresh(NOW, HEAD);

    const view = assembleInboxView(inbox);
    expect(view.totalCount).toBe(2);
    expect(view.pendingCount).toBe(1);
    expect(view.expiredCount).toBe(1);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("renders approval entry with decision trail", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { riskLevel: "high" }));
    inbox.decide("a1", "approved", "reviewer-1", NOW);

    const output = formatApprovalEntry(inbox.get("a1")!);
    expect(output).toContain("Execute a1");
    expect(output).toContain("high");
    expect(output).toContain("approved");
    expect(output).toContain("reviewer-1");
  });

  it("renders inbox summary with stale-head warning", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1", { headSha: "old" }));
    inbox.refresh(NOW, "new");

    const output = formatInboxSummary(inbox);
    expect(output).toContain("Approval Inbox");
    expect(output).toContain("STALE HEAD");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("inbox does not grant approvals or execute actions", () => {
    const inbox = new ApprovalInbox();
    inbox.request(requestOpts("a1"));

    // Pure data model — no side effects.
    expect(inbox.get("a1")!.state).toBe("pending");
  });
});
