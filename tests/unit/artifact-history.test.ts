import { describe, it, expect } from "vitest";
import {
  ArtifactHistory,
  assembleArtifactHistoryView,
  formatArtifactHistoryView,
} from "../../src/artifact-history.js";

// Pure-function coverage for artifact history (Issue #358): identity,
// attribution, absent-evidence, ordering, bounding, and read-only guarantee.

// --- identity and recording -------------------------------------------------

describe("recording", () => {
  it("records an artifact with full metadata", () => {
    const history = new ArtifactHistory();
    const entry = history.record({
      id: "a1",
      kind: "html",
      label: "Preview: report.html",
      contentHash: "abc123def456",
      sessionId: "s1",
      turnId: "turn-10",
      filePaths: ["report.html"],
      producedAt: 1000,
      sizeBytes: 2048,
    });

    expect(entry.id).toBe("a1");
    expect(entry.kind).toBe("html");
    expect(entry.turnId).toBe("turn-10");
    expect(entry.attributionState).toBe("attributed");
    expect(history.size).toBe(1);
  });

  it("records artifact without turn as no-attribution", () => {
    const history = new ArtifactHistory();
    const entry = history.record({
      id: "a1",
      kind: "image",
      label: "Screenshot",
      contentHash: "xyz789",
      sessionId: "s1",
      producedAt: 1000,
      sizeBytes: 5000,
    });

    expect(entry.attributionState).toBe("no-attribution");
    expect(entry.turnId).toBeUndefined();
    expect(entry.filePaths).toEqual([]);
  });

  it("attributes by file paths when no turn", () => {
    const history = new ArtifactHistory();
    const entry = history.record({
      id: "a1",
      kind: "export",
      label: "Export",
      contentHash: "hash",
      sessionId: "s1",
      filePaths: ["output.csv"],
      producedAt: 1000,
      sizeBytes: 100,
    });

    expect(entry.attributionState).toBe("attributed");
  });
});

// --- ordering ---------------------------------------------------------------

describe("ordering", () => {
  it("lists artifacts newest first", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "First", contentHash: "h1", sessionId: "s1", producedAt: 1000, sizeBytes: 10 });
    history.record({ id: "a2", kind: "html", label: "Second", contentHash: "h2", sessionId: "s1", producedAt: 2000, sizeBytes: 10 });
    history.record({ id: "a3", kind: "html", label: "Third", contentHash: "h3", sessionId: "s1", producedAt: 3000, sizeBytes: 10 });

    const list = history.list();
    expect(list[0].id).toBe("a3");
    expect(list[1].id).toBe("a2");
    expect(list[2].id).toBe("a1");
  });
});

// --- bounding ---------------------------------------------------------------

describe("bounding", () => {
  it("bounds history to the configured limit", () => {
    const history = new ArtifactHistory(3);
    for (let i = 0; i < 5; i++) {
      history.record({ id: `a${i}`, kind: "html", label: `Artifact ${i}`, contentHash: `h${i}`, sessionId: "s1", producedAt: i * 1000, sizeBytes: 10 });
    }

    expect(history.size).toBe(3);
    // Oldest removed.
    const list = history.list();
    expect(list.map((e) => e.id)).toEqual(["a4", "a3", "a2"]);
  });
});

// --- queries ----------------------------------------------------------------

describe("queries", () => {
  it("filters by session", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "S1", contentHash: "h1", sessionId: "s1", producedAt: 1000, sizeBytes: 10 });
    history.record({ id: "a2", kind: "html", label: "S2", contentHash: "h2", sessionId: "s2", producedAt: 2000, sizeBytes: 10 });

    expect(history.getBySession("s1")).toHaveLength(1);
    expect(history.getBySession("s2")).toHaveLength(1);
  });

  it("filters by turn", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "T1", contentHash: "h1", sessionId: "s1", turnId: "turn-1", producedAt: 1000, sizeBytes: 10 });
    history.record({ id: "a2", kind: "html", label: "T2", contentHash: "h2", sessionId: "s1", turnId: "turn-2", producedAt: 2000, sizeBytes: 10 });

    expect(history.getByTurn("turn-1")).toHaveLength(1);
    expect(history.getByTurn("turn-99")).toHaveLength(0);
  });

  it("finds unattributed artifacts", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "Attr", contentHash: "h1", sessionId: "s1", turnId: "turn-1", producedAt: 1000, sizeBytes: 10 });
    history.record({ id: "a2", kind: "image", label: "NoAttr", contentHash: "h2", sessionId: "s1", producedAt: 2000, sizeBytes: 10 });

    expect(history.getUnattributed()).toHaveLength(1);
    expect(history.getUnattributed()[0].id).toBe("a2");
  });
});

// --- multi-artifact fixture -------------------------------------------------

describe("multi-artifact fixture", () => {
  it("tracks artifacts from different turns and sessions", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "Preview", contentHash: "h1", sessionId: "s1", turnId: "turn-10", filePaths: ["report.html"], producedAt: 1000, sizeBytes: 2048 });
    history.record({ id: "a2", kind: "screenshot", label: "Screenshot", contentHash: "h2", sessionId: "s1", turnId: "turn-15", producedAt: 2000, sizeBytes: 50000 });
    history.record({ id: "a3", kind: "export", label: "CSV Export", contentHash: "h3", sessionId: "s2", producedAt: 3000, sizeBytes: 500 });

    const view = assembleArtifactHistoryView(history);
    expect(view.totalCount).toBe(3);
    expect(view.attributedCount).toBe(2);
    expect(view.unattributedCount).toBe(1);
    expect(view.kindCounts.html).toBe(1);
    expect(view.kindCounts.screenshot).toBe(1);
    expect(view.kindCounts.export).toBe(1);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatArtifactHistoryView", () => {
  it("renders artifacts with attribution and kinds", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "Report", contentHash: "abcdef123456", sessionId: "s1", turnId: "turn-10", filePaths: ["report.html"], producedAt: 1000, sizeBytes: 2048 });
    history.record({ id: "a2", kind: "image", label: "Screenshot", contentHash: "xyz789012345", sessionId: "s1", producedAt: 2000, sizeBytes: 50000 });

    const view = assembleArtifactHistoryView(history);
    const output = formatArtifactHistoryView(view);

    expect(output).toContain("Artifact History");
    expect(output).toContain("Report");
    expect(output).toContain("turn:turn-10");
    expect(output).toContain("report.html");
    expect(output).toContain("Screenshot");
    expect(output).toContain("(no attribution)");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("view assembly does not mutate history", () => {
    const history = new ArtifactHistory();
    history.record({ id: "a1", kind: "html", label: "Test", contentHash: "h1", sessionId: "s1", producedAt: 1000, sizeBytes: 10 });

    const before = history.size;
    assembleArtifactHistoryView(history);
    expect(history.size).toBe(before);
  });
});
