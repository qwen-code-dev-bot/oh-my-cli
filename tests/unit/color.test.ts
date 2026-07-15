import { describe, it, expect } from "vitest";
import { colorEnabled, createColorPalette } from "../../src/color.js";

describe("colorEnabled", () => {
  it("is true by default (no flag, no NO_COLOR)", () => {
    expect(colorEnabled({ env: {} })).toBe(true);
  });

  it("is false when the --no-color flag is set", () => {
    expect(colorEnabled({ noColor: true, env: {} })).toBe(false);
  });

  it("is false when NO_COLOR is a non-empty value (regardless of value)", () => {
    expect(colorEnabled({ env: { NO_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ env: { NO_COLOR: "true" } })).toBe(false);
    // Per no-color.org, any non-empty value suppresses — even "0".
    expect(colorEnabled({ env: { NO_COLOR: "0" } })).toBe(false);
  });

  it("stays true when NO_COLOR is an empty string", () => {
    expect(colorEnabled({ env: { NO_COLOR: "" } })).toBe(true);
  });

  it("the flag suppresses color even when NO_COLOR is empty", () => {
    expect(colorEnabled({ noColor: true, env: { NO_COLOR: "" } })).toBe(false);
  });
});

describe("createColorPalette", () => {
  it("returns real ANSI SGR codes when enabled", () => {
    const p = createColorPalette(true);
    expect(p.bold).toContain("\x1b[");
    expect(p.dim).toContain("\x1b[");
    expect(p.reset).toContain("\x1b[");
  });

  it("returns empty strings when disabled", () => {
    const p = createColorPalette(false);
    expect(p.bold).toBe("");
    expect(p.dim).toBe("");
    expect(p.reset).toBe("");
  });
});
