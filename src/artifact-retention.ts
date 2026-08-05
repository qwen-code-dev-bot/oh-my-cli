// Artifact retention: defines retention and cleanup rules for completed
// Goal execution artifacts.
//
// RetentionPolicy defines max age (days) and max count. ArtifactInventory
// tracks artifact type, creation time, and size. evaluateRetention determines
// cleanup eligibility. Read-only evaluation (does not delete anything).
// Deterministic.

export const ARTIFACT_RETENTION_SCHEMA = "oh-my-cli.artifact-retention";
export const ARTIFACT_RETENTION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ArtifactType =
  | "audit-event"
  | "cancelled-attempt"
  | "completion-summary"
  | "failure-summary"
  | "execution-outline"
  | "answer-route";

export interface ArtifactRecord {
  /** Artifact identifier. */
  id: string;
  type: ArtifactType;
  /** When the artifact was created (epoch ms). */
  createdAt: number;
  /** Size in bytes (approximate). */
  sizeBytes: number;
  /** Goal revision this artifact belongs to. */
  goalRevision: number;
}

export interface RetentionPolicy {
  /** Maximum age in days. Artifacts older than this are eligible for cleanup. */
  maxAgeDays: number;
  /** Maximum count per Goal revision. Excess artifacts are eligible for cleanup. */
  maxCountPerRevision: number;
}

export interface RetentionEvaluation {
  /** Artifacts that should be retained. */
  retained: ArtifactRecord[];
  /** Artifacts eligible for cleanup. */
  eligibleForCleanup: ArtifactRecord[];
  /** Reason for each cleanup eligibility. */
  cleanupReasons: Map<string, string>;
  /** Total size of retained artifacts. */
  retainedSizeBytes: number;
  /** Total size of cleanup-eligible artifacts. */
  cleanupSizeBytes: number;
}

// --- default policy ---------------------------------------------------------

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxAgeDays: 7,
  maxCountPerRevision: 50,
};

// --- retention evaluation ---------------------------------------------------

const MS_PER_DAY = 86_400_000;

// Evaluate retention for a set of artifacts.
export function evaluateRetention(
  artifacts: ArtifactRecord[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now(),
): RetentionEvaluation {
  const retained: ArtifactRecord[] = [];
  const eligibleForCleanup: ArtifactRecord[] = [];
  const cleanupReasons = new Map<string, string>();

  const maxAgeMs = policy.maxAgeDays * MS_PER_DAY;

  // Group by revision for count-based evaluation.
  const byRevision = new Map<number, ArtifactRecord[]>();
  for (const artifact of artifacts) {
    const group = byRevision.get(artifact.goalRevision) ?? [];
    group.push(artifact);
    byRevision.set(artifact.goalRevision, group);
  }

  for (const artifact of artifacts) {
    const ageMs = now - artifact.createdAt;
    const isTooOld = ageMs > maxAgeMs;

    // Count-based: sort by creation time (newest first), keep maxCount.
    const revisionGroup = byRevision.get(artifact.goalRevision)!;
    const sorted = [...revisionGroup].sort((a, b) => b.createdAt - a.createdAt);
    const indexInRevision = sorted.indexOf(artifact);
    const isExcess = indexInRevision >= policy.maxCountPerRevision;

    if (isTooOld) {
      eligibleForCleanup.push(artifact);
      cleanupReasons.set(artifact.id, `Age ${Math.floor(ageMs / MS_PER_DAY)}d exceeds max ${policy.maxAgeDays}d`);
    } else if (isExcess) {
      eligibleForCleanup.push(artifact);
      cleanupReasons.set(artifact.id, `Count ${indexInRevision + 1} exceeds max ${policy.maxCountPerRevision} per revision`);
    } else {
      retained.push(artifact);
    }
  }

  const retainedSizeBytes = retained.reduce((sum, a) => sum + a.sizeBytes, 0);
  const cleanupSizeBytes = eligibleForCleanup.reduce((sum, a) => sum + a.sizeBytes, 0);

  return {
    retained,
    eligibleForCleanup,
    cleanupReasons,
    retainedSizeBytes,
    cleanupSizeBytes,
  };
}

// --- formatting -------------------------------------------------------------

export function formatRetentionReport(evaluation: RetentionEvaluation): string {
  const lines: string[] = [];

  lines.push("Artifact Retention Report");
  lines.push("═".repeat(50));
  lines.push(`Retained: ${evaluation.retained.length} (${formatBytes(evaluation.retainedSizeBytes)})`);
  lines.push(`Eligible for cleanup: ${evaluation.eligibleForCleanup.length} (${formatBytes(evaluation.cleanupSizeBytes)})`);

  if (evaluation.eligibleForCleanup.length > 0) {
    lines.push("");
    lines.push("Eligible for cleanup:");
    for (const artifact of evaluation.eligibleForCleanup.slice(0, 10)) {
      const reason = evaluation.cleanupReasons.get(artifact.id) ?? "unknown";
      lines.push(`  · ${artifact.id} [${artifact.type}] — ${reason}`);
    }
    if (evaluation.eligibleForCleanup.length > 10) {
      lines.push(`  … ${evaluation.eligibleForCleanup.length - 10} more`);
    }
  }

  lines.push("");
  lines.push("Read-only: no artifacts deleted.");

  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
