import { describe, it, expect } from "vitest";
import {
  classifyTransient,
  backoffDelayMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "../../src/provider.js";

describe("classifyTransient", () => {
  it("treats 429 as rate_limited and reads Retry-After", () => {
    expect(classifyTransient({ status: 429, headers: { "retry-after": "1" } })).toEqual({
      reasonClass: "rate_limited",
      retryAfterMs: 1000,
    });
  });

  it("treats 429 without Retry-After as rate_limited with null delay", () => {
    expect(classifyTransient({ status: 429 })).toEqual({
      reasonClass: "rate_limited",
      retryAfterMs: null,
    });
  });

  it.each([500, 502, 503, 504])("treats %i as server_error", (status) => {
    const c = classifyTransient({ status });
    expect(c?.reasonClass).toBe("server_error");
  });

  it("clamps an oversized Retry-After to the per-attempt maximum", () => {
    const c = classifyTransient({ status: 503, headers: { "retry-after": "10" } });
    expect(c?.retryAfterMs).toBe(RETRY_MAX_DELAY_MS);
  });

  it("ignores an HTTP-date Retry-After (treated as absent)", () => {
    const c = classifyTransient({ status: 503, headers: { "retry-after": "Wed, 21 Oct 2025 07:28:00 GMT" } });
    expect(c?.retryAfterMs).toBeNull();
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"])(
    "treats network code %s as network_error",
    (code) => {
      expect(classifyTransient({ code })).toEqual({ reasonClass: "network_error", retryAfterMs: null });
    },
  );

  it("reads a transient network code from the error cause", () => {
    expect(classifyTransient({ cause: { code: "ETIMEDOUT" } })).toEqual({
      reasonClass: "network_error",
      retryAfterMs: null,
    });
  });

  it.each([400, 401, 403, 404, 422])("returns null for non-retryable status %i", (status) => {
    expect(classifyTransient({ status })).toBeNull();
  });

  it("returns null for an unknown error with no status or code", () => {
    expect(classifyTransient(new Error("boom"))).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("honors a clamped Retry-After when present", () => {
    expect(backoffDelayMs(1, 1500)).toBe(1500);
  });

  it("clamps Retry-After to the maximum", () => {
    expect(backoffDelayMs(1, RETRY_MAX_DELAY_MS + 5000)).toBe(RETRY_MAX_DELAY_MS);
  });

  it("grows exponentially with a fixed rng (equal jitter)", () => {
    const rng = () => 0.5;
    // capped/2 + capped/2 * 0.5 == 0.75 * capped
    expect(backoffDelayMs(1, null, rng)).toBe(Math.round(RETRY_BASE_DELAY_MS * 0.75)); // 150
    expect(backoffDelayMs(2, null, rng)).toBe(Math.round(RETRY_BASE_DELAY_MS * 2 * 0.75)); // 300
    expect(backoffDelayMs(3, null, rng)).toBe(Math.round(RETRY_BASE_DELAY_MS * 4 * 0.75)); // 600
  });

  it("never returns zero (rng = 0 yields half the capped window)", () => {
    expect(backoffDelayMs(1, null, () => 0)).toBe(RETRY_BASE_DELAY_MS / 2); // 100
  });

  it("returns the full capped window at rng = 1", () => {
    expect(backoffDelayMs(1, null, () => 1)).toBe(RETRY_BASE_DELAY_MS); // 200
  });

  it("caps the delay at the maximum for large attempt counts", () => {
    expect(backoffDelayMs(20, null, () => 1)).toBe(RETRY_MAX_DELAY_MS);
    expect(backoffDelayMs(20, null, () => 0)).toBe(RETRY_MAX_DELAY_MS / 2);
  });

  it("is monotonic non-decreasing in attempt for a fixed rng, up to the cap", () => {
    const rng = () => 0.5;
    let prev = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const d = backoffDelayMs(attempt, null, rng);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
      prev = d;
    }
  });
});
