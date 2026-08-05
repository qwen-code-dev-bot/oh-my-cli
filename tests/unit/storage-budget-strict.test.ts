import { describe, it, expect } from "vitest";
import { storageBudgetStrictExit, parseStorageBudget } from "../../src/session-storage.js";

describe("storageBudgetStrictExit (Issue #692)", () => {
  it("maps an over-budget footprint to exit 1", () => {
    expect(storageBudgetStrictExit(1000, 999)).toBe(1);
  });

  it("maps an exactly-at-budget footprint to exit 0", () => {
    expect(storageBudgetStrictExit(1000, 1000)).toBe(0);
  });

  it("maps an under-budget footprint to exit 0", () => {
    expect(storageBudgetStrictExit(100, 10000)).toBe(0);
  });

  it("maps an empty store to exit 0 for any non-negative budget", () => {
    expect(storageBudgetStrictExit(0, 0)).toBe(0);
    expect(storageBudgetStrictExit(0, 1)).toBe(0);
  });

  it("is a pure, stable mapping", () => {
    expect(storageBudgetStrictExit(500, 100)).toBe(storageBudgetStrictExit(500, 100));
    expect(storageBudgetStrictExit(50, 100)).toBe(storageBudgetStrictExit(50, 100));
  });
});

describe("parseStorageBudget (Issue #692)", () => {
  it("accepts non-negative integers, including zero", () => {
    expect(parseStorageBudget("0")).toBe(0);
    expect(parseStorageBudget("117")).toBe(117);
    expect(parseStorageBudget("  42  ")).toBe(42);
  });

  it("rejects fractions, negatives, and garbage", () => {
    expect(() => parseStorageBudget("10.5")).toThrow(/invalid --storage-budget value/);
    expect(() => parseStorageBudget("-1")).toThrow(/invalid --storage-budget value/);
    expect(() => parseStorageBudget("abc")).toThrow(/invalid --storage-budget value/);
  });
});
