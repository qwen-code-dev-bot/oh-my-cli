import { describe, it, expect } from "vitest";
import {
  isQuotaExhausted,
  quotaExhaustedGuidance,
  classifyTransient,
  QUOTA_REASON_CLASS,
} from "../../src/provider.js";

describe("isQuotaExhausted (#247)", () => {
  it("classifies a 429 carrying a documented quota code as exhausted", () => {
    expect(isQuotaExhausted({ status: 429, code: "insufficient_quota" })).toBe(true);
    expect(isQuotaExhausted({ status: 429, error: { code: "insufficient_quota" } })).toBe(true);
    expect(isQuotaExhausted({ status: 429, error: { type: "resource_exhausted" } })).toBe(true);
  });

  it("classifies a 403 carrying a documented quota code as exhausted", () => {
    expect(isQuotaExhausted({ status: 403, code: "quota_exceeded" })).toBe(true);
    expect(isQuotaExhausted({ status: 403, error: { type: "billing_quota_exceeded" } })).toBe(true);
  });

  it("matches case-insensitively and on hyphenated variants", () => {
    expect(isQuotaExhausted({ status: 429, code: "Insufficient-Quota" })).toBe(true);
    expect(isQuotaExhausted({ status: 429, type: "RESOURCE_EXHAUSTED" })).toBe(true);
  });

  it("does NOT label a bare 429 (transient throttling) as quota", () => {
    expect(isQuotaExhausted({ status: 429 })).toBe(false);
    expect(isQuotaExhausted({ status: 429, code: "rate_limit" })).toBe(false);
  });

  it("does NOT label a bare 403 (auth) as quota", () => {
    expect(isQuotaExhausted({ status: 403 })).toBe(false);
    expect(isQuotaExhausted({ status: 403, code: "invalid_api_key" })).toBe(false);
  });

  it("ignores quota signals on non-429/403 statuses", () => {
    expect(isQuotaExhausted({ status: 500, code: "insufficient_quota" })).toBe(false);
    expect(isQuotaExhausted({ status: 404, code: "insufficient_quota" })).toBe(false);
  });

  it("returns false when there is no status", () => {
    expect(isQuotaExhausted({ code: "insufficient_quota" })).toBe(false);
    expect(isQuotaExhausted(new Error("insufficient_quota"))).toBe(false);
  });
});

describe("quotaExhaustedGuidance (#247)", () => {
  it("includes the configured model and redacted host when provided", () => {
    const g = quotaExhaustedGuidance({ model: "fake-model", redactedHost: "api.example.com" });
    expect(g).toContain('model "fake-model"');
    expect(g).toContain("api.example.com");
    expect(g.toLowerCase()).toContain("quota");
    expect(g).toContain("not be retried automatically");
  });

  it("is provider-neutral and generic without model/host", () => {
    const g = quotaExhaustedGuidance();
    expect(g.toLowerCase()).toContain("quota");
    expect(g).toContain("account/project quota");
    expect(g).toContain("model access");
  });

  it("exposes a stable quota_exhausted reason class constant", () => {
    expect(QUOTA_REASON_CLASS).toBe("quota_exhausted");
  });
});

describe("classifyTransient quota interaction (#247)", () => {
  it("treats an exhausted-quota 429 as non-transient (no retry)", () => {
    expect(classifyTransient({ status: 429, code: "insufficient_quota" })).toBeNull();
    expect(classifyTransient({ status: 429, error: { type: "resource_exhausted" } })).toBeNull();
  });

  it("still treats a bare 429 as a transient rate limit", () => {
    const c = classifyTransient({ status: 429 });
    expect(c).not.toBeNull();
    expect(c!.reasonClass).toBe("rate_limited");
  });

  it("leaves server-error and network classifications unchanged", () => {
    expect(classifyTransient({ status: 503 })!.reasonClass).toBe("server_error");
    expect(classifyTransient({ code: "ECONNREFUSED" })!.reasonClass).toBe("network_error");
  });
});
