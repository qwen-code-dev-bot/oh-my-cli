import { describe, it, expect } from "vitest";
import {
  DependencyGraph,
  formatImpactEntry,
} from "../../src/change-impact.js";

// Pure-function coverage for change-impact analysis (Issue #385):
// direct dependents, transitive dependents, test association, confidence,
// bounded depth, no-impact, and read-only guarantee.

function buildGraph(): DependencyGraph {
  const graph = new DependencyGraph();
  // app.ts → main.ts → index.ts (chain)
  graph.addEdge("app.ts", "main.ts");      // app depends on main
  graph.addEdge("main.ts", "index.ts");    // main depends on index
  graph.addEdge("util.ts", "index.ts");    // util depends on index
  graph.addEdge("render.ts", "app.ts");    // render depends on app

  // Test associations.
  graph.associateTest("index.ts", "tests/index.test.ts");
  graph.associateTest("app.ts", "tests/app.test.ts");
  graph.associateTest("main.ts", "tests/main.test.ts");

  return graph;
}

// --- direct dependents ------------------------------------------------------

describe("direct dependents", () => {
  it("identifies direct dependents", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");

    expect(impact.directDependents).toHaveLength(2); // main.ts, util.ts
    expect(impact.directDependents.map((d) => d.path).sort()).toEqual(["main.ts", "util.ts"]);
    expect(impact.directDependents[0].depth).toBe(1);
    expect(impact.directDependents[0].confidence).toBe("high");
    expect(impact.directDependents[0].evidence).toBe("import-graph");
  });

  it("returns empty for files with no dependents", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("render.ts");

    expect(impact.directDependents).toHaveLength(0);
    expect(impact.totalAffected).toBe(0);
  });
});

// --- transitive dependents --------------------------------------------------

describe("transitive dependents", () => {
  it("identifies transitive dependents at depth 2+", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");

    // Depth 1: main.ts, util.ts
    // Depth 2: app.ts (depends on main.ts)
    // Depth 3: render.ts (depends on app.ts)
    expect(impact.transitiveDependents.length).toBeGreaterThanOrEqual(1);
    const paths = impact.transitiveDependents.map((d) => d.path);
    expect(paths).toContain("app.ts");
  });

  it("respects max depth", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts", { maxDepth: 1 });

    expect(impact.transitiveDependents).toHaveLength(0);
    expect(impact.directDependents).toHaveLength(2);
  });

  it("respects max dependents", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts", { maxDependents: 1 });

    expect(impact.totalAffected).toBeLessThanOrEqual(1);
  });
});

// --- test association -------------------------------------------------------

describe("test association", () => {
  it("associates test files with changed file and dependents", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");

    expect(impact.testFiles).toContain("tests/index.test.ts");
    expect(impact.testFiles).toContain("tests/main.test.ts"); // main.ts is a dependent
  });

  it("returns empty tests for unassociated files", () => {
    const graph = new DependencyGraph();
    graph.addEdge("b.ts", "a.ts");
    const impact = graph.analyzeImpact("a.ts");

    expect(impact.testFiles).toHaveLength(0);
  });
});

// --- confidence levels ------------------------------------------------------

describe("confidence levels", () => {
  it("reports high confidence for direct-only impact", () => {
    const graph = new DependencyGraph();
    graph.addEdge("b.ts", "a.ts");
    const impact = graph.analyzeImpact("a.ts");

    expect(impact.overallConfidence).toBe("high");
  });

  it("reports medium confidence when transitive dependents exist", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");

    expect(impact.overallConfidence).toBe("medium");
  });

  it("assigns decreasing confidence by depth", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");

    for (const dep of impact.directDependents) {
      expect(dep.confidence).toBe("high");
    }
    for (const dep of impact.transitiveDependents) {
      expect(["medium", "low"]).toContain(dep.confidence);
    }
  });
});

// --- no-impact fixture ------------------------------------------------------

describe("no-impact fixture", () => {
  it("reports zero impact for isolated files", () => {
    const graph = new DependencyGraph();
    const impact = graph.analyzeImpact("isolated.ts");

    expect(impact.totalAffected).toBe(0);
    expect(impact.directDependents).toHaveLength(0);
    expect(impact.transitiveDependents).toHaveLength(0);
    expect(impact.testFiles).toHaveLength(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatImpactEntry", () => {
  it("renders impact with dependents and tests", () => {
    const graph = buildGraph();
    const impact = graph.analyzeImpact("index.ts");
    const output = formatImpactEntry(impact);

    expect(output).toContain("Change impact: index.ts");
    expect(output).toContain("Direct dependents:");
    expect(output).toContain("main.ts");
    expect(output).toContain("Associated tests:");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("analysis does not modify the graph", () => {
    const graph = buildGraph();
    const before = graph.getDirectDependents("index.ts").length;

    graph.analyzeImpact("index.ts");
    expect(graph.getDirectDependents("index.ts").length).toBe(before);
  });
});
