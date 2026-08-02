import { describe, it, expect } from "vitest";
import {
  WorkspaceExplorer,
  verifySurfaceEquivalence,
  formatExplorerState,
  type TreeEntry,
  type SearchEntry,
  type SymbolEntry,
} from "../../src/workspace-explorer-tui.js";
import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
  type ContextReference,
} from "../../src/context-reference.js";

// Pure-function coverage for the TUI workspace explorer (Issue #335):
// panel switching, keyboard attachment, composer budget, surface
// equivalence, and formatting.

// --- panel switching --------------------------------------------------------

describe("panel switching", () => {
  it("switches panels and resets selection", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "src", type: "directory", depth: 0, expanded: true },
      { path: "src/app.ts", type: "file", depth: 1, expanded: false },
    ]);
    explorer.moveSelection(1);
    expect(explorer.getState().selectedIndex).toBe(1);

    explorer.setPanel("search");
    expect(explorer.getState().activePanel).toBe("search");
    expect(explorer.getState().selectedIndex).toBe(0);
  });
});

// --- keyboard attachment ----------------------------------------------------

describe("keyboard attachment", () => {
  it("attaches a tree file as a canonical reference", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "src/app.ts", type: "file", depth: 0, expanded: false },
    ]);

    const attached = explorer.attachSelected("keyboard");
    expect(attached).not.toBeNull();
    expect(attached!.ref.path).toBe("src/app.ts");
    expect(attached!.ref.provenance).toBe("picker");
    expect(attached!.method).toBe("keyboard");
  });

  it("does not attach directories", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "src", type: "directory", depth: 0, expanded: true },
    ]);

    expect(explorer.attachSelected()).toBeNull();
  });

  it("attaches a search result with line reference", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setPanel("search");
    explorer.setSearchResults([
      { path: "src/util.ts", line: 42, preview: "export function helper()" },
    ]);

    const attached = explorer.attachSelected("search");
    expect(attached).not.toBeNull();
    expect(attached!.ref.path).toBe("src/util.ts");
    expect(attached!.ref.lines).toEqual({ start: 42, end: 42 });
    expect(attached!.ref.provenance).toBe("search");
  });

  it("attaches a symbol result with symbol name", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setPanel("symbols");
    explorer.setSymbolResults([
      { name: "authenticate", kind: "function", filePath: "src/auth.ts", line: 10 },
    ]);

    const attached = explorer.attachSelected("symbol");
    expect(attached).not.toBeNull();
    expect(attached!.ref.symbol).toBe("authenticate");
    expect(attached!.ref.path).toBe("src/auth.ts");
  });
});

// --- composer budget --------------------------------------------------------

describe("composer budget", () => {
  it("tracks estimated tokens and budget", () => {
    const explorer = new WorkspaceExplorer(100);
    explorer.setTreeEntries([
      { path: "src/app.ts", type: "file", depth: 0, expanded: false },
    ]);

    explorer.attachSelected();
    const composer = explorer.getComposer();
    expect(composer.attached).toHaveLength(1);
    expect(composer.estimatedTokens).toBeGreaterThan(0);
    expect(composer.budget).toBe(100);
  });

  it("flags over-budget state", () => {
    const explorer = new WorkspaceExplorer(1); // Very small budget.
    explorer.setTreeEntries([
      { path: "src/app.ts", type: "file", depth: 0, expanded: false },
    ]);

    explorer.attachSelected();
    expect(explorer.getComposer().overBudget).toBe(true);
  });

  it("removes attached references and recalculates", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "a.ts", type: "file", depth: 0, expanded: false },
      { path: "b.ts", type: "file", depth: 0, expanded: false },
    ]);

    explorer.attachSelected();
    explorer.moveSelection(1);
    explorer.attachSelected();
    expect(explorer.getComposer().attached).toHaveLength(2);

    explorer.removeAttached(0);
    expect(explorer.getComposer().attached).toHaveLength(1);
    expect(explorer.getComposer().attached[0].ref.path).toBe("b.ts");
  });
});

// --- surface equivalence ----------------------------------------------------

describe("surface equivalence", () => {
  it("verifies TUI and Desktop references are equivalent", () => {
    const tuiRef: ContextReference = {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: "src/app.ts",
      lines: { start: 10, end: 20 },
      symbol: "main",
      provenance: "search",
    };

    const desktopRef: ContextReference = {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: "src/app.ts",
      lines: { start: 10, end: 20 },
      symbol: "main",
      provenance: "search",
    };

    expect(verifySurfaceEquivalence(tuiRef, desktopRef)).toBe(true);
  });

  it("detects non-equivalent references", () => {
    const tuiRef: ContextReference = {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: "src/app.ts",
      provenance: "search",
    };

    const desktopRef: ContextReference = {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: "src/other.ts",
      provenance: "search",
    };

    expect(verifySurfaceEquivalence(tuiRef, desktopRef)).toBe(false);
  });

  it("TUI-produced references match Desktop format", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setPanel("symbols");
    explorer.setSymbolResults([
      { name: "handler", kind: "function", filePath: "src/routes.ts", line: 15 },
    ]);

    const attached = explorer.attachSelected("symbol");
    const desktopEquivalent: ContextReference = {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: "src/routes.ts",
      lines: { start: 15, end: 15 },
      symbol: "handler",
      provenance: "search",
    };

    expect(verifySurfaceEquivalence(attached!.ref, desktopEquivalent)).toBe(true);
  });
});

// --- selection navigation ---------------------------------------------------

describe("selection navigation", () => {
  it("moves selection within bounds", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "a.ts", type: "file", depth: 0, expanded: false },
      { path: "b.ts", type: "file", depth: 0, expanded: false },
    ]);

    explorer.moveSelection(1);
    expect(explorer.getState().selectedIndex).toBe(1);

    explorer.moveSelection(1); // Beyond max.
    expect(explorer.getState().selectedIndex).toBe(1);

    explorer.moveSelection(-1);
    expect(explorer.getState().selectedIndex).toBe(0);

    explorer.moveSelection(-1); // Below min.
    expect(explorer.getState().selectedIndex).toBe(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatExplorerState", () => {
  it("renders tree panel with composer", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "src", type: "directory", depth: 0, expanded: true },
      { path: "src/app.ts", type: "file", depth: 1, expanded: false },
    ]);
    explorer.moveSelection(1);
    explorer.attachSelected();

    const output = formatExplorerState(explorer.getState());
    expect(output).toContain("Explorer [tree]");
    expect(output).toContain("src/app.ts");
    expect(output).toContain("Composer: 1 refs");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("getState returns a snapshot that does not affect the explorer", () => {
    const explorer = new WorkspaceExplorer();
    explorer.setTreeEntries([
      { path: "a.ts", type: "file", depth: 0, expanded: false },
    ]);

    const snapshot = explorer.getState();
    snapshot.composer.attached.push({
      ref: { schema: CONTEXT_REFERENCE_SCHEMA, v: CONTEXT_REFERENCE_VERSION, path: "injected.ts", provenance: "manual" },
      attachedAt: Date.now(),
      method: "keyboard",
    });

    // The explorer's internal state should not be affected.
    expect(explorer.getComposer().attached).toHaveLength(0);
  });
});
