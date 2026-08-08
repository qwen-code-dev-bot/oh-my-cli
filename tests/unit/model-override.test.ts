import { describe, it, expect } from "vitest";
import { resolveModelOverride } from "../../src/settings.js";

describe("per-run model override decision (Issue #791)", () => {
  it("returns undefined when the flag is absent (config untouched)", () => {
    expect(resolveModelOverride(undefined)).toBeUndefined();
  });

  it("returns the model id verbatim when present", () => {
    expect(resolveModelOverride("gpt-x")).toBe("gpt-x");
    expect(resolveModelOverride("local/endpoint-model")).toBe("local/endpoint-model");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveModelOverride("  gpt-x  ")).toBe("gpt-x");
  });

  it("throws on empty or whitespace-only values so the boundary fails closed", () => {
    expect(() => resolveModelOverride("")).toThrow(/non-empty model name/);
    expect(() => resolveModelOverride("   ")).toThrow(/non-empty model name/);
    expect(() => resolveModelOverride("\t\n")).toThrow(/non-empty model name/);
  });
});
