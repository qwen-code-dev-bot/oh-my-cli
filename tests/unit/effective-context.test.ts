import { describe, it, expect } from "vitest";
import {
  buildEffectiveContextView,
  formatEffectiveContextView,
  type EffectiveContextInput,
} from "../../src/effective-context.js";

// Pure-function coverage for effective context view (Issue #440): view
// generation, aggregation, and determinism.

function makeInput(overrides: Partial<EffectiveContextInput> = {}): EffectiveContextInput {
  return {
    objective: "Build the REST API",
    revision: 2,
    attempt: 1,
    loadedFiles: ["src/app.ts", "src/auth.ts", "tests/app.test.ts"],
    activeConstraints: ["Use OAuth2 flow", "Target Node 20+"],
    stepLinkCounts: [
      { step: 1, linkCount: 3 },
      { step: 2, linkCount: 1 },
    ],
    estimatedTokens: 4500,
    budgetLimit: 8000,
    hasSurvivalBlock: true,
    ...overrides,
  };
}

// --- view generation --------------------------------------------------------

describe("buildEffectiveContextView", () => {
  it("builds view from input", () => {
    const view = buildEffectiveContextView(makeInput(), 5000);

    expect(view.objective).toBe("Build the REST API");
    expect(view.revision).toBe(2);
    expect(view.attempt).toBe(1);
    expect(view.loadedFiles).toHaveLength(3);
    expect(view.activeConstraints).toHaveLength(2);
    expect(view.stepLinkCounts).toHaveLength(2);
    expect(view.estimatedTokens).toBe(4500);
    expect(view.budgetLimit).toBe(8000);
    expect(view.budgetPct).toBe(56); // 4500/8000 = 56%
    expect(view.hasSurvivalBlock).toBe(true);
    expect(view.generatedAt).toBe(5000);
  });

  it("bounds loaded files at 20", () => {
    const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
    const view = buildEffectiveContextView(makeInput({ loadedFiles: files }));

    expect(view.loadedFiles).toHaveLength(20);
  });

  it("bounds constraints at 10", () => {
    const constraints = Array.from({ length: 15 }, (_, i) => `Constraint ${i}`);
    const view = buildEffectiveContextView(makeInput({ activeConstraints: constraints }));

    expect(view.activeConstraints).toHaveLength(10);
  });

  it("handles zero budget", () => {
    const view = buildEffectiveContextView(makeInput({ budgetLimit: 0 }));
    expect(view.budgetPct).toBe(0);
  });

  it("handles empty files and constraints", () => {
    const view = buildEffectiveContextView(makeInput({
      loadedFiles: [],
      activeConstraints: [],
      stepLinkCounts: [],
    }));

    expect(view.loadedFiles).toHaveLength(0);
    expect(view.activeConstraints).toHaveLength(0);
    expect(view.stepLinkCounts).toHaveLength(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatEffectiveContextView", () => {
  it("renders complete view", () => {
    const view = buildEffectiveContextView(makeInput(), 5000);
    const output = formatEffectiveContextView(view);

    expect(output).toContain("Effective Context");
    expect(output).toContain("Build the REST API");
    expect(output).toContain("Revision: 2  Attempt: 1");
    expect(output).toContain("4500/8000 tokens (56%)");
    expect(output).toContain("Survival block: available");
    expect(output).toContain("📄 src/app.ts");
    expect(output).toContain("· Use OAuth2 flow");
    expect(output).toContain("Step 1: 3 links");
    expect(output).toContain("Read-only");
  });

  it("renders view without survival block", () => {
    const view = buildEffectiveContextView(makeInput({ hasSurvivalBlock: false }));
    const output = formatEffectiveContextView(view);
    expect(output).toContain("Survival block: none");
  });

  it("is deterministic", () => {
    const view = buildEffectiveContextView(makeInput(), 5000);
    const a = formatEffectiveContextView(view);
    const b = formatEffectiveContextView(view);
    expect(a).toBe(b);
  });
});
