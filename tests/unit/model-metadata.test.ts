import { describe, it, expect } from "vitest";
import {
  formatModelInfo,
  formatModelComparison,
  type ModelMetadata,
} from "../../src/model-metadata.js";

// Pure-function coverage for model metadata display (Issue #408):
// metadata display, capability indicators, cost formatting, context
// window formatting, comparison, and determinism.

function model(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    schema: "oh-my-cli.model-metadata",
    v: 1,
    modelId: "qwen3-max",
    displayName: "Qwen3 Max",
    provider: "DashScope",
    contextWindow: 128_000,
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      structuredOutput: true,
      reasoning: false,
    },
    cost: { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    isActive: true,
    ...overrides,
  };
}

// --- metadata display -------------------------------------------------------

describe("formatModelInfo", () => {
  it("displays all metadata fields", () => {
    const output = formatModelInfo(model());

    expect(output).toContain("Qwen3 Max");
    expect(output).toContain("(active)");
    expect(output).toContain("qwen3-max");
    expect(output).toContain("DashScope");
    expect(output).toContain("128K tokens");
    expect(output).toContain("$2.00/$8.00");
  });

  it("shows capability indicators", () => {
    const output = formatModelInfo(model());

    expect(output).toContain("Tools:            ✓");
    expect(output).toContain("Vision:           ✓");
    expect(output).toContain("Streaming:        ✓");
    expect(output).toContain("Structured output: ✓");
    expect(output).toContain("Reasoning:        ✗");
  });

  it("shows inactive model without active marker", () => {
    const output = formatModelInfo(model({ isActive: false }));
    expect(output).not.toContain("(active)");
  });

  it("is deterministic", () => {
    const a = formatModelInfo(model());
    const b = formatModelInfo(model());
    expect(a).toBe(b);
  });
});

// --- context window formatting ---------------------------------------------

describe("context window formatting", () => {
  it("formats millions", () => {
    const output = formatModelInfo(model({ contextWindow: 1_000_000 }));
    expect(output).toContain("1.0M tokens");
  });

  it("formats thousands", () => {
    const output = formatModelInfo(model({ contextWindow: 128_000 }));
    expect(output).toContain("128K tokens");
  });

  it("formats small values", () => {
    const output = formatModelInfo(model({ contextWindow: 500 }));
    expect(output).toContain("500 tokens");
  });
});

// --- cost formatting --------------------------------------------------------

describe("cost formatting", () => {
  it("formats cost with two decimal places", () => {
    const output = formatModelInfo(model({
      cost: { inputPerMillion: 1.5, outputPerMillion: 6.0 },
    }));
    expect(output).toContain("$1.50/$6.00");
  });
});

// --- model comparison -------------------------------------------------------

describe("formatModelComparison", () => {
  it("renders multiple models", () => {
    const models = [
      model(),
      model({
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        provider: "OpenAI",
        contextWindow: 200_000,
        isActive: false,
        cost: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
      }),
    ];

    const output = formatModelComparison(models);
    expect(output).toContain("Model Comparison");
    expect(output).toContain("Qwen3 Max ●");
    expect(output).toContain("GPT-4o");
    expect(output).toContain("DashScope");
    expect(output).toContain("OpenAI");
    expect(output).toContain("tools");
    expect(output).toContain("vision");
  });

  it("marks active model", () => {
    const models = [
      model({ isActive: true }),
      model({ modelId: "other", displayName: "Other", isActive: false }),
    ];

    const output = formatModelComparison(models);
    expect(output).toContain("Qwen3 Max ●");
    expect(output).not.toContain("Other ●");
  });
});

// --- capability indicators --------------------------------------------------

describe("capability indicators", () => {
  it("shows all absent for minimal model", () => {
    const output = formatModelInfo(model({
      capabilities: {
        tools: false,
        vision: false,
        streaming: false,
        structuredOutput: false,
        reasoning: false,
      },
    }));

    expect(output).toContain("Tools:            ✗");
    expect(output).toContain("Vision:           ✗");
    expect(output).toContain("Reasoning:        ✗");
  });

  it("shows all present for full model", () => {
    const output = formatModelInfo(model({
      capabilities: {
        tools: true,
        vision: true,
        streaming: true,
        structuredOutput: true,
        reasoning: true,
      },
    }));

    expect(output).toContain("Reasoning:        ✓");
  });
});
