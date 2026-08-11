import { describe, it, expect } from "vitest";
import {
  EVENT_PRESENTATION_SCHEMA,
  EVENT_PRESENTATION_VERSION,
  EVENT_KINDS,
  EVENT_STATUSES,
  EVENT_STATUS_RUNTIME_MAPPING,
  DETAIL_BOUND,
  presentEvent,
  neutralizeEscapes,
  isEventKind,
  isEventStatus,
  collectActivityModel,
  formatActivityModel,
} from "../../src/event-presentation.js";
import type { EventKind, EventStatus } from "../../src/event-presentation.js";

describe("event presentation constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(EVENT_PRESENTATION_SCHEMA).toBe("oh-my-cli.event-presentation");
    expect(EVENT_PRESENTATION_VERSION).toBe(1);
  });

  it("pins the exact canonical event kinds, in order", () => {
    expect(EVENT_KINDS).toEqual([
      "assistant-text",
      "tool-call",
      "subagent",
      "approval",
      "warning",
      "diff",
      "result",
    ]);
  });

  it("pins the exact canonical statuses, in order", () => {
    expect(EVENT_STATUSES).toEqual([
      "pending",
      "active",
      "completed",
      "failed",
      "waiting",
      "cancelled",
    ]);
  });
});

describe("no presentation-only status", () => {
  it("maps every canonical status to a real, non-empty runtime condition", () => {
    for (const status of EVENT_STATUSES) {
      const meaning = EVENT_STATUS_RUNTIME_MAPPING[status];
      expect(typeof meaning).toBe("string");
      expect(meaning.length).toBeGreaterThan(0);
    }
    // The mapping covers exactly the canonical statuses, nothing extra.
    expect(Object.keys(EVENT_STATUS_RUNTIME_MAPPING).sort()).toEqual(
      [...EVENT_STATUSES].sort(),
    );
  });
});

describe("type guards", () => {
  it("accept canonical kinds/statuses and reject others", () => {
    expect(isEventKind("tool-call")).toBe(true);
    expect(isEventKind("nope")).toBe(false);
    expect(isEventStatus("failed")).toBe(true);
    expect(isEventStatus("nope")).toBe(false);
  });
});

describe("presentEvent: mapping", () => {
  it("maps a runtime event to its presentation", () => {
    const presented = presentEvent({
      kind: "tool-call",
      status: "active",
      summary: "running rg",
      detail: "rg pattern",
      elapsedMs: 120,
      live: true,
    });
    expect(presented).toMatchObject({
      kind: "tool-call",
      status: "active",
      summary: "running rg",
      detail: "rg pattern",
      detailTruncated: false,
      elapsedMs: 120,
      live: true,
    });
  });

  it("defaults optional fields safely", () => {
    const presented = presentEvent({ kind: "result", status: "completed" });
    expect(presented.summary).toBe("");
    expect(presented.detail).toBe("");
    expect(presented.elapsedMs).toBe(0);
    expect(presented.live).toBe(false);
  });

  it("floors invalid elapsedMs and ignores a non-true live flag", () => {
    const presented = presentEvent({
      kind: "warning",
      status: "waiting",
      elapsedMs: -5,
      live: false,
    });
    expect(presented.elapsedMs).toBe(0);
    expect(presented.live).toBe(false);
  });

  it("throws on an unknown kind or status (no presentation-only value)", () => {
    expect(() =>
      presentEvent({ kind: "made-up" as EventKind, status: "active" }),
    ).toThrow(/not a canonical event kind/);
    expect(() =>
      presentEvent({ kind: "tool-call", status: "spinning" as EventStatus }),
    ).toThrow(/not a canonical event status/);
  });
});

describe("presentEvent: redaction", () => {
  it("redacts known tokens and env/flag secrets from summary and detail", () => {
    const presented = presentEvent({
      kind: "tool-call",
      status: "failed",
      summary: "auth failed for sk-abcdefghijklmnopqrst",
      detail: "API_KEY=hunter2secret --token=topsecretvalue",
    });
    expect(presented.summary).not.toContain("sk-abcdefghijklmnopqrst");
    expect(presented.summary).toContain("[REDACTED]");
    expect(presented.detail).not.toContain("hunter2secret");
    expect(presented.detail).not.toContain("topsecretvalue");
    expect(presented.detail).toContain("[REDACTED]");
  });
});

describe("presentEvent: escape neutralization", () => {
  it("strips ANSI sequences and control characters but keeps newlines/tabs", () => {
    const presented = presentEvent({
      kind: "assistant-text",
      status: "active",
      detail: "before\x1b[31mRED\x1b[0mafter\u0007bell\ttab\nline",
    });
    // ANSI CSI sequences and the bell control char are stripped; the visible
    // text between them is preserved, as are tab and newline.
    expect(presented.detail).not.toContain("\x1b");
    expect(presented.detail).not.toContain("\u0007");
    expect(presented.detail).toBe("beforeREDafterbell\ttab\nline");
  });

  it("neutralizes via neutralizeEscapes directly", () => {
    expect(neutralizeEscapes("\x1b[1mbold\x1b[0m")).toBe("bold");
    expect(neutralizeEscapes("a\u202eb")).toBe("ab");
    expect(neutralizeEscapes("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });
});

describe("presentEvent: detail bounding", () => {
  it("bounds oversized detail and reports the truncation", () => {
    const big = "x".repeat(DETAIL_BOUND + 100);
    const presented = presentEvent({ kind: "diff", status: "completed", detail: big });
    expect(presented.detailTruncated).toBe(true);
    expect(presented.detail.length).toBe(DETAIL_BOUND + 1); // bound + ellipsis
    expect(presented.detail.endsWith("…")).toBe(true);
  });

  it("does not truncate detail within the bound", () => {
    const presented = presentEvent({ kind: "diff", status: "completed", detail: "small" });
    expect(presented.detailTruncated).toBe(false);
    expect(presented.detail).toBe("small");
  });

  it("does not split an emoji/astral char at the detail bound (Issue #826)", () => {
    // Position the emoji so it straddles DETAIL_BOUND.
    const detail = "x".repeat(DETAIL_BOUND - 1) + "🚀" + "more detail";
    const presented = presentEvent({ kind: "diff", status: "completed", detail });
    expect(presented.detailTruncated).toBe(true);
    expect(presented.detail.endsWith("…")).toBe(true);
    const withoutEllipsis = presented.detail.slice(0, -1);
    expect(withoutEllipsis).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe("collectActivityModel / formatActivityModel", () => {
  it("collects the canonical model descriptor", () => {
    const model = collectActivityModel();
    expect(model.schema).toBe(EVENT_PRESENTATION_SCHEMA);
    expect(model.version).toBe(EVENT_PRESENTATION_VERSION);
    expect(model.kinds).toEqual([...EVENT_KINDS]);
    expect(model.statuses).toEqual([...EVENT_STATUSES]);
    expect(model.runtimeMapping.failed).toContain("errored");
    expect(model.detailBound).toBe(DETAIL_BOUND);
  });

  it("renders the model with kinds and the status->runtime mapping", () => {
    const out = formatActivityModel(collectActivityModel());
    expect(out).toContain(EVENT_PRESENTATION_SCHEMA);
    expect(out).toContain("tool-call");
    expect(out).toContain("result");
    expect(out).toContain("failed: event errored");
    expect(out).toContain(`Detail bound: ${DETAIL_BOUND} chars`);
  });
});
