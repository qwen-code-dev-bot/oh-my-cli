import { describe, it, expect } from "vitest";
import { parseMaxTurns, parseWallTimeMs, parseMaxToolCalls } from "../../src/run-limits.js";

describe("run limits: parseMaxTurns (Issue #515)", () => {
  it("returns null when unset or blank (no cap)", () => {
    expect(parseMaxTurns(undefined)).toBeNull();
    expect(parseMaxTurns(null)).toBeNull();
    expect(parseMaxTurns("")).toBeNull();
    expect(parseMaxTurns("   ")).toBeNull();
  });

  it("parses a positive integer with surrounding whitespace", () => {
    expect(parseMaxTurns("30")).toBe(30);
    expect(parseMaxTurns(" 1 ")).toBe(1);
    expect(parseMaxTurns("500")).toBe(500);
  });

  it("throws an actionable error on invalid values", () => {
    expect(() => parseMaxTurns("0")).toThrow(/Invalid max turns/);
    expect(() => parseMaxTurns("-2")).toThrow(/positive integer/);
    expect(() => parseMaxTurns("1.5")).toThrow(/positive integer/);
    expect(() => parseMaxTurns("abc")).toThrow(/Invalid max turns "abc"/);
  });
});

describe("run limits: parseMaxToolCalls (Issue #517)", () => {
  it("returns null when unset or blank (no cap)", () => {
    expect(parseMaxToolCalls(undefined)).toBeNull();
    expect(parseMaxToolCalls(null)).toBeNull();
    expect(parseMaxToolCalls("")).toBeNull();
    expect(parseMaxToolCalls("   ")).toBeNull();
  });

  it("parses a positive integer with surrounding whitespace", () => {
    expect(parseMaxToolCalls("50")).toBe(50);
    expect(parseMaxToolCalls(" 1 ")).toBe(1);
    expect(parseMaxToolCalls("1000")).toBe(1000);
  });

  it("throws an actionable error on invalid values", () => {
    expect(() => parseMaxToolCalls("0")).toThrow(/Invalid max tool calls/);
    expect(() => parseMaxToolCalls("-3")).toThrow(/positive integer/);
    expect(() => parseMaxToolCalls("2.5")).toThrow(/positive integer/);
    expect(() => parseMaxToolCalls("many")).toThrow(/Invalid max tool calls "many"/);
  });
});

describe("run limits: parseWallTimeMs (Issue #515)", () => {
  it("returns null when unset or blank (no cap)", () => {
    expect(parseWallTimeMs(undefined)).toBeNull();
    expect(parseWallTimeMs(null)).toBeNull();
    expect(parseWallTimeMs("")).toBeNull();
    expect(parseWallTimeMs("  ")).toBeNull();
  });

  it("accepts bare seconds and s/m/h suffixes", () => {
    expect(parseWallTimeMs("90")).toBe(90_000);
    expect(parseWallTimeMs("30s")).toBe(30_000);
    expect(parseWallTimeMs("5m")).toBe(300_000);
    expect(parseWallTimeMs("1h")).toBe(3_600_000);
    expect(parseWallTimeMs("1.5h")).toBe(5_400_000);
    expect(parseWallTimeMs("0.5m")).toBe(30_000);
    expect(parseWallTimeMs(" 2m ")).toBe(120_000);
  });

  it("throws an actionable error on unparseable or non-positive durations", () => {
    expect(() => parseWallTimeMs("0")).toThrow(/Invalid wall-time budget/);
    expect(() => parseWallTimeMs("soon")).toThrow(/expected a duration like 90, 30s, 5m, 1h, or 1\.5h/);
    expect(() => parseWallTimeMs("5x")).toThrow(/Invalid wall-time budget/);
    expect(() => parseWallTimeMs("-30s")).toThrow(/Invalid wall-time budget/);
    expect(() => parseWallTimeMs("m")).toThrow(/Invalid wall-time budget/);
  });
});
