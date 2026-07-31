import { describe, it, expect } from "vitest";
import {
  CONCEPT_CONTRACT_SCHEMA,
  CONCEPT_CONTRACT_VERSION,
  CONCEPT_CONTRACT,
  SURFACES,
  collectConceptCapabilities,
  countSurfaceGaps,
  conceptById,
  formatConceptCapabilities,
  formatConceptCapabilitiesCompact,
} from "../../src/concept-contract.js";
import type { ConceptId, ConceptCapabilityReport } from "../../src/concept-contract.js";

// The canonical concept set, in canonical order. Pinning the exact ids and order
// is the drift guard: a surface (or an edit here) that drops, renames, or
// reorders a shared concept fails this test.
const CANONICAL_IDS: readonly ConceptId[] = [
  "conversation",
  "tool-activity",
  "files",
  "diffs",
  "terminals",
  "approvals",
  "goal",
  "workflow",
  "delivery-state",
];

function concept(report: ConceptCapabilityReport, id: ConceptId) {
  const found = report.concepts.find((c) => c.id === id);
  if (!found) throw new Error(`missing concept ${id}`);
  return found;
}

describe("concept contract constants", () => {
  it("exposes a stable schema id and version", () => {
    expect(CONCEPT_CONTRACT_SCHEMA).toBe("oh-my-cli.concept-contract");
    expect(CONCEPT_CONTRACT_VERSION).toBe(1);
  });

  it("governs exactly the tui and desktop surfaces, in order", () => {
    expect(SURFACES).toEqual(["tui", "desktop"]);
  });
});

describe("concept contract: canonical definitions (drift guard)", () => {
  it("defines exactly the canonical concept set, in canonical order", () => {
    expect(CONCEPT_CONTRACT.map((c) => c.id)).toEqual(CANONICAL_IDS);
  });

  it("pins each concept's canonical name, statuses, and failure semantic", () => {
    // A surface that renames, re-statuses, or re-maps a concept changes one of
    // these facts and fails this test.
    expect(conceptById("conversation")).toMatchObject({
      name: "Conversation",
      statuses: ["active", "idle", "completed", "failed"],
    });
    expect(conceptById("approvals")).toMatchObject({
      name: "Approvals",
      statuses: ["pending", "approved", "denied", "expired"],
      shortcut: "y/n",
    });
    expect(conceptById("approvals").failureSemantic).toContain("Fail closed");
    expect(conceptById("delivery-state").failureSemantic).toContain("never force or reset");
    expect(conceptById("goal").statuses).toEqual([
      "set",
      "active",
      "paused",
      "achieved",
      "incomplete",
    ]);
  });

  it("gives every concept a non-empty name, statuses, and failure semantic", () => {
    for (const definition of CONCEPT_CONTRACT) {
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.statuses.length).toBeGreaterThan(0);
      expect(definition.failureSemantic.length).toBeGreaterThan(0);
    }
  });

  it("throws on an unknown concept id rather than rendering a divergent concept", () => {
    expect(() => conceptById("not-a-concept" as ConceptId)).toThrow(/not a shared concept/);
  });
});

describe("collectConceptCapabilities: report shape", () => {
  it("always reports every concept and every surface, in canonical order", () => {
    const report = collectConceptCapabilities();
    expect(report.schema).toBe(CONCEPT_CONTRACT_SCHEMA);
    expect(report.version).toBe(CONCEPT_CONTRACT_VERSION);
    expect(report.surfaces).toEqual(["tui", "desktop"]);
    expect(report.concepts.map((c) => c.id)).toEqual(CANONICAL_IDS);
    for (const row of report.concepts) {
      expect(row.surfaces.map((s) => s.surface)).toEqual(["tui", "desktop"]);
    }
  });

  it("carries the canonical definition into each row", () => {
    const report = collectConceptCapabilities();
    expect(concept(report, "workflow").statuses).toEqual([
      "proposed",
      "running",
      "awaiting-gate",
      "completed",
      "failed",
    ]);
    expect(concept(report, "approvals").shortcut).toBe("y/n");
    expect(concept(report, "conversation").shortcut).toBeNull();
  });

  it("is pure: repeated collection yields an equal but independent report", () => {
    const a = collectConceptCapabilities();
    const b = collectConceptCapabilities();
    expect(b).toEqual(a);
    b.concepts[0].statuses.push("mutated");
    expect(a.concepts[0].statuses).not.toContain("mutated");
  });
});

describe("collectConceptCapabilities: capability matrix", () => {
  it("marks the reference TUI surface as supporting every concept with no gap", () => {
    const report = collectConceptCapabilities();
    for (const row of report.concepts) {
      const tui = row.surfaces.find((s) => s.surface === "tui")!;
      expect(tui.supported).toBe(true);
      expect(tui.gap).toBeNull();
    }
    expect(countSurfaceGaps(report, "tui")).toBe(0);
  });

  it("marks Desktop as not yet rendering the shared concepts, each with an actionable gap", () => {
    const report = collectConceptCapabilities();
    for (const row of report.concepts) {
      const desktop = row.surfaces.find((s) => s.surface === "desktop")!;
      expect(desktop.supported).toBe(false);
      expect(desktop.gap).toBeTruthy();
      expect(desktop.gap).toContain("#302");
    }
    expect(countSurfaceGaps(report, "desktop")).toBe(CANONICAL_IDS.length);
  });

  it("calls out the secure session shell gate for terminals specifically", () => {
    const report = collectConceptCapabilities();
    const desktop = concept(report, "terminals").surfaces.find((s) => s.surface === "desktop")!;
    expect(desktop.gap).toContain("#106");
  });
});

describe("formatConceptCapabilities", () => {
  it("renders the matrix with names, statuses, and explicit gaps", () => {
    const out = formatConceptCapabilities(collectConceptCapabilities());
    expect(out).toContain(CONCEPT_CONTRACT_SCHEMA);
    expect(out).toContain("Conversation");
    expect(out).toContain("Delivery state");
    expect(out).toContain("statuses: active · idle · completed · failed");
    expect(out).toContain("shortcut: y/n");
    expect(out).toContain("TUI:     supported");
    expect(out).toContain("Desktop: gap —");
    expect(out).toContain("Parity: TUI: 0 gap(s) · Desktop: 9 gap(s)");
  });
});

describe("formatConceptCapabilitiesCompact", () => {
  it("renders a compact per-concept view with a parity summary", () => {
    const out = formatConceptCapabilitiesCompact(collectConceptCapabilities());
    expect(out).toContain(`Concepts (${CANONICAL_IDS.length})`);
    expect(out).toContain("Conversation: T✓ D✗");
    expect(out).toContain("Parity: TUI 0 gap(s) · Desktop 9 gap(s)");
  });
});
