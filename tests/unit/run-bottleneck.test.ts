import { describe, it, expect } from "vitest";
import {
  createBottleneckCollector,
  formatBottleneckReport,
  BOTTLENECK_REPORT_SCHEMA,
  BOTTLENECK_REPORT_VERSION,
} from "../../src/run-bottleneck.js";

describe("createBottleneckCollector / build", () => {
  it("builds a deterministic report ranked by wall-time (desc)", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("write", 100);
    collector.recordTool("shell", 5000);
    collector.recordTool("read", 50);
    const report = build(6000);

    expect(report.schema).toBe(BOTTLENECK_REPORT_SCHEMA);
    expect(report.v).toBe(BOTTLENECK_REPORT_VERSION);
    expect(report.elapsedMs).toBe(6000);
    expect(report.truncated).toBe(0);
    expect(report.entries.map((e) => e.name)).toEqual(["shell", "write", "read"]);
    expect(report.entries[0]).toEqual({ kind: "tool", name: "shell", wallMs: 5000, calls: 1 });
  });

  it("records tool execution and approval gate wall-time as distinct kinds", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("shell", 200);
    collector.recordApproval("shell", 3000);
    const report = build(3200);

    const approval = report.entries.find((e) => e.kind === "approval");
    const tool = report.entries.find((e) => e.kind === "tool");
    expect(approval).toEqual({ kind: "approval", name: "shell", wallMs: 3000, calls: 1 });
    expect(tool).toEqual({ kind: "tool", name: "shell", wallMs: 200, calls: 1 });
    // The approval gate dominated, so it ranks first.
    expect(report.entries[0].kind).toBe("approval");
  });

  it("sums wall-time and call counts across repeated calls to the same tool", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("read", 10);
    collector.recordTool("read", 20);
    collector.recordTool("read", 30);
    const report = build(100);
    expect(report.entries).toEqual([{ kind: "tool", name: "read", wallMs: 60, calls: 3 }]);
  });

  it("breaks ties by call count, then name, then kind for stable output", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("beta", 100); // beta: 100ms, 1 call
    collector.recordTool("alpha", 50); // alpha: 50ms, 1 call
    collector.recordTool("alpha", 50); // alpha: 100ms total, 2 calls
    const report = build(200);
    // Equal wall-time (100ms each); alpha has more calls, so it ranks first.
    expect(report.entries[0].wallMs).toBe(100);
    expect(report.entries[1].wallMs).toBe(100);
    expect(report.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("bounds the ranked head and reports how many entries were truncated", () => {
    const { collector, build } = createBottleneckCollector();
    for (let i = 0; i < 20; i++) {
      collector.recordTool(`tool${String(i).padStart(2, "0")}`, (i + 1) * 10);
    }
    const report = build(10000);
    expect(report.entries).toHaveLength(16);
    expect(report.truncated).toBe(4);
    // The highest wall-time tool ranks first.
    expect(report.entries[0].name).toBe("tool19");
  });

  it("treats non-finite or negative wall-time as zero but still counts the call", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("write", Number.NaN);
    collector.recordTool("write", -5);
    const report = build(100);
    expect(report.entries).toEqual([{ kind: "tool", name: "write", wallMs: 0, calls: 2 }]);
  });

  it("sanitizes control characters out of a tool name", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("bad\u0000name\u001f", 100);
    const report = build(100);
    expect(report.entries[0].name).toBe("bad_name_");
    expect(report.entries[0].name).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("clamps a negative elapsed time to zero", () => {
    const { build } = createBottleneckCollector();
    expect(build(-50).elapsedMs).toBe(0);
  });

  it("reports an empty inventory when nothing was recorded", () => {
    const { build } = createBottleneckCollector();
    const report = build(1000);
    expect(report.entries).toEqual([]);
    expect(report.truncated).toBe(0);
    expect(report.elapsedMs).toBe(1000);
  });
});

describe("formatBottleneckReport", () => {
  it("renders a ranked, human-readable report", () => {
    const { collector, build } = createBottleneckCollector();
    collector.recordTool("shell", 8200);
    collector.recordTool("shell", 100);
    collector.recordApproval("write", 500);
    const text = formatBottleneckReport(build(9000));
    expect(text).toContain(`Bottleneck report (${BOTTLENECK_REPORT_SCHEMA} v${BOTTLENECK_REPORT_VERSION})`);
    expect(text).toContain("elapsed:   9.0s");
    expect(text).toContain("tool shell");
    expect(text).toContain("8.3s");
    expect(text).toContain("(2 calls)");
    expect(text).toContain("approval write");
  });

  it("renders an explicit empty-inventory line when nothing was recorded", () => {
    const { build } = createBottleneckCollector();
    const text = formatBottleneckReport(build(1000));
    expect(text).toContain("(no tool or approval activity recorded)");
  });

  it("reports the truncated count beyond the head bound", () => {
    const { collector, build } = createBottleneckCollector();
    for (let i = 0; i < 18; i++) collector.recordTool(`t${i}`, (i + 1) * 10);
    const text = formatBottleneckReport(build(5000));
    expect(text).toContain("truncated: 2 more entries beyond the head bound");
  });

  it("carries no channel for prompt/tool/file content (metadata only)", () => {
    const { collector, build } = createBottleneckCollector();
    // Even if a tool name somehow carried sensitive-looking text, the report only
    // surfaces the (sanitized) name and numbers — never arguments or content.
    collector.recordTool("write", 100);
    const text = formatBottleneckReport(build(100));
    expect(text).not.toContain("content");
    expect(text).not.toContain("secret");
  });
});
