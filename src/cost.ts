// Estimated provider cost for a run. The CLI calls LLM providers on the user's
// behalf, but the provider's own billing is authoritative. This module produces a
// transparent, offline ESTIMATE from a small bundled price table so users can see
// and cap spend. Unknown models fall back to a documented conservative rate and
// are flagged (known=false) so an estimate is never mistaken for exact billing.

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface ModelPrice {
  // USD per 1,000,000 tokens.
  promptPerM: number;
  completionPerM: number;
}

// Bundled, approximate list prices for a few common models. Kept intentionally
// small and clearly labeled as an estimate — this is NOT authoritative billing.
// Extend as needed; unknown models fall back to UNKNOWN_MODEL_PRICE.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-4o": { promptPerM: 2.5, completionPerM: 10 },
  "gpt-4o-mini": { promptPerM: 0.15, completionPerM: 0.6 },
  "gpt-4.1": { promptPerM: 2, completionPerM: 8 },
  "gpt-4.1-mini": { promptPerM: 0.4, completionPerM: 1.6 },
};

// Conservative fallback used when the model is not in the table, so cost is
// always estimable (and a spend budget therefore always enforceable). Estimates
// that use it are flagged via known=false.
export const UNKNOWN_MODEL_PRICE: ModelPrice = { promptPerM: 3, completionPerM: 15 };

export interface CostEstimate {
  usd: number;
  // True when the model matched the bundled table (exact or prefix); false when
  // the conservative UNKNOWN_MODEL_PRICE fallback was used.
  known: boolean;
  model: string;
}

// Resolve a price for a model name. Exact match first, then the longest known
// model name that is a prefix (so dated variants like "gpt-4o-2024-08-06" map to
// "gpt-4o"). Returns the fallback price with known=false when nothing matches.
export function lookupModelPrice(model: string): { price: ModelPrice; known: boolean } {
  const name = (model ?? "").trim();
  if (name && Object.prototype.hasOwnProperty.call(MODEL_PRICES, name)) {
    return { price: MODEL_PRICES[name], known: true };
  }
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (name.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
  }
  if (best) return { price: MODEL_PRICES[best], known: true };
  return { price: UNKNOWN_MODEL_PRICE, known: false };
}

function toNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Estimate the USD cost of a token usage tally for a given model. The result is
// an estimate, never authoritative billing; `known` reports whether the model
// price was found in the bundled table.
export function estimateCostUsd(model: string, tokens: TokenUsage): CostEstimate {
  const { price, known } = lookupModelPrice(model);
  const prompt = toNonNegative(tokens.prompt);
  const completion = toNonNegative(tokens.completion);
  const usd = (prompt / 1_000_000) * price.promptPerM + (completion / 1_000_000) * price.completionPerM;
  return { usd, known, model: model ?? "" };
}

// Render a USD estimate for display with sub-cent precision. Deterministic so it
// is stable in the run summary and headless stream.
export function formatCostUsd(usd: number): string {
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return `$${v.toFixed(6)}`;
}

// Parse a spend budget (USD) from a flag or env value. Returns null when unset
// (no budget). Throws on an invalid value so the CLI can report an actionable
// error rather than silently disabling enforcement.
export function parseBudgetUsd(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid spend budget "${value}": expected a positive number of USD (e.g. 1.5)`,
    );
  }
  return n;
}
