import { describe, it, expect } from "vitest";
import {
  IdempotencyGuard,
  generateIdempotencyKey,
} from "../../src/idempotency-guard.js";

// Pure-function coverage for idempotency guard (Issue #413): duplicate
// detection, key bounding, eviction, determinism, and new-submission.

// --- key generation ---------------------------------------------------------

describe("generateIdempotencyKey", () => {
  it("generates deterministic keys", () => {
    const a = generateIdempotencyKey("Build API", 1, 1000000);
    const b = generateIdempotencyKey("Build API", 1, 1000000);
    expect(a).toBe(b);
  });

  it("generates different keys for different objectives", () => {
    const a = generateIdempotencyKey("Build API", 1, 1000000);
    const b = generateIdempotencyKey("Write tests", 1, 1000000);
    expect(a).not.toBe(b);
  });

  it("generates different keys for different revisions", () => {
    const a = generateIdempotencyKey("Build API", 1, 1000000);
    const b = generateIdempotencyKey("Build API", 2, 1000000);
    expect(a).not.toBe(b);
  });

  it("groups retries within the same time bucket", () => {
    // Same 5-minute bucket.
    const a = generateIdempotencyKey("Build API", 1, 1000000);
    const b = generateIdempotencyKey("Build API", 1, 1100000); // +100s, same bucket
    expect(a).toBe(b);
  });

  it("separates different time buckets", () => {
    const a = generateIdempotencyKey("Build API", 1, 1000000);
    const b = generateIdempotencyKey("Build API", 1, 2000000); // Different bucket
    expect(a).not.toBe(b);
  });

  it("produces 16-char hex keys", () => {
    const key = generateIdempotencyKey("Build API", 1, 1000000);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

// --- duplicate detection ----------------------------------------------------

describe("duplicate detection", () => {
  it("creates new record for new key", () => {
    const guard = new IdempotencyGuard();
    const record = guard.submit("key-1", 1000);

    expect(record.isDuplicate).toBe(false);
    expect(record.state).toBe("submitted");
    expect(record.submittedAt).toBe(1000);
  });

  it("detects duplicate submission", () => {
    const guard = new IdempotencyGuard();
    guard.submit("key-1", 1000);
    const dup = guard.submit("key-1", 2000);

    expect(dup.isDuplicate).toBe(true);
    expect(dup.submittedAt).toBe(1000); // Original timestamp.
  });

  it("returns existing state for duplicate", () => {
    const guard = new IdempotencyGuard();
    guard.submit("key-1", 1000);
    guard.updateState("key-1", "running", 1500);
    const dup = guard.submit("key-1", 2000);

    expect(dup.isDuplicate).toBe(true);
    expect(dup.state).toBe("running");
  });
});

// --- state updates ----------------------------------------------------------

describe("updateState", () => {
  it("updates execution state", () => {
    const guard = new IdempotencyGuard();
    guard.submit("key-1", 1000);
    const updated = guard.updateState("key-1", "completed", 2000);

    expect(updated!.state).toBe("completed");
    expect(updated!.updatedAt).toBe(2000);
  });

  it("returns null for unknown key", () => {
    const guard = new IdempotencyGuard();
    expect(guard.updateState("unknown", "completed")).toBeNull();
  });
});

// --- key bounding and eviction ----------------------------------------------

describe("key bounding", () => {
  it("bounds tracked keys at 100", () => {
    const guard = new IdempotencyGuard();
    for (let i = 0; i < 110; i++) {
      guard.submit(`key-${i}`, i * 1000);
    }

    expect(guard.size).toBeLessThanOrEqual(100);
  });

  it("evicts oldest keys", () => {
    const guard = new IdempotencyGuard();
    for (let i = 0; i < 105; i++) {
      guard.submit(`key-${i}`, i * 1000);
    }

    // Oldest keys should be evicted.
    expect(guard.has("key-0")).toBe(false);
    expect(guard.has("key-104")).toBe(true);
  });
});

// --- has/get ----------------------------------------------------------------

describe("has/get", () => {
  it("checks key existence", () => {
    const guard = new IdempotencyGuard();
    guard.submit("key-1", 1000);

    expect(guard.has("key-1")).toBe(true);
    expect(guard.has("key-2")).toBe(false);
  });

  it("gets record copy", () => {
    const guard = new IdempotencyGuard();
    guard.submit("key-1", 1000);
    const record = guard.get("key-1");

    expect(record).not.toBeNull();
    expect(record!.key).toBe("key-1");
    // Modifying the copy doesn't affect the guard.
    record!.state = "failed";
    expect(guard.get("key-1")!.state).toBe("submitted");
  });

  it("returns null for unknown key", () => {
    const guard = new IdempotencyGuard();
    expect(guard.get("unknown")).toBeNull();
  });
});

// --- determinism ------------------------------------------------------------

describe("determinism", () => {
  it("same inputs produce same results", () => {
    const guard1 = new IdempotencyGuard();
    const guard2 = new IdempotencyGuard();

    const r1 = guard1.submit("key-1", 1000);
    const r2 = guard2.submit("key-1", 1000);

    expect(r1.key).toBe(r2.key);
    expect(r1.state).toBe(r2.state);
    expect(r1.submittedAt).toBe(r2.submittedAt);
  });
});
