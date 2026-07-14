import { describe, it, expect } from "vitest";
import { formatPreflight } from "../../src/preflight.js";
import type { PreflightResult } from "../../src/preflight.js";

describe("Preflight: formatPreflight", () => {
  it("formats successful result", () => {
    const result: PreflightResult = { ok: true, model: "gpt-4", latencyMs: 123 };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("Provider connected");
    expect(formatted).toContain("gpt-4");
    expect(formatted).toContain("123ms");
  });

  it("formats auth_rejected failure without revealing credentials", () => {
    const result: PreflightResult = {
      ok: false,
      category: "auth_rejected",
      message: "Authentication failed (401). Check OPENAI_API_KEY.",
    };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("auth_rejected");
    expect(formatted).toContain("Authentication failed");
  });

  it("formats network_failure", () => {
    const result: PreflightResult = {
      ok: false,
      category: "network_failure",
      message: "Cannot reach http://localhost:9999 (ECONNREFUSED).",
    };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("network_failure");
    expect(formatted).toContain("ECONNREFUSED");
  });

  it("formats unsupported_model", () => {
    const result: PreflightResult = {
      ok: false,
      category: "unsupported_model",
      message: 'Model "fake-model" is not available.',
    };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("unsupported_model");
    expect(formatted).toContain("fake-model");
  });

  it("formats missing_config", () => {
    const result: PreflightResult = {
      ok: false,
      category: "missing_config",
      message: "Missing OPENAI_API_KEY or OPENAI_MODEL.",
    };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("missing_config");
    expect(formatted).toContain("OPENAI_API_KEY");
  });
});
