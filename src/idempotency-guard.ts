// Idempotency guard: prevents duplicate Goal execution when a submission
// is retried after an uncertain client response.
//
// Tracks submission keys and their execution state. Duplicate submissions
// return existing state without creating new executions. Keys are bounded
// (max 100 tracked) with oldest eviction. Key generation is deterministic.

import crypto from "node:crypto";

export const IDEMPOTENCY_GUARD_SCHEMA = "oh-my-cli.idempotency-guard";
export const IDEMPOTENCY_GUARD_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ExecutionState = "submitted" | "running" | "completed" | "failed";

export interface SubmissionRecord {
  /** Idempotency key. */
  key: string;
  /** Current execution state. */
  state: ExecutionState;
  /** When the submission was first received (epoch ms). */
  submittedAt: number;
  /** Last state update (epoch ms). */
  updatedAt: number;
  /** Whether this was a duplicate submission. */
  isDuplicate: boolean;
}

// --- key generation ---------------------------------------------------------

// Generate a deterministic idempotency key from objective, revision, and
// a time bucket (5-minute windows to group retries).
export function generateIdempotencyKey(
  objective: string,
  revision: number,
  timestamp: number,
  bucketSizeMs: number = 300_000, // 5 minutes
): string {
  const bucket = Math.floor(timestamp / bucketSizeMs);
  const input = `${objective}|${revision}|${bucket}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// --- idempotency guard ------------------------------------------------------

const MAX_TRACKED_KEYS = 100;

export class IdempotencyGuard {
  private readonly records = new Map<string, SubmissionRecord>();

  /** Submit with an idempotency key. Returns the existing record if the
   *  key has been seen before (duplicate), or creates a new record. */
  submit(key: string, now: number = Date.now()): SubmissionRecord {
    const existing = this.records.get(key);
    if (existing) {
      // Duplicate: return existing state, mark as duplicate.
      return { ...existing, isDuplicate: true };
    }

    // New submission.
    const record: SubmissionRecord = {
      key,
      state: "submitted",
      submittedAt: now,
      updatedAt: now,
      isDuplicate: false,
    };

    this.records.set(key, record);
    this.evictIfNeeded();
    return { ...record };
  }

  /** Update the execution state for a key. */
  updateState(key: string, state: ExecutionState, now: number = Date.now()): SubmissionRecord | null {
    const record = this.records.get(key);
    if (!record) return null;

    record.state = state;
    record.updatedAt = now;
    return { ...record };
  }

  /** Check if a key has been seen before. */
  has(key: string): boolean {
    return this.records.has(key);
  }

  /** Get the record for a key. */
  get(key: string): SubmissionRecord | null {
    const record = this.records.get(key);
    return record ? { ...record } : null;
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.records.size;
  }

  /** Evict oldest records if over the limit. */
  private evictIfNeeded(): void {
    if (this.records.size <= MAX_TRACKED_KEYS) return;

    // Find and remove the oldest record.
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, record] of this.records) {
      if (record.submittedAt < oldestTime) {
        oldestTime = record.submittedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.records.delete(oldestKey);
    }
  }
}
