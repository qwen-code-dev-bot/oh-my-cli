import { describe, it, expect } from "vitest";
import {
  DEFAULT_LSP_SERVERS,
  LSP_RUNTIME_SCHEMA,
  LSP_RUNTIME_VERSION,
  applyLspEvent,
  checkLspTimeout,
  detectLanguagesFromPaths,
  discoverLanguageServers,
  endLspSession,
  formatLspServerDetail,
  formatLspSummary,
  restartLspServer,
  startLspServer,
  stopLspServer,
  summarizeLspRuntime,
} from "../../src/lsp-runtime.js";
import type { LspDiagnosticsEvent, LspServer } from "../../src/lsp-runtime.js";
import os from "node:os";

const WS = "ws-key-abc";
// Build paths under the real home so home-path redaction is genuinely exercised.
const ROOT = `${os.homedir()}/project`;

function starting(overrides: Partial<Parameters<typeof startLspServer>[0]> = {}): LspServer {
  return startLspServer({
    workspaceKey: WS,
    workspaceRoot: ROOT,
    sessionId: "session-1",
    language: "typescript",
    command: "typescript-language-server --stdio",
    now: 1_000,
    ...overrides,
  });
}

function ready(overrides: Partial<Parameters<typeof startLspServer>[0]> = {}): LspServer {
  const started = starting(overrides);
  return applyLspEvent(started, { type: "ready", at: 2_000 }).server;
}

function diagEvent(overrides: Partial<LspDiagnosticsEvent> = {}): LspDiagnosticsEvent {
  return {
    type: "diagnostics",
    at: 3_000,
    workspaceKey: WS,
    instanceId: 1,
    fileUri: `file://${ROOT}/src/a.ts`,
    version: 5,
    items: [
      { severity: "error", message: "Cannot find name 'foo'", range: { startLine: 11, startChar: 4, endLine: 11, endChar: 7 } },
    ],
    ...overrides,
  };
}

describe("discoverLanguageServers — no implicit install, explicit + quiet", () => {
  it("marks a configured server available when its binary is present", () => {
    const report = discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: true,
      specs: DEFAULT_LSP_SERVERS,
      binaryAvailable: (cmd) => cmd === "typescript-language-server",
    });
    expect(report.trusted).toBe(true);
    expect(report.workspaceRoot).toBe("~/project");
    const ts = report.plans.find((p) => p.language === "typescript");
    expect(ts?.availability).toBe("available");
    const py = report.plans.find((p) => p.language === "python");
    expect(py?.availability).toBe("missing-binary");
    expect(py?.detail).toContain("not installed");
  });

  it("never reports a server as available when the probe says the binary is absent", () => {
    const report = discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: true,
      specs: DEFAULT_LSP_SERVERS,
      binaryAvailable: () => false,
    });
    expect(report.plans.every((p) => p.availability !== "available")).toBe(true);
  });

  it("surfaces no running servers for an untrusted workspace (explicit, quiet)", () => {
    const report = discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: false,
      specs: DEFAULT_LSP_SERVERS,
      binaryAvailable: () => true,
    });
    expect(report.trusted).toBe(false);
    expect(report.plans.length).toBeGreaterThan(0);
    expect(report.plans.every((p) => p.availability === "untrusted")).toBe(true);
  });

  it("marks a present language with no registered server as unsupported", () => {
    const report = discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: true,
      specs: [{ language: "typescript", command: "typescript-language-server", extensions: [".ts"] }],
      presentLanguages: ["cobol"],
      binaryAvailable: () => true,
    });
    const cobol = report.plans.find((p) => p.language === "cobol");
    expect(cobol?.availability).toBe("unsupported");
    expect(cobol?.command).toBe("");
  });

  it("detects languages from file paths by extension", () => {
    const langs = detectLanguagesFromPaths(["a.ts", "b.py", "c.txt", "d.rs"]);
    expect(langs).toEqual(["python", "rust", "typescript"]);
  });
});

describe("lifecycle transitions", () => {
  it("moves starting → ready → indexing → ready", () => {
    let s = starting();
    expect(s.status).toBe("starting");
    s = applyLspEvent(s, { type: "ready", at: 2_000 }).server;
    expect(s.status).toBe("ready");
    s = applyLspEvent(s, { type: "indexing", at: 3_000 }).server;
    expect(s.status).toBe("indexing");
    s = applyLspEvent(s, { type: "ready", at: 4_000 }).server;
    expect(s.status).toBe("ready");
  });

  it("transitions to degraded and error with a redacted detail", () => {
    let s = ready();
    const degraded = applyLspEvent(s, { type: "degraded", at: 5_000, detail: "index partial" });
    expect(degraded.accepted).toBe(true);
    expect(degraded.server.status).toBe("degraded");
    const errored = applyLspEvent(s, { type: "error", at: 6_000, detail: "crashed" });
    expect(errored.server.status).toBe("error");
    expect(errored.server.detail).toBe("crashed");
  });

  it("ignores lifecycle events on a stopped server", () => {
    const stopped = stopLspServer(ready(), 9_000);
    const res = applyLspEvent(stopped, { type: "ready", at: 10_000 });
    expect(res.accepted).toBe(false);
    expect(res.server.status).toBe("stopped");
  });

  it("rejects a ready event on an errored server until restart", () => {
    const errored = applyLspEvent(ready(), { type: "error", at: 6_000, detail: "boom" }).server;
    const res = applyLspEvent(errored, { type: "ready", at: 7_000 });
    expect(res.accepted).toBe(false);
    expect(res.server.status).toBe("error");
  });
});

describe("diagnostic binding — stale, foreign, and previous-instance never current", () => {
  it("accepts a current diagnostic bound to file, version, and instance", () => {
    const res = applyLspEvent(ready(), diagEvent());
    expect(res.accepted).toBe(true);
    expect(res.acceptedDiagnostics).toBe(1);
    expect(res.server.diagnostics).toHaveLength(1);
    expect(res.server.diagnostics[0].version).toBe(5);
    expect(res.server.diagnostics[0].severity).toBe("error");
    expect(res.server.diagnostics[0].displayUri).toBe("file://~/project/src/a.ts");
  });

  it("rejects diagnostics from another workspace", () => {
    const res = applyLspEvent(ready(), diagEvent({ workspaceKey: "other-workspace" }));
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain("another workspace");
    expect(res.server.diagnostics).toHaveLength(0);
    expect(res.server.rejectedStaleEvents).toBe(1);
  });

  it("rejects diagnostics from a previous server instance", () => {
    const res = applyLspEvent(ready(), diagEvent({ instanceId: 99 }));
    expect(res.accepted).toBe(false);
    expect(res.reason).toContain("previous server instance");
    expect(res.server.diagnostics).toHaveLength(0);
  });

  it("rejects a stale (older) document version but keeps the newer one", () => {
    let s = ready();
    s = applyLspEvent(s, diagEvent({ version: 5, items: [{ severity: "error", message: "v5" }] })).server;
    const stale = applyLspEvent(s, diagEvent({ version: 4, items: [{ severity: "warning", message: "v4 stale" }] }));
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toContain("stale document version");
    expect(stale.server.diagnostics).toHaveLength(1);
    expect(stale.server.diagnostics[0].message).toBe("v5");
    expect(stale.server.rejectedStaleEvents).toBe(1);
  });

  it("supersedes a file's diagnostics when a newer version publishes", () => {
    let s = ready();
    s = applyLspEvent(s, diagEvent({ version: 5, items: [{ severity: "error", message: "old" }] })).server;
    s = applyLspEvent(s, diagEvent({ version: 6, items: [{ severity: "warning", message: "new" }] })).server;
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0].version).toBe(6);
    expect(s.diagnostics[0].message).toBe("new");
  });

  it("clears a file's diagnostics when an empty set publishes at a newer version", () => {
    let s = ready();
    s = applyLspEvent(s, diagEvent({ version: 5, items: [{ severity: "error", message: "x" }] })).server;
    s = applyLspEvent(s, diagEvent({ version: 6, items: [] })).server;
    expect(s.diagnostics).toHaveLength(0);
  });

  it("ignores diagnostics for a stopped or errored server", () => {
    const stopped = applyLspEvent(stopLspServer(ready(), 9_000), diagEvent());
    expect(stopped.accepted).toBe(false);
    const errored = applyLspEvent(
      applyLspEvent(ready(), { type: "error", at: 6_000, detail: "boom" }).server,
      diagEvent(),
    );
    expect(errored.accepted).toBe(false);
    expect(errored.server.diagnostics).toHaveLength(0);
  });
});

describe("timeout, restart, and cleanup", () => {
  it("advances a still-starting server past its timeout into an error", () => {
    const s = starting({ now: 0 });
    const before = checkLspTimeout(s, 1_000, 30_000);
    expect(before.timedOut).toBe(false);
    const after = checkLspTimeout(s, 31_000, 30_000);
    expect(after.timedOut).toBe(true);
    expect(after.server.status).toBe("error");
    expect(after.server.detail).toContain("timed out");
  });

  it("restart creates a fresh instance and drops prior diagnostics", () => {
    let s = ready();
    s = applyLspEvent(s, diagEvent({ version: 5 })).server;
    expect(s.diagnostics).toHaveLength(1);
    const restarted = restartLspServer(s, 20_000);
    expect(restarted.instanceId).toBe(2);
    expect(restarted.status).toBe("starting");
    expect(restarted.diagnostics).toHaveLength(0);
    // A diagnostic from the old instance is now rejected.
    const stale = applyLspEvent(restarted, diagEvent({ instanceId: 1, version: 5 }));
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toContain("previous server instance");
  });

  it("stopping a server clears its diagnostics", () => {
    let s = ready();
    s = applyLspEvent(s, diagEvent()).server;
    const stopped = stopLspServer(s, 9_000);
    expect(stopped.status).toBe("stopped");
    expect(stopped.diagnostics).toHaveLength(0);
  });

  it("endLspSession stops only the owning session's servers (ownership + cleanup)", () => {
    const mine = ready({ sessionId: "session-1" });
    const theirs = ready({ sessionId: "session-2" });
    const result = endLspSession([mine, theirs], "session-1", 50_000);
    expect(result.find((s) => s.sessionId === "session-1")?.status).toBe("stopped");
    expect(result.find((s) => s.sessionId === "session-2")?.status).toBe("ready");
  });
});

describe("secret-safety and bounds", () => {
  it("redacts secrets in a diagnostic message", () => {
    const res = applyLspEvent(
      ready(),
      diagEvent({ items: [{ severity: "error", message: "leak sk-abcdefghij1234567890abcd here" }] }),
    );
    expect(res.server.diagnostics[0].message).not.toContain("sk-abcdefghij1234567890abcd");
    expect(res.server.diagnostics[0].message).toContain("[REDACTED]");
  });

  it("redacts a secret in a server error detail", () => {
    const res = applyLspEvent(ready(), {
      type: "error",
      at: 6_000,
      detail: "auth failed: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
    });
    expect(res.server.detail).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
    expect(res.server.detail).toContain("[REDACTED]");
  });

  it("bounds a diagnostic message length", () => {
    const huge = "x".repeat(5_000);
    const res = applyLspEvent(ready(), diagEvent({ items: [{ severity: "warning", message: huge }] }));
    expect(res.server.diagnostics[0].message.length).toBeLessThanOrEqual(240);
  });

  it("caps the number of diagnostics retained per server", () => {
    const items = Array.from({ length: 200 }, (_v, i) => ({
      severity: "warning" as const,
      message: `m${i}`,
    }));
    const res = applyLspEvent(ready(), diagEvent({ items }));
    expect(res.server.diagnostics.length).toBeLessThanOrEqual(50);
  });
});

describe("summary + formatting", () => {
  it("aggregates server status and diagnostic counts", () => {
    const a = applyLspEvent(
      ready({ language: "typescript" }),
      diagEvent({ items: [{ severity: "error", message: "e" }, { severity: "warning", message: "w" }] }),
    ).server;
    const b = applyLspEvent(starting({ language: "go" }), { type: "error", at: 5_000, detail: "x" }).server;
    const summary = summarizeLspRuntime([a, b]);
    expect(summary.schema).toBe(LSP_RUNTIME_SCHEMA);
    expect(summary.v).toBe(LSP_RUNTIME_VERSION);
    expect(summary.serverCount).toBe(2);
    expect(summary.byStatus.ready).toBe(1);
    expect(summary.byStatus.error).toBe(1);
    expect(summary.totalDiagnostics).toBe(2);
    expect(summary.diagnosticsBySeverity.error).toBe(1);
    expect(summary.diagnosticsBySeverity.warning).toBe(1);
  });

  it("renders a compact summary with no servers", () => {
    const lines = formatLspSummary(summarizeLspRuntime([]), { workspaceRoot: ROOT, trusted: true });
    expect(lines.join("\n")).toContain("none configured");
    expect(lines.join("\n")).toContain("~/project");
  });

  it("renders inspectable per-server detail including diagnostics", () => {
    const s = applyLspEvent(ready(), diagEvent()).server;
    const detail = formatLspServerDetail(s).join("\n");
    expect(detail).toContain("typescript  ready  (instance 1)");
    expect(detail).toContain("Cannot find name 'foo'");
    expect(detail).toContain("v5");
  });
});
