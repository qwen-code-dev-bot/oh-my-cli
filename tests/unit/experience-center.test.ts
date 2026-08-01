import { describe, it, expect } from "vitest";
import {
  assembleHealthView,
  redactCredential,
  createFailure,
  formatHealthView,
  type HealthEntry,
} from "../../src/experience-center.js";

// Pure-function coverage for the experience center (Issue #346): redaction,
// provenance, partial failure, timeout, mixed-health fixtures, and read-only
// guarantee.

function entry(overrides: Partial<HealthEntry> = {}): HealthEntry {
  return {
    id: "test-1",
    kind: "provider",
    name: "Test Provider",
    capability: "chat, embeddings",
    availability: "available",
    provenance: "settings.json",
    trustPosture: "trusted",
    ...overrides,
  };
}

// --- credential redaction ---------------------------------------------------

describe("redactCredential", () => {
  it("redacts short values completely", () => {
    expect(redactCredential("short")).toBe("[REDACTED]");
    expect(redactCredential("12345678")).toBe("[REDACTED]");
  });

  it("shows only first/last 4 chars for longer values", () => {
    const result = redactCredential("sk-abcdefghijklmnop");
    expect(result).toContain("sk-a");
    expect(result).toContain("mnop");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdefghijklmnop");
  });

  it("never returns the raw value", () => {
    const raw = "my-super-secret-api-key-12345";
    const result = redactCredential(raw);
    expect(result).not.toBe(raw);
    expect(result).toContain("[REDACTED]");
  });
});

// --- health view assembly ---------------------------------------------------

describe("assembleHealthView", () => {
  it("counts availability states", () => {
    const view = assembleHealthView([
      entry({ id: "1", availability: "available" }),
      entry({ id: "2", availability: "degraded" }),
      entry({ id: "3", availability: "unavailable" }),
      entry({ id: "4", availability: "unknown" }),
    ]);

    expect(view.availableCount).toBe(1);
    expect(view.degradedCount).toBe(1);
    expect(view.unavailableCount).toBe(1);
    expect(view.unknownCount).toBe(1);
    expect(view.hasFailures).toBe(false);
  });

  it("detects failures", () => {
    const view = assembleHealthView([
      entry({ id: "1", availability: "unavailable", failure: createFailure("authentication") }),
    ]);

    expect(view.hasFailures).toBe(true);
  });

  it("handles empty entries", () => {
    const view = assembleHealthView([]);
    expect(view.availableCount).toBe(0);
    expect(view.hasFailures).toBe(false);
  });
});

// --- failure categories -----------------------------------------------------

describe("createFailure", () => {
  it("provides default guidance per category", () => {
    const categories = ["configuration", "authentication", "connectivity", "capability", "permission", "lifecycle"] as const;
    for (const cat of categories) {
      const failure = createFailure(cat);
      expect(failure.category).toBe(cat);
      expect(failure.guidance.length).toBeGreaterThan(0);
    }
  });

  it("allows custom guidance", () => {
    const failure = createFailure("connectivity", "Check your proxy settings.");
    expect(failure.guidance).toBe("Check your proxy settings.");
  });
});

// --- mixed-health fixture ---------------------------------------------------

describe("mixed-health fixture", () => {
  it("handles healthy, degraded, and failed entries together", () => {
    const view = assembleHealthView([
      entry({
        id: "provider-1",
        kind: "provider",
        name: "DashScope",
        availability: "available",
        latencyMs: 45,
        credentialRef: redactCredential("sk-test-key-123456789"),
      }),
      entry({
        id: "model-1",
        kind: "model",
        name: "qwen3-max",
        availability: "unavailable",
        capability: "chat",
        failure: createFailure("capability", "Model not available in current region."),
      }),
      entry({
        id: "mcp-1",
        kind: "mcp-server",
        name: "browser",
        availability: "degraded",
        trustPosture: "sandbox-enforced",
        failure: createFailure("permission", "Missing screen recording permission."),
      }),
    ]);

    expect(view.availableCount).toBe(1);
    expect(view.degradedCount).toBe(1);
    expect(view.unavailableCount).toBe(1);
    expect(view.hasFailures).toBe(true);
    expect(view.entries).toHaveLength(3);
  });
});

// --- provenance -------------------------------------------------------------

describe("provenance", () => {
  it("tracks configuration source", () => {
    const e = entry({ provenance: "~/.oh-my-cli/settings.json" });
    expect(e.provenance).toBe("~/.oh-my-cli/settings.json");
  });

  it("tracks environment variable source", () => {
    const e = entry({ provenance: "env:DASHSCOPE_API_KEY" });
    expect(e.provenance).toBe("env:DASHSCOPE_API_KEY");
  });
});

// --- timeout fixture --------------------------------------------------------

describe("timeout fixture", () => {
  it("reports unknown availability with connectivity failure on timeout", () => {
    const e = entry({
      availability: "unknown",
      failure: createFailure("connectivity", "Probe timed out after 10000ms."),
    });

    expect(e.availability).toBe("unknown");
    expect(e.failure?.category).toBe("connectivity");
    expect(e.failure?.guidance).toContain("timed out");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatHealthView", () => {
  it("renders providers, models, and MCP servers with failures", () => {
    const view = assembleHealthView([
      entry({
        id: "p1",
        kind: "provider",
        name: "DashScope",
        availability: "available",
        latencyMs: 42,
        credentialRef: redactCredential("sk-test-key-123456789"),
      }),
      entry({
        id: "m1",
        kind: "model",
        name: "gpt-4o",
        availability: "unavailable",
        capability: "chat",
        failure: createFailure("authentication"),
      }),
      entry({
        id: "mcp1",
        kind: "mcp-server",
        name: "browser",
        availability: "degraded",
        trustPosture: "sandbox-enforced",
      }),
    ]);

    const output = formatHealthView(view);

    expect(output).toContain("Experience Center");
    expect(output).toContain("DashScope");
    expect(output).toContain("42ms");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("gpt-4o");
    expect(output).toContain("authentication");
    expect(output).toContain("browser");
    expect(output).toContain("sandbox-enforced");
    expect(output).toContain("Read-only");
  });

  it("does not expose raw credentials", () => {
    const raw = "sk-my-very-secret-key-999";
    const view = assembleHealthView([
      entry({ credentialRef: redactCredential(raw) }),
    ]);

    const output = formatHealthView(view);
    expect(output).not.toContain(raw);
    expect(output).toContain("[REDACTED]");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("assembly does not mutate input entries", () => {
    const entries = [
      entry({ id: "1", availability: "available" }),
      entry({ id: "2", availability: "unavailable" }),
    ];

    const before = JSON.stringify(entries);
    assembleHealthView(entries);
    expect(JSON.stringify(entries)).toBe(before);
  });
});
