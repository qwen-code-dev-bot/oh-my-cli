import { describe, it, expect } from "vitest";
import {
  StepLinkTracker,
  formatStepLinks,
} from "../../src/step-links.js";

// Pure-function coverage for step links (Issue #438): link creation,
// bounding, and determinism.

// --- link creation ----------------------------------------------------------

describe("link creation", () => {
  it("links a turn to a step", () => {
    const tracker = new StepLinkTracker();
    const link = tracker.linkTurnToStep(1, 1, "turn-42", 1000);

    expect(link).not.toBeNull();
    expect(link!.type).toBe("turn");
    expect(link!.itemId).toBe("turn-42");
    expect(link!.linkedAt).toBe(1000);
    expect(tracker.totalLinks).toBe(1);
  });

  it("links a file to a step", () => {
    const tracker = new StepLinkTracker();
    const link = tracker.linkFileToStep(1, 2, "src/app.ts", 1000);

    expect(link!.type).toBe("file");
    expect(link!.itemId).toBe("src/app.ts");
  });

  it("links a tool result to a step", () => {
    const tracker = new StepLinkTracker();
    const link = tracker.linkToolResultToStep(1, 3, "tool-result-99", 1000);

    expect(link!.type).toBe("tool-result");
    expect(link!.itemId).toBe("tool-result-99");
  });

  it("redacts secrets in item IDs", () => {
    const tracker = new StepLinkTracker();
    const link = tracker.linkFileToStep(1, 1, "config/--token=supersecretvalue123", 1000);

    expect(link!.itemId).toContain("[REDACTED]");
    expect(link!.itemId).not.toContain("supersecretvalue123");
  });

  it("bounds item ID at 200 chars", () => {
    const tracker = new StepLinkTracker();
    const link = tracker.linkFileToStep(1, 1, "x".repeat(500), 1000);

    expect(link!.itemId.length).toBeLessThanOrEqual(200);
  });
});

// --- bounding ---------------------------------------------------------------

describe("bounding", () => {
  it("bounds at 50 links per step", () => {
    const tracker = new StepLinkTracker();
    for (let i = 0; i < 55; i++) {
      tracker.linkTurnToStep(1, 1, `turn-${i}`, i * 1000);
    }

    const links = tracker.getLinksForStep(1, 1);
    expect(links.length).toBe(50);
  });

  it("returns null when at capacity", () => {
    const tracker = new StepLinkTracker();
    for (let i = 0; i < 50; i++) {
      tracker.linkTurnToStep(1, 1, `turn-${i}`, i * 1000);
    }

    const result = tracker.linkTurnToStep(1, 1, "one-more", 99999);
    expect(result).toBeNull();
  });

  it("tracks links per step independently", () => {
    const tracker = new StepLinkTracker();
    tracker.linkTurnToStep(1, 1, "turn-1", 1000);
    tracker.linkTurnToStep(1, 2, "turn-2", 2000);
    tracker.linkFileToStep(1, 1, "file.ts", 3000);

    expect(tracker.getLinksForStep(1, 1)).toHaveLength(2);
    expect(tracker.getLinksForStep(1, 2)).toHaveLength(1);
    expect(tracker.size).toBe(2);
    expect(tracker.totalLinks).toBe(3);
  });
});

// --- querying ---------------------------------------------------------------

describe("getLinksForStep", () => {
  it("returns empty for unknown step", () => {
    const tracker = new StepLinkTracker();
    expect(tracker.getLinksForStep(99, 99)).toHaveLength(0);
  });

  it("returns copies, not references", () => {
    const tracker = new StepLinkTracker();
    tracker.linkTurnToStep(1, 1, "turn-1", 1000);

    const links = tracker.getLinksForStep(1, 1);
    links[0].itemId = "modified";

    expect(tracker.getLinksForStep(1, 1)[0].itemId).toBe("turn-1");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatStepLinks", () => {
  it("renders links with type icons", () => {
    const tracker = new StepLinkTracker();
    tracker.linkTurnToStep(1, 1, "turn-42", 1000);
    tracker.linkFileToStep(1, 1, "src/app.ts", 2000);
    tracker.linkToolResultToStep(1, 2, "tool-99", 3000);

    const output = formatStepLinks(tracker);
    expect(output).toContain("Step Links");
    expect(output).toContain("Steps with links: 2");
    expect(output).toContain("Total links: 3");
    expect(output).toContain("💬");
    expect(output).toContain("📄");
    expect(output).toContain("🔧");
    expect(output).toContain("Read-only");
  });

  it("is deterministic", () => {
    const tracker = new StepLinkTracker();
    tracker.linkTurnToStep(1, 1, "turn-1", 1000);

    const a = formatStepLinks(tracker);
    const b = formatStepLinks(tracker);
    expect(a).toBe(b);
  });
});
