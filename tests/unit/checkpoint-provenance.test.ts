import { describe, it, expect } from "vitest";
import {
  assembleProvenanceView,
  attributeHunk,
  formatProvenanceView,
  formatAttribution,
  type CheckpointEntry,
  type FileChange,
} from "../../src/checkpoint-provenance.js";

// Pure-function coverage for checkpoint provenance (Issue #354): identity,
// turn attribution, absent-evidence reporting, multi-checkpoint fixtures,
// formatting, and read-only guarantee.

function fileChange(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, hunkCount: 1, additions: 5, deletions: 2, ...overrides };
}

function checkpoint(id: string, overrides: Partial<CheckpointEntry> = {}): CheckpointEntry {
  const files = overrides.files ?? [fileChange("src/app.ts")];
  return {
    id,
    turnId: `turn-${id}`,
    createdAt: 1000,
    label: `Checkpoint ${id}`,
    files,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    ...overrides,
  };
}

// --- checkpoint identity ----------------------------------------------------

describe("checkpoint identity", () => {
  it("exposes stable identity and metadata", () => {
    const cp = checkpoint("cp-1", { turnId: "turn-42", label: "After refactor" });
    expect(cp.id).toBe("cp-1");
    expect(cp.turnId).toBe("turn-42");
    expect(cp.label).toBe("After refactor");
    expect(cp.createdAt).toBe(1000);
  });

  it("computes totals from files", () => {
    const cp = checkpoint("cp-1", {
      files: [
        fileChange("a.ts", { additions: 10, deletions: 3 }),
        fileChange("b.ts", { additions: 5, deletions: 1 }),
      ],
    });
    expect(cp.totalAdditions).toBe(15);
    expect(cp.totalDeletions).toBe(4);
  });
});

// --- hunk-to-turn attribution -----------------------------------------------

describe("hunk attribution", () => {
  it("attributes a hunk to its producing turn when evidence exists", () => {
    const cp = checkpoint("cp-1", { turnId: "turn-42" });
    const attr = attributeHunk(cp, "src/app.ts", 0);

    expect(attr.provenanceState).toBe("attributed");
    expect(attr.turnId).toBe("turn-42");
    expect(attr.checkpointId).toBe("cp-1");
  });

  it("reports no-provenance when checkpoint has no turn", () => {
    const cp = checkpoint("cp-1", { turnId: undefined });
    const attr = attributeHunk(cp, "src/app.ts", 0);

    expect(attr.provenanceState).toBe("no-provenance");
    expect(attr.turnId).toBeUndefined();
  });

  it("reports no-provenance for a file not in the checkpoint", () => {
    const cp = checkpoint("cp-1", { turnId: "turn-42" });
    const attr = attributeHunk(cp, "other/file.ts", 0);

    expect(attr.provenanceState).toBe("no-provenance");
  });
});

// --- provenance view --------------------------------------------------------

describe("assembleProvenanceView", () => {
  it("counts attributed and no-provenance checkpoints", () => {
    const view = assembleProvenanceView([
      checkpoint("cp-1", { turnId: "turn-1" }),
      checkpoint("cp-2", { turnId: undefined }),
      checkpoint("cp-3", { turnId: "turn-3" }),
    ]);

    expect(view.totalCount).toBe(3);
    expect(view.attributedCount).toBe(2);
    expect(view.noProvenanceCount).toBe(1);
  });

  it("handles empty checkpoints", () => {
    const view = assembleProvenanceView([]);
    expect(view.totalCount).toBe(0);
    expect(view.attributedCount).toBe(0);
  });
});

// --- multi-checkpoint fixture -----------------------------------------------

describe("multi-checkpoint fixture", () => {
  it("tracks multiple checkpoints with different provenance", () => {
    const cps = [
      checkpoint("cp-1", {
        turnId: "turn-10",
        label: "Initial implementation",
        files: [fileChange("src/main.ts", { hunkCount: 3, additions: 50, deletions: 0 })],
      }),
      checkpoint("cp-2", {
        turnId: undefined,
        label: "Manual edit (no turn)",
        files: [fileChange("src/util.ts", { hunkCount: 1, additions: 5, deletions: 2 })],
      }),
      checkpoint("cp-3", {
        turnId: "turn-25",
        label: "Bug fix",
        files: [
          fileChange("src/main.ts", { hunkCount: 1, additions: 2, deletions: 1 }),
          fileChange("tests/main.test.ts", { hunkCount: 2, additions: 10, deletions: 0 }),
        ],
      }),
    ];

    const view = assembleProvenanceView(cps);
    expect(view.totalCount).toBe(3);
    expect(view.attributedCount).toBe(2);
    expect(view.noProvenanceCount).toBe(1);

    // Verify attribution for each.
    const attr1 = attributeHunk(cps[0], "src/main.ts", 0);
    expect(attr1.provenanceState).toBe("attributed");
    expect(attr1.turnId).toBe("turn-10");

    const attr2 = attributeHunk(cps[1], "src/util.ts", 0);
    expect(attr2.provenanceState).toBe("no-provenance");

    const attr3 = attributeHunk(cps[2], "tests/main.test.ts", 1);
    expect(attr3.provenanceState).toBe("attributed");
    expect(attr3.turnId).toBe("turn-25");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatProvenanceView", () => {
  it("renders checkpoints with provenance and file summaries", () => {
    const view = assembleProvenanceView([
      checkpoint("cp-1", { turnId: "turn-10", label: "Refactor" }),
      checkpoint("cp-2", { turnId: undefined, label: "Manual" }),
    ]);

    const output = formatProvenanceView(view);
    expect(output).toContain("Checkpoint Provenance");
    expect(output).toContain("Refactor");
    expect(output).toContain("turn:turn-10");
    expect(output).toContain("Manual");
    expect(output).toContain("(no provenance)");
    expect(output).toContain("Read-only");
  });
});

describe("formatAttribution", () => {
  it("formats attributed hunk", () => {
    const cp = checkpoint("cp-1", { turnId: "turn-42" });
    const attr = attributeHunk(cp, "src/app.ts", 2);
    const output = formatAttribution(attr);
    expect(output).toContain("turn:turn-42");
    expect(output).toContain("hunk#2");
  });

  it("formats no-provenance hunk", () => {
    const cp = checkpoint("cp-1", { turnId: undefined });
    const attr = attributeHunk(cp, "src/app.ts", 0);
    const output = formatAttribution(attr);
    expect(output).toContain("(no provenance)");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("assembly does not mutate input checkpoints", () => {
    const cps = [checkpoint("cp-1"), checkpoint("cp-2", { turnId: undefined })];
    const before = JSON.stringify(cps);
    assembleProvenanceView(cps);
    expect(JSON.stringify(cps)).toBe(before);
  });
});
