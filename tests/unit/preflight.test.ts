import { describe, it, expect } from "vitest";
import { formatPreflight, runPreflight } from "../../src/preflight.js";
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

  it("formats the offline-allowed posture without claiming connectivity", () => {
    const result: PreflightResult = { ok: true, model: "local-model", latencyMs: 0, offline: true };
    const formatted = formatPreflight(result);
    expect(formatted).toContain("Offline mode");
    expect(formatted).toContain("loopback endpoint allowed");
    expect(formatted).toContain("not probed");
    expect(formatted).not.toContain("Provider connected");
  });
});

describe("Preflight: offline posture (Issue #576)", () => {
  const base = { apiKey: "k", model: "local-model" };

  it("allows a loopback route without any network probe", async () => {
    // An unreachable-but-loopback URL: a real probe would fail with
    // ECONNREFUSED, so an ok result proves no probe happened.
    const result = await runPreflight({ ...base, baseUrl: "http://127.0.0.1:1/v1", offline: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offline).toBe(true);
      expect(result.latencyMs).toBe(0);
    }
  });

  it("refuses a non-loopback route exactly as dispatch would", async () => {
    const result = await runPreflight({ ...base, baseUrl: "https://api.openai.com/v1", offline: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("network_failure");
      expect(result.message).toContain("Offline mode is active");
      expect(result.message).toContain("api.openai.com");
    }
  });
});
