import { describe, it, expect } from "vitest";
import {
  resolveSettings,
  assembleSettingsView,
  formatSettingsView,
  isSecretKey,
  redactValue,
  isDeprecatedKey,
  type RawSetting,
} from "../../src/settings-inspection.js";

// Pure-function coverage for settings inspection (Issue #364): provenance,
// redaction, validation, multi-layer, deprecated-key fixtures, and
// read-only guarantee.

function raw(key: string, value: string, layer: RawSetting["layer"]): RawSetting {
  return { key, value, layer };
}

// --- secret detection -------------------------------------------------------

describe("isSecretKey", () => {
  it("detects secret-bearing keys", () => {
    expect(isSecretKey("provider.apiKey")).toBe(true);
    expect(isSecretKey("auth.token")).toBe(true);
    expect(isSecretKey("db.password")).toBe(true);
    expect(isSecretKey("mcp.secret_key")).toBe(true);
  });

  it("passes non-secret keys", () => {
    expect(isSecretKey("model.name")).toBe(false);
    expect(isSecretKey("theme.mode")).toBe(false);
    expect(isSecretKey("editor.fontSize")).toBe(false);
  });
});

describe("redactValue", () => {
  it("redacts short values completely", () => {
    expect(redactValue("abc")).toBe("[REDACTED]");
  });

  it("shows first/last 2 chars for longer values", () => {
    const result = redactValue("sk-abcdef123456");
    expect(result).toContain("sk");
    expect(result).toContain("56");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdef123456");
  });
});

// --- provenance -------------------------------------------------------------

describe("provenance", () => {
  it("tracks the source layer for each setting", () => {
    const entries = resolveSettings([
      raw("model.name", "qwen3-max", "default"),
      raw("theme.mode", "dark", "user"),
      raw("editor.tabSize", "4", "project"),
    ]);

    expect(entries.find((e) => e.key === "model.name")?.sourceLayer).toBe("default");
    expect(entries.find((e) => e.key === "theme.mode")?.sourceLayer).toBe("user");
    expect(entries.find((e) => e.key === "editor.tabSize")?.sourceLayer).toBe("project");
  });
});

// --- multi-layer resolution -------------------------------------------------

describe("multi-layer resolution", () => {
  it("later layers override earlier ones", () => {
    const entries = resolveSettings([
      raw("model.name", "qwen3-max", "default"),
      raw("model.name", "gpt-4o", "user"),
      raw("model.name", "claude-sonnet", "flag"),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].displayValue).toBe("claude-sonnet");
    expect(entries[0].sourceLayer).toBe("flag");
  });

  it("respects layer priority order", () => {
    const entries = resolveSettings([
      raw("x", "flag", "flag"),
      raw("x", "default", "default"),
      raw("x", "env", "env"),
      raw("x", "user", "user"),
      raw("x", "project", "project"),
    ]);

    expect(entries[0].displayValue).toBe("flag");
  });
});

// --- redaction in resolved settings -----------------------------------------

describe("redaction", () => {
  it("redacts secret values in resolved output", () => {
    const entries = resolveSettings([
      raw("provider.apiKey", "sk-super-secret-key-12345", "user"),
    ]);

    expect(entries[0].isSecret).toBe(true);
    expect(entries[0].displayValue).toContain("[REDACTED]");
    expect(entries[0].displayValue).not.toContain("sk-super-secret-key-12345");
  });

  it("does not redact non-secret values", () => {
    const entries = resolveSettings([
      raw("model.name", "qwen3-max", "default"),
    ]);

    expect(entries[0].isSecret).toBe(false);
    expect(entries[0].displayValue).toBe("qwen3-max");
  });
});

// --- deprecated keys --------------------------------------------------------

describe("deprecated keys", () => {
  it("flags deprecated keys with guidance", () => {
    expect(isDeprecatedKey("model.provider")).toBe(true);
    expect(isDeprecatedKey("theme.dark")).toBe(true);
    expect(isDeprecatedKey("model.name")).toBe(false);
  });

  it("shows deprecated state in resolved settings", () => {
    const entries = resolveSettings([
      raw("model.provider", "dashscope", "user"),
    ]);

    expect(entries[0].validationState).toBe("deprecated");
    expect(entries[0].guidance).toContain("provider.name");
  });
});

// --- inspection view --------------------------------------------------------

describe("assembleSettingsView", () => {
  it("counts secrets and deprecated settings", () => {
    const view = assembleSettingsView([
      raw("model.name", "qwen3-max", "default"),
      raw("provider.apiKey", "sk-secret123456", "user"),
      raw("model.provider", "dashscope", "project"),
    ]);

    expect(view.totalSettings).toBe(3);
    expect(view.secretCount).toBe(1);
    expect(view.deprecatedCount).toBe(1);
    expect(view.hasWarnings).toBe(true);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatSettingsView", () => {
  it("renders settings with provenance, redaction, and warnings", () => {
    const view = assembleSettingsView([
      raw("model.name", "qwen3-max", "default"),
      raw("provider.apiKey", "sk-secret123456", "user"),
      raw("model.provider", "dashscope", "project"),
    ]);

    const output = formatSettingsView(view);
    expect(output).toContain("Effective Settings");
    expect(output).toContain("model.name = qwen3-max [default]");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("🔒");
    expect(output).toContain("⚠");
    expect(output).toContain("provider.name");
    expect(output).toContain("Read-only");
    expect(output).not.toContain("sk-secret123456");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("resolution does not mutate input", () => {
    const input = [
      raw("model.name", "qwen3-max", "default"),
      raw("provider.apiKey", "sk-test", "user"),
    ];
    const before = JSON.stringify(input);
    resolveSettings(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
