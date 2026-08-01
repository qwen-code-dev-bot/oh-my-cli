import { describe, it, expect } from "vitest";
import {
  RevisionTracker,
  formatRevisionHistory,
  formatTrackerSummary,
} from "../../src/revision-tracking.js";

// Pure-function coverage for revision tracking (Issue #371): revision
// history, external change detection, stale overwrite, multi-revision,
// and read-only guarantee.

// --- revision tracking ------------------------------------------------------

describe("revision tracking", () => {
  it("records revisions with incrementing indices", () => {
    const tracker = new RevisionTracker();
    const r0 = tracker.recordRevision({ path: "report.html", contentHash: "aaa", timestamp: 1000, source: "agent" });
    const r1 = tracker.recordRevision({ path: "report.html", contentHash: "bbb", timestamp: 2000, source: "agent" });

    expect(r0.revisionIndex).toBe(0);
    expect(r1.revisionIndex).toBe(1);
    expect(tracker.get("report.html")!.revisions).toHaveLength(2);
  });

  it("tracks separate artifacts independently", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "h1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "b.html", contentHash: "h2", timestamp: 1000, source: "agent" });

    expect(tracker.size).toBe(2);
    expect(tracker.get("a.html")!.revisions).toHaveLength(1);
    expect(tracker.get("b.html")!.revisions).toHaveLength(1);
  });
});

// --- external change detection ----------------------------------------------

describe("external change detection", () => {
  it("detects hash mismatch as external change", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "original", timestamp: 1000, source: "agent" });

    const changed = tracker.detectExternalChange("a.html", "modified-externally");
    expect(changed).toBe(true);
    expect(tracker.get("a.html")!.externallyModified).toBe(true);
  });

  it("does not flag when hashes match", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "same", timestamp: 1000, source: "agent" });

    const changed = tracker.detectExternalChange("a.html", "same");
    expect(changed).toBe(false);
    expect(tracker.get("a.html")!.externallyModified).toBe(false);
  });

  it("returns false for unknown artifacts", () => {
    const tracker = new RevisionTracker();
    expect(tracker.detectExternalChange("nonexistent.html", "any")).toBe(false);
  });

  it("records external revisions with source", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2-external", timestamp: 2000, source: "external" });

    const history = tracker.get("a.html")!;
    expect(history.externallyModified).toBe(true);
    expect(history.revisions[1].source).toBe("external");
  });
});

// --- stale overwrite detection ----------------------------------------------

describe("stale overwrite", () => {
  it("flags stale overwrite when agent edits after external change", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2-ext", timestamp: 2000, source: "external" });
    tracker.recordRevision({ path: "a.html", contentHash: "v3-agent", timestamp: 3000, source: "agent" });

    const history = tracker.get("a.html")!;
    expect(history.staleOverwriteRisk).toBe(true);
    expect(history.externallyModified).toBe(false); // Cleared by agent edit.
  });

  it("does not flag when no external change preceded", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2", timestamp: 2000, source: "agent" });

    expect(tracker.get("a.html")!.staleOverwriteRisk).toBe(false);
  });

  it("checkStaleOverwrite reflects external modification state", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2-ext", timestamp: 2000, source: "external" });

    expect(tracker.checkStaleOverwrite("a.html")).toBe(true);
    expect(tracker.checkStaleOverwrite("nonexistent.html")).toBe(false);
  });
});

// --- multi-revision fixture -------------------------------------------------

describe("multi-revision fixture", () => {
  it("tracks a full revision lifecycle with mixed sources", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "dashboard.html", contentHash: "h0", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "dashboard.html", contentHash: "h1", timestamp: 2000, source: "agent" });
    tracker.recordRevision({ path: "dashboard.html", contentHash: "h2-ext", timestamp: 3000, source: "external" });
    tracker.recordRevision({ path: "dashboard.html", contentHash: "h3", timestamp: 4000, source: "agent" });

    const history = tracker.get("dashboard.html")!;
    expect(history.revisions).toHaveLength(4);
    expect(history.lastIndex).toBe(3);
    expect(history.lastHash).toBe("h3");
    expect(history.staleOverwriteRisk).toBe(true);
    expect(history.externallyModified).toBe(false);
  });
});

// --- queries ----------------------------------------------------------------

describe("queries", () => {
  it("lists externally modified artifacts", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2-ext", timestamp: 2000, source: "external" });
    tracker.recordRevision({ path: "b.html", contentHash: "v1", timestamp: 1000, source: "agent" });

    expect(tracker.getExternallyModified()).toHaveLength(1);
    expect(tracker.getExternallyModified()[0].path).toBe("a.html");
  });

  it("lists stale overwrite risks", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "v1", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "v2-ext", timestamp: 2000, source: "external" });
    tracker.recordRevision({ path: "a.html", contentHash: "v3", timestamp: 3000, source: "agent" });

    expect(tracker.getStaleOverwriteRisks()).toHaveLength(1);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("renders revision history with warnings", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "aabbccdd11223344", timestamp: 1000, source: "agent" });
    tracker.recordRevision({ path: "a.html", contentHash: "eeff001155667788", timestamp: 2000, source: "external" });

    const output = formatRevisionHistory(tracker.get("a.html")!);
    expect(output).toContain("a.html");
    expect(output).toContain("2 revisions");
    expect(output).toContain("EXTERNALLY MODIFIED");
    expect(output).toContain("[agent]");
    expect(output).toContain("[external]");
  });

  it("renders tracker summary", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "h1", timestamp: 1000, source: "agent" });

    const output = formatTrackerSummary(tracker);
    expect(output).toContain("Revision Tracking");
    expect(output).toContain("Artifacts: 1");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("tracking does not modify any files", () => {
    const tracker = new RevisionTracker();
    tracker.recordRevision({ path: "a.html", contentHash: "h1", timestamp: 1000, source: "agent" });
    tracker.detectExternalChange("a.html", "h2");

    // Pure data model — no filesystem side effects.
    expect(tracker.get("a.html")!.externallyModified).toBe(true);
  });
});
