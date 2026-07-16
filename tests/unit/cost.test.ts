import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  lookupModelPrice,
  formatCostUsd,
  parseBudgetUsd,
  MODEL_PRICES,
  UNKNOWN_MODEL_PRICE,
} from "../../src/cost.js";

describe("lookupModelPrice", () => {
  it("matches a bundled model exactly", () => {
    const { price, known } = lookupModelPrice("gpt-4o");
    expect(known).toBe(true);
    expect(price).toEqual(MODEL_PRICES["gpt-4o"]);
  });

  it("matches a dated variant by longest known prefix", () => {
    const dated = lookupModelPrice("gpt-4o-2024-08-06");
    expect(dated.known).toBe(true);
    expect(dated.price).toEqual(MODEL_PRICES["gpt-4o"]);

    const miniDated = lookupModelPrice("gpt-4.1-mini-2024-12-01");
    expect(miniDated.known).toBe(true);
    expect(miniDated.price).toEqual(MODEL_PRICES["gpt-4.1-mini"]);
  });

  it("falls back to the conservative unknown-model price for an unlisted model", () => {
    const { price, known } = lookupModelPrice("fake-model");
    expect(known).toBe(false);
    expect(price).toEqual(UNKNOWN_MODEL_PRICE);
  });

  it("treats an empty model name as unknown", () => {
    expect(lookupModelPrice("").known).toBe(false);
    expect(lookupModelPrice("   ").known).toBe(false);
  });
});

describe("estimateCostUsd", () => {
  it("estimates cost from per-million prompt and completion rates", () => {
    const est = estimateCostUsd("gpt-4o", { prompt: 1_000_000, completion: 1_000_000 });
    expect(est.known).toBe(true);
    expect(est.usd).toBeCloseTo(12.5, 6); // 2.5 prompt + 10 completion
  });

  it("scales linearly with token counts", () => {
    const one = estimateCostUsd("gpt-4o-mini", { prompt: 1_000_000, completion: 0 });
    expect(one.usd).toBeCloseTo(0.15, 6);
    const two = estimateCostUsd("gpt-4o-mini", { prompt: 2_000_000, completion: 0 });
    expect(two.usd).toBeCloseTo(0.3, 6);
  });

  it("uses the fallback rate (known=false) for an unknown model", () => {
    const est = estimateCostUsd("fake-model", { prompt: 1_000_000, completion: 1_000_000 });
    expect(est.known).toBe(false);
    expect(est.usd).toBeCloseTo(18, 6); // 3 prompt + 15 completion
  });

  it("clamps negative or non-finite token counts to zero", () => {
    const est = estimateCostUsd("gpt-4o", { prompt: -5, completion: Number.NaN });
    expect(est.usd).toBe(0);
  });
});

describe("formatCostUsd", () => {
  it("renders a stable sub-cent figure", () => {
    expect(formatCostUsd(0.00009)).toBe("$0.000090");
    expect(formatCostUsd(1.5)).toBe("$1.500000");
  });

  it("renders non-finite or negative values as zero", () => {
    expect(formatCostUsd(Number.NaN)).toBe("$0.000000");
    expect(formatCostUsd(-1)).toBe("$0.000000");
  });
});

describe("parseBudgetUsd", () => {
  it("returns null when unset or blank", () => {
    expect(parseBudgetUsd(undefined)).toBeNull();
    expect(parseBudgetUsd(null)).toBeNull();
    expect(parseBudgetUsd("")).toBeNull();
    expect(parseBudgetUsd("   ")).toBeNull();
  });

  it("parses a positive number", () => {
    expect(parseBudgetUsd("1.5")).toBe(1.5);
    expect(parseBudgetUsd("  0.0001  ")).toBeCloseTo(0.0001, 9);
  });

  it("throws on a non-positive or non-numeric value", () => {
    expect(() => parseBudgetUsd("0")).toThrow(/Invalid spend budget/);
    expect(() => parseBudgetUsd("-1")).toThrow(/Invalid spend budget/);
    expect(() => parseBudgetUsd("abc")).toThrow(/Invalid spend budget/);
    expect(() => parseBudgetUsd("Infinity")).toThrow(/Invalid spend budget/);
  });
});
