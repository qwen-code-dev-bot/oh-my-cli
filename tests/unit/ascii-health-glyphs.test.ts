import { describe, it, expect } from "vitest";
import { asciiSafeLine } from "../../src/ascii-output.js";
import { formatHealthInventory, type HealthInventory } from "../../src/health-inventory.js";

describe("ASCII glyph map health marks (Issue #696)", () => {
  it("maps the warning mark to [warn]", () => {
    expect(asciiSafeLine("  \u26a0 bad-url (http) — misconfigured")).toBe(
      "  [warn] bad-url (http) - misconfigured",
    );
  });

  it("maps the disabled mark to [off]", () => {
    expect(asciiSafeLine("  \u2298 off-one — disabled")).toBe("  [off] off-one - disabled");
  });

  it("keeps the positive/negative marks unchanged", () => {
    expect(asciiSafeLine("  \u2713 solid — healthy")).toBe("  [ok] solid - healthy");
    expect(asciiSafeLine("  \u2717 gone — unavailable")).toBe("  [bad] gone - unavailable");
  });

  it("maps a line mixing all health marks", () => {
    const line = "\u2713 \u2717 \u26a0 \u2298 \u2500";
    expect(asciiSafeLine(line)).toBe("[ok] [bad] [warn] [off] -");
  });

  it("leaves plain ASCII untouched", () => {
    expect(asciiSafeLine("plain ascii line 123")).toBe("plain ascii line 123");
  });
});

describe("formatHealthInventory lines refactor (Issue #696)", () => {
  function inventory(): HealthInventory {
    return {
      settingsPath: "/srv/app/settings.json",
      settingsFound: true,
      probeTimeoutMs: 3000,
      integrations: [
        { kind: "mcp", name: "solid", target: "stdio: node", enabled: true, category: "healthy", reason: "command resolved", probeMs: 1 },
        { kind: "mcp", name: "bad-url", target: "http", enabled: true, category: "misconfigured", reason: "invalid url", probeMs: null },
        { kind: "extension", name: "off", target: "~/ext", enabled: false, category: "disabled", reason: "disabled", probeMs: null },
      ],
    };
  }

  it("returns lines whose join matches the pre-refactor text shape", () => {
    const lines = formatHealthInventory(inventory());
    expect(Array.isArray(lines)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("Health Inventory");
    expect(joined).toContain("\u2500".repeat(40));
    expect(joined).toContain("MCP servers:");
    expect(joined).toContain("Extensions:");
    expect(joined).toContain("\u2713");
    expect(joined).toContain("\u26a0");
    expect(joined).toContain("\u2298");
    expect(joined).toMatch(/Summary: 1 healthy, 0 unavailable, 1 disabled, 1 misconfigured \(3 total\)/);
    // The joined text ends without a trailing newline; the CLI adds it.
    expect(joined.endsWith("\n")).toBe(false);
  });

  it("returns the short-circuit branches as lines too", () => {
    const missing = formatHealthInventory({ ...inventory(), settingsFound: false, integrations: [] });
    expect(missing.join("\n")).toContain("No settings file found");
    const parsed = formatHealthInventory({ ...inventory(), parseError: "invalid JSON", integrations: [] });
    expect(parsed.join("\n")).toContain("Settings error: invalid JSON");
  });
});
