import { describe, it, expect } from "vitest";
import {
  evaluateRetention,
  formatRetentionReport,
  formatBytes,
  DEFAULT_RETENTION_POLICY,
  type ArtifactRecord,
  type RetentionPolicy,
} from "../../src/artifact-retention.js";

// Pure-function coverage for artifact retention (Issue #430): retention
// evaluation, age-based and count-based eligibility, and determinism.

const NOW = 1_000_000_000_000; // Fixed timestamp for determinism.
const DAY = 86_400_000;

function artifact(id: string, ageDays: number, revision: number = 1, sizeBytes: number = 100): ArtifactRecord {
  return {
    id,
    type: "audit-event",
    createdAt: NOW - ageDays * DAY,
    sizeBytes,
    goalRevision: revision,
  };
}

// --- age-based eligibility --------------------------------------------------

describe("age-based eligibility", () => {
  it("retains artifacts within max age", () => {
    const artifacts = [artifact("a1", 3), artifact("a2", 5)];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);

    expect(evaluation.retained).toHaveLength(2);
    expect(evaluation.eligibleForCleanup).toHaveLength(0);
  });

  it("marks old artifacts as eligible for cleanup", () => {
    const artifacts = [artifact("a1", 3), artifact("a2", 10)];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);

    expect(evaluation.retained).toHaveLength(1);
    expect(evaluation.eligibleForCleanup).toHaveLength(1);
    expect(evaluation.eligibleForCleanup[0].id).toBe("a2");
    expect(evaluation.cleanupReasons.get("a2")).toContain("Age");
  });

  it("respects custom max age", () => {
    const policy: RetentionPolicy = { maxAgeDays: 30, maxCountPerRevision: 50 };
    const artifacts = [artifact("a1", 20)];
    const evaluation = evaluateRetention(artifacts, policy, NOW);

    expect(evaluation.retained).toHaveLength(1);
  });
});

// --- count-based eligibility ------------------------------------------------

describe("count-based eligibility", () => {
  it("retains artifacts within max count", () => {
    const artifacts = Array.from({ length: 5 }, (_, i) => artifact(`a${i}`, 1, 1));
    const policy: RetentionPolicy = { maxAgeDays: 7, maxCountPerRevision: 10 };
    const evaluation = evaluateRetention(artifacts, policy, NOW);

    expect(evaluation.retained).toHaveLength(5);
    expect(evaluation.eligibleForCleanup).toHaveLength(0);
  });

  it("marks excess artifacts as eligible for cleanup", () => {
    const artifacts = Array.from({ length: 15 }, (_, i) => artifact(`a${i}`, 1, 1, 100));
    const policy: RetentionPolicy = { maxAgeDays: 7, maxCountPerRevision: 10 };
    const evaluation = evaluateRetention(artifacts, policy, NOW);

    expect(evaluation.retained).toHaveLength(10);
    expect(evaluation.eligibleForCleanup).toHaveLength(5);
    // Oldest artifacts should be eligible (sorted newest first, excess at end).
    for (const a of evaluation.eligibleForCleanup) {
      expect(evaluation.cleanupReasons.get(a.id)).toContain("Count");
    }
  });

  it("evaluates count per revision independently", () => {
    const artifacts = [
      ...Array.from({ length: 5 }, (_, i) => artifact(`r1-${i}`, 1, 1)),
      ...Array.from({ length: 5 }, (_, i) => artifact(`r2-${i}`, 1, 2)),
    ];
    const policy: RetentionPolicy = { maxAgeDays: 7, maxCountPerRevision: 3 };
    const evaluation = evaluateRetention(artifacts, policy, NOW);

    // 3 retained per revision = 6 total, 4 eligible.
    expect(evaluation.retained).toHaveLength(6);
    expect(evaluation.eligibleForCleanup).toHaveLength(4);
  });
});

// --- size tracking ----------------------------------------------------------

describe("size tracking", () => {
  it("tracks retained and cleanup sizes", () => {
    const artifacts = [
      artifact("a1", 1, 1, 500),
      artifact("a2", 10, 1, 300),
    ];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);

    expect(evaluation.retainedSizeBytes).toBe(500);
    expect(evaluation.cleanupSizeBytes).toBe(300);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatRetentionReport", () => {
  it("renders retention report", () => {
    const artifacts = [
      artifact("a1", 1, 1, 500),
      artifact("a2", 10, 1, 300),
    ];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);
    const output = formatRetentionReport(evaluation);

    expect(output).toContain("Artifact Retention Report");
    expect(output).toContain("Retained: 1");
    expect(output).toContain("Eligible for cleanup: 1");
    expect(output).toContain("a2");
    expect(output).toContain("Age");
    expect(output).toContain("Read-only");
  });

  it("shows no cleanup when all retained", () => {
    const artifacts = [artifact("a1", 1)];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);
    const output = formatRetentionReport(evaluation);

    expect(output).toContain("Retained: 1");
    expect(output).toContain("Eligible for cleanup: 0");
  });

  it("is deterministic", () => {
    const artifacts = [artifact("a1", 1), artifact("a2", 10)];
    const evaluation = evaluateRetention(artifacts, DEFAULT_RETENTION_POLICY, NOW);
    const a = formatRetentionReport(evaluation);
    const b = formatRetentionReport(evaluation);
    expect(a).toBe(b);
  });
});

// --- formatBytes unit tiers (Issue #850) ------------------------------------

describe("formatBytes", () => {
  it("renders sub-KB values as raw bytes", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(1023)).toBe("1023B");
  });

  it("renders KB values (unchanged behavior)", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(1536)).toBe("1.5KB");
  });

  it("renders MB values (unchanged behavior)", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0MB");
    expect(formatBytes(2.5 * 1024 ** 2)).toBe("2.5MB");
  });

  it("renders GB values with a GB unit instead of thousands of MB (Issue #850)", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0GB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5GB");
    // Just under 1 GB stays in the MB tier.
    expect(formatBytes(1000 * 1024 ** 2)).toBe("1000.0MB");
  });

  it("renders TB values with a TB unit instead of millions of MB (Issue #850)", () => {
    expect(formatBytes(1024 ** 4)).toBe("1.0TB");
    // Just under 1 TB stays in the GB tier.
    expect(formatBytes(1000 * 1024 ** 3)).toBe("1000.0GB");
  });
});
