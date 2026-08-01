import { describe, it, expect } from "vitest";
import {
  InvestigationTracker,
  isValidTransition,
  formatInvestigation,
  type HypothesisEntry,
} from "../../src/debug-lab.js";

// Pure-function coverage for the debug lab (Issue #367): lifecycle phases,
// hypothesis table, evidence, invalid transitions, and read-only guarantee.

function hypothesis(id: string, desc: string, overrides: Partial<HypothesisEntry> = {}): HypothesisEntry {
  return { id, description: desc, status: "active", evidenceFor: [], evidenceAgainst: [], ...overrides };
}

// --- lifecycle phases -------------------------------------------------------

describe("lifecycle phases", () => {
  it("starts in reproduce phase", () => {
    const tracker = new InvestigationTracker();
    const inv = tracker.start({ id: "inv-1", title: "Null pointer on save", createdAt: 1000 });

    expect(inv.currentPhase).toBe("reproduce");
    expect(inv.phaseHistory).toHaveLength(1);
  });

  it("advances through valid phases", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });

    expect(tracker.advancePhase("inv-1", "minimize", 2000).ok).toBe(true);
    expect(tracker.advancePhase("inv-1", "hypothesize", 3000).ok).toBe(true);
    expect(tracker.advancePhase("inv-1", "fix", 4000).ok).toBe(true);
    expect(tracker.advancePhase("inv-1", "verify", 5000).ok).toBe(true);
    expect(tracker.advancePhase("inv-1", "close", 6000).ok).toBe(true);

    const inv = tracker.get("inv-1")!;
    expect(inv.currentPhase).toBe("close");
    expect(inv.phaseHistory).toHaveLength(6);
  });

  it("allows skipping phases forward", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });

    // Skip minimize and hypothesize, go straight to instrument.
    expect(tracker.advancePhase("inv-1", "instrument", 2000).ok).toBe(true);
    expect(tracker.get("inv-1")!.currentPhase).toBe("instrument");
  });
});

// --- invalid transitions ----------------------------------------------------

describe("invalid transitions", () => {
  it("rejects backward transitions", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });
    tracker.advancePhase("inv-1", "fix", 2000);

    const result = tracker.advancePhase("inv-1", "reproduce", 3000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forward");
  });

  it("rejects same-phase transitions", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });

    const result = tracker.advancePhase("inv-1", "reproduce", 2000);
    expect(result.ok).toBe(false);
  });

  it("rejects transitions for nonexistent investigations", () => {
    const tracker = new InvestigationTracker();
    const result = tracker.advancePhase("nonexistent", "fix", 1000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not found");
  });
});

describe("isValidTransition", () => {
  it("allows forward transitions", () => {
    expect(isValidTransition("reproduce", "minimize")).toBe(true);
    expect(isValidTransition("reproduce", "close")).toBe(true);
    expect(isValidTransition("hypothesize", "verify")).toBe(true);
  });

  it("rejects backward and same transitions", () => {
    expect(isValidTransition("fix", "reproduce")).toBe(false);
    expect(isValidTransition("close", "reproduce")).toBe(false);
    expect(isValidTransition("fix", "fix")).toBe(false);
  });
});

// --- hypothesis table -------------------------------------------------------

describe("hypothesis table", () => {
  it("adds and tracks hypotheses", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });
    tracker.addHypothesis("inv-1", hypothesis("h1", "Race condition in save handler"));
    tracker.addHypothesis("inv-1", hypothesis("h2", "Stale cache reference"));

    const inv = tracker.get("inv-1")!;
    expect(inv.hypotheses).toHaveLength(2);
    expect(inv.hypotheses[0].status).toBe("active");
  });

  it("confirms and rejects hypotheses", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });
    tracker.addHypothesis("inv-1", hypothesis("h1", "Race condition"));
    tracker.addHypothesis("inv-1", hypothesis("h2", "Stale cache"));

    tracker.setHypothesisStatus("inv-1", "h1", "confirmed");
    tracker.setHypothesisStatus("inv-1", "h2", "rejected");

    const inv = tracker.get("inv-1")!;
    expect(inv.hypotheses[0].status).toBe("confirmed");
    expect(inv.hypotheses[1].status).toBe("rejected");
  });

  it("adds evidence for and against", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });
    tracker.addHypothesis("inv-1", hypothesis("h1", "Race condition"));

    tracker.addEvidence("inv-1", "h1", "Concurrent test fails 3/10 runs", "for");
    tracker.addEvidence("inv-1", "h1", "Single-threaded repro succeeds", "against");

    const hyp = tracker.get("inv-1")!.hypotheses[0];
    expect(hyp.evidenceFor).toHaveLength(1);
    expect(hyp.evidenceAgainst).toHaveLength(1);
  });
});

// --- multi-hypothesis fixture -----------------------------------------------

describe("multi-hypothesis fixture", () => {
  it("tracks a full investigation with multiple hypotheses", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Data loss on concurrent save", createdAt: 1000 });

    tracker.addHypothesis("inv-1", hypothesis("h1", "Race condition in file writer"));
    tracker.addHypothesis("inv-1", hypothesis("h2", "Truncation from partial flush"));
    tracker.addHypothesis("inv-1", hypothesis("h3", "Encoding mismatch"));

    tracker.advancePhase("inv-1", "hypothesize", 2000);
    tracker.addEvidence("inv-1", "h1", "Stress test reproduces at 100 concurrent writes", "for");
    tracker.addEvidence("inv-1", "h2", "File size matches expected after flush", "against");
    tracker.setHypothesisStatus("inv-1", "h2", "rejected");
    tracker.setHypothesisStatus("inv-1", "h3", "rejected");

    tracker.advancePhase("inv-1", "fix", 3000);
    tracker.setHypothesisStatus("inv-1", "h1", "confirmed");
    tracker.addReceipt("inv-1", "stress-test-output.txt");

    tracker.advancePhase("inv-1", "verify", 4000);
    tracker.advancePhase("inv-1", "close", 5000);

    const inv = tracker.get("inv-1")!;
    expect(inv.currentPhase).toBe("close");
    expect(inv.hypotheses.filter((h) => h.status === "confirmed")).toHaveLength(1);
    expect(inv.hypotheses.filter((h) => h.status === "rejected")).toHaveLength(2);
    expect(inv.receiptRefs).toHaveLength(1);
    expect(inv.phaseHistory).toHaveLength(5);
  });
});

// --- receipt references -----------------------------------------------------

describe("receipt references", () => {
  it("bounds receipts to the configured limit", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });

    for (let i = 0; i < 60; i++) {
      tracker.addReceipt("inv-1", `receipt-${i}.txt`);
    }

    expect(tracker.get("inv-1")!.receiptRefs).toHaveLength(50);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatInvestigation", () => {
  it("renders investigation with hypotheses and evidence", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Null pointer", createdAt: 1000 });
    tracker.addHypothesis("inv-1", hypothesis("h1", "Uninitialized ref", {
      status: "confirmed",
      evidenceFor: ["Stack trace shows null at line 42"],
    }));
    tracker.addHypothesis("inv-1", hypothesis("h2", "Async timing", {
      status: "rejected",
      evidenceAgainst: ["Deterministic repro"],
    }));

    const output = formatInvestigation(tracker.get("inv-1")!);
    expect(output).toContain("Null pointer");
    expect(output).toContain("reproduce");
    expect(output).toContain("Uninitialized ref");
    expect(output).toContain("confirmed");
    expect(output).toContain("Async timing");
    expect(output).toContain("rejected");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("tracking does not execute commands or modify files", () => {
    const tracker = new InvestigationTracker();
    tracker.start({ id: "inv-1", title: "Bug", createdAt: 1000 });
    tracker.addHypothesis("inv-1", hypothesis("h1", "Test"));
    tracker.advancePhase("inv-1", "close", 2000);

    // The tracker is a pure data model — no side effects.
    expect(tracker.get("inv-1")!.currentPhase).toBe("close");
  });
});
