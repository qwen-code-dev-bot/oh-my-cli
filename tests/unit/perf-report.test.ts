import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { Workspace } from "../../src/workspace.js";
import {
  PERF_REPORT_SCHEMA,
  PERF_REPORT_VERSION,
  PERF_BUDGETS,
  PERF_TURN_LOG_SCAN_LIMIT,
  phaseVerdict,
  overallVerdict,
  walkWorkspaceDiscovery,
  collectPerfReport,
  formatPerfReport,
} from "../../src/perf-report.js";
import type { PerfReport } from "../../src/perf-report.js";

const ANSI = /\x1b\[/;

describe("perf verdicts (Issue #572)", () => {
  it("compares a measurement against its declared budget", () => {
    expect(phaseVerdict(0, 100)).toBe("ok");
    expect(phaseVerdict(100, 100)).toBe("ok");
    expect(phaseVerdict(101, 100)).toBe("exceeds");
  });

  it("derives the overall verdict from the phases, naming none implicitly", () => {
    const ok = { name: "discovery" as const, measured: 1, unit: "ms" as const, budget: 2, verdict: "ok" as const, detail: "" };
    const bad = { ...ok, name: "memory" as const, verdict: "exceeds" as const, unit: "bytes" as const };
    expect(overallVerdict([ok, { ...ok, name: "store-scan" as const }])).toBe("ok");
    expect(overallVerdict([ok, bad])).toBe("exceeds");
    expect(overallVerdict([])).toBe("ok");
  });
});

describe("walkWorkspaceDiscovery (Issue #572)", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572-walk-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("counts files and dirs, skipping dot/skip dirs and never following symlinks", () => {
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "x");
    fs.writeFileSync(path.join(ws, "src", "b.ts"), "y");
    fs.writeFileSync(path.join(ws, "node_modules", "pkg", "index.js"), "z");
    fs.writeFileSync(path.join(ws, "root.txt"), "r");
    // A symlinked directory must never be followed.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572-outside-"));
    fs.writeFileSync(path.join(outside, "secret-file.txt"), "s");
    fs.symlinkSync(outside, path.join(ws, "link"));

    const result = walkWorkspaceDiscovery(new Workspace(ws));
    expect(result.files).toBe(3); // src/a.ts, src/b.ts, root.txt
    expect(result.dirs).toBe(1); // src only (node_modules/.git skipped; link never followed)
    expect(result.truncated).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("honors .gitignore rules", () => {
    fs.mkdirSync(path.join(ws, "keep"), { recursive: true });
    fs.mkdirSync(path.join(ws, "generated"), { recursive: true });
    fs.writeFileSync(path.join(ws, "keep", "a.txt"), "a");
    fs.writeFileSync(path.join(ws, "generated", "b.txt"), "b");
    fs.writeFileSync(path.join(ws, ".gitignore"), "generated/\n");

    const result = walkWorkspaceDiscovery(new Workspace(ws));
    // keep/a.txt + the .gitignore file itself; generated/ is ignored entirely.
    expect(result.files).toBe(2);
    expect(result.dirs).toBe(1);
  });

  it("reports truncation honestly on a deep tree instead of walking forever", () => {
    // A chain deeper than the depth bound.
    let dir = ws;
    for (let i = 0; i < 40; i++) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(path.join(dir, "deep.txt"), "deep");
    const result = walkWorkspaceDiscovery(new Workspace(ws));
    expect(result.truncated).toBe(true);
  });
});

describe("collectPerfReport (Issue #572)", () => {
  let ws: string;
  let homeDir: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572-home-"));
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "x");
  });
  afterEach(() => {
    for (const d of [ws, homeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("measures the four phases in a fixed order with budgets and verdicts", () => {
    const store = new SessionStore(homeDir);
    const report = collectPerfReport({ workspace: new Workspace(ws), store });
    expect(report.schema).toBe(PERF_REPORT_SCHEMA);
    expect(report.v).toBe(PERF_REPORT_VERSION);
    expect(report.phases.map((p) => p.name)).toEqual([
      "discovery",
      "store-scan",
      "turn-log-scan",
      "memory",
    ]);
    const [discovery, storeScan, turnLogScan, memory] = report.phases;
    expect(discovery.budget).toBe(PERF_BUDGETS.discoveryMs);
    expect(discovery.detail).toContain("1 files");
    expect(storeScan.detail).toContain("0 session(s)");
    expect(turnLogScan.detail).toContain("0 turn log(s)");
    expect(memory.unit).toBe("bytes");
    expect(memory.measured).toBeGreaterThan(0);
    expect(report.overall).toBe(overallVerdict(report.phases));
    // Every verdict is consistent with its measurement and budget.
    for (const phase of report.phases) {
      expect(phase.verdict).toBe(phaseVerdict(phase.measured, phase.budget));
    }
  });

  it("scans turn logs only for the newest bounded set of sessions", () => {
    const store = new SessionStore(homeDir);
    for (let i = 0; i < PERF_TURN_LOG_SCAN_LIMIT + 5; i++) {
      const id = store.newId();
      store.writeMeta(id, { model: "m", workspace: ws, createdAt: i });
      store.append(id, { role: "user", content: `m${i}` });
    }
    const report = collectPerfReport({ workspace: new Workspace(ws), store });
    const phase = report.phases.find((p) => p.name === "turn-log-scan")!;
    expect(phase.detail).toContain(`${PERF_TURN_LOG_SCAN_LIMIT} turn log(s)`);
  });
});

describe("formatPerfReport (Issue #572)", () => {
  const fixture: PerfReport = {
    schema: PERF_REPORT_SCHEMA,
    v: PERF_REPORT_VERSION,
    workspace: "/srv/project",
    phases: [
      { name: "discovery", measured: 12, unit: "ms", budget: PERF_BUDGETS.discoveryMs, verdict: "ok", detail: "10 files, 2 dirs" },
      { name: "store-scan", measured: 900, unit: "ms", budget: PERF_BUDGETS.storeScanMs, verdict: "exceeds", detail: "40 session(s)" },
      { name: "turn-log-scan", measured: 3, unit: "ms", budget: PERF_BUDGETS.turnLogScanMs, verdict: "ok", detail: "5 turn log(s), 2 checkpoint(s)" },
      { name: "memory", measured: 64 * 1024 * 1024, unit: "bytes", budget: PERF_BUDGETS.heapUsedBytes, verdict: "ok", detail: "heap 64 MB, rss 90 MB" },
    ],
    overall: "exceeds",
  };

  it("renders every phase with its measurement, named budget, and verdict", () => {
    const text = formatPerfReport(fixture).join("\n");
    expect(text).toContain("[ ok ] discovery  12 ms / budget 2000 ms");
    expect(text).toContain("[EXCEEDS] store-scan  900 ms / budget 500 ms");
    expect(text).toContain("[ ok ] memory  64 MB / budget 512 MB");
    expect(text).toContain("40 session(s)");
    expect(text).toContain("Overall: one or more phases exceed their declared budgets (named above).");
    expect(text).not.toMatch(ANSI);
  });

  it("renders the all-ok overall line deterministically", () => {
    const allOk: PerfReport = { ...fixture, phases: fixture.phases.map((p) => ({ ...p, verdict: "ok" as const, measured: 1 })), overall: "ok" };
    const text = formatPerfReport(allOk).join("\n");
    expect(text).toContain("Overall: all phases within declared budgets.");
    expect(formatPerfReport(allOk).join("\n")).toBe(text);
  });
});
