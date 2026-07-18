import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRUST_POSTURE_SCHEMA,
  TRUST_POSTURE_VERSION,
  collectTrustPosture,
  formatTrustPosture,
} from "../../src/trust-posture.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-trust-posture-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function writeRawSettings(raw: string): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, raw);
  return p;
}

function missingSettings(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

// A command guaranteed to resolve on this host: the running Node binary.
const NODE_BIN = process.execPath;

const MCP_READY = {
  contractVersion: 1,
  default: "fs",
  entries: [
    { id: "fs", transport: "stdio", command: NODE_BIN, args: ["server.js", "--token", "should-not-appear"] },
  ],
};

const PROVIDER_SECTION = {
  contractVersion: 1,
  default: "primary",
  entries: [{ id: "primary", model: "model-a", apiKeyEnv: "KEY_A" }],
};

let prevHome: string | undefined;
let home: string;
let workspace: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  // Isolate the user trust store: a clean HOME means an empty store, so the
  // workspace is untrusted by default and trust state is driven by the test.
  home = tmpDir();
  process.env.HOME = home;
  workspace = path.join(tmpDir(), "project");
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  process.env.HOME = prevHome;
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("trust posture constants", () => {
  it("exposes a stable schema id and version", () => {
    expect(TRUST_POSTURE_SCHEMA).toBe("oh-my-cli.trust-posture");
    expect(TRUST_POSTURE_VERSION).toBe(1);
  });
});

describe("collectTrustPosture: folder trust gate", () => {
  it("reports an untrusted workspace by default (fail closed)", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {} });
    expect(report.folderTrust.state).toBe("untrusted");
    expect(report.folderTrust.mutatingAllowed).toBe(false);
    expect(report.folderTrust.sandbox).toBe("none");
  });

  it("reports a trusted workspace via --trust (this run)", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, trustThisRun: true });
    expect(report.folderTrust.state).toBe("trusted");
    expect(report.folderTrust.mutatingAllowed).toBe(true);
  });

  it("reports sandbox-enforced when an effective sandbox is advertised", () => {
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: { OMC_SANDBOX: "enforced" },
    });
    expect(report.folderTrust.state).toBe("sandbox-enforced");
    expect(report.folderTrust.mutatingAllowed).toBe(true);
    expect(report.folderTrust.sandbox).toBe("enforced");
  });

  it("reports sandbox-unavailable when a sandbox is required but absent", () => {
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: { OMC_REQUIRE_SANDBOX: "1" },
    });
    expect(report.folderTrust.state).toBe("sandbox-unavailable");
    expect(report.folderTrust.mutatingAllowed).toBe(false);
  });

  it("reflects whether folder-trust enforcement is active", () => {
    const on = collectTrustPosture({ workspacePath: workspace, env: {}, enforcing: true });
    const off = collectTrustPosture({ workspacePath: workspace, env: {}, enforcing: false });
    expect(on.folderTrust.enforcing).toBe(true);
    expect(off.folderTrust.enforcing).toBe(false);
  });
});

describe("collectTrustPosture: approval posture", () => {
  it("derives the auto-approved categories for default mode", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, approvalMode: "default" });
    expect(report.approval.mode).toBe("default");
    expect(report.approval.autoApproves).toEqual(["read"]);
    expect(report.approval.permits).toMatch(/require approval/);
  });

  it("derives the auto-approved categories for auto-edit mode", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, approvalMode: "auto-edit" });
    expect(report.approval.autoApproves).toEqual(["read", "mutate-file"]);
  });

  it("derives the auto-approved categories for yolo mode and flags it unsafe", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, approvalMode: "yolo" });
    expect(report.approval.autoApproves).toEqual(["read", "mutate-file", "mutate-shell"]);
    expect(report.approval.permits).toMatch(/unsafe/i);
  });
});

describe("collectTrustPosture: sandbox confinement", () => {
  it("reports interactive mode and a confined workspace when a TTY is present", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, isTTY: true });
    expect(report.sandbox.mode).toBe("interactive");
    expect(report.sandbox.workspaceConfined).toBe(true);
    expect(report.sandbox.ttyAvailable).toBe(true);
  });

  it("warns about yolo mode regardless of trust", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, approvalMode: "yolo" });
    expect(report.sandbox.warnings.some((w) => /yolo/i.test(w))).toBe(true);
  });

  it("warns about default approval mode without a TTY (headless)", () => {
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: {},
      approvalMode: "default",
      isTTY: false,
    });
    expect(report.sandbox.mode).toBe("headless");
    expect(report.sandbox.warnings.some((w) => /mutating tools will be denied/i.test(w))).toBe(true);
  });
});

describe("collectTrustPosture: extension readiness", () => {
  it("reports a declared MCP server resolved to ready", () => {
    const settings = writeSettings({ mcp: MCP_READY });
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    const mcp = report.extensions.surfaces.find((s) => s.kind === "mcp")!;
    expect(mcp.present).toBe(true);
    expect(mcp.selectedId).toBe("fs");
    expect(mcp.state).toBe("ready");
  });

  it("reports a declared provider and an absent MCP surface", () => {
    const settings = writeSettings({ providers: PROVIDER_SECTION });
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    const provider = report.extensions.surfaces.find((s) => s.kind === "provider")!;
    const mcp = report.extensions.surfaces.find((s) => s.kind === "mcp")!;
    expect(provider.present).toBe(true);
    expect(provider.selectedId).toBe("primary");
    expect(mcp.present).toBe(false);
  });

  it("reports every surface absent when the settings file is missing", () => {
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: {},
      settingsPath: missingSettings(),
    });
    expect(report.extensions.settingsFound).toBe(false);
    expect(report.extensions.surfaces.every((s) => !s.present)).toBe(true);
    expect(report.extensions.error).toBeUndefined();
  });

  it("reports the MCP surface as declared without probing", () => {
    const settings = writeSettings({ mcp: MCP_READY });
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: {},
      settingsPath: settings,
      probe: false,
    });
    expect(report.extensions.surfaces.find((s) => s.kind === "mcp")!.state).toBe("declared");
  });

  it("isolates a disabled MCP server", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    expect(report.extensions.surfaces.find((s) => s.kind === "mcp")!.state).toBe("isolated");
  });
});

describe("collectTrustPosture: invalid contract surfaces as a warning, not a throw", () => {
  it("captures an invalid MCP contract as a redacted error and still reports", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: "node", apiKey: "sk-leaked" }] },
    });
    let report;
    expect(() => {
      report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    }).not.toThrow();
    expect(report!.extensions.error).toMatch(/raw credential field/);
    expect(report!.extensions.error).not.toContain("sk-leaked");
    expect(report!.extensions.surfaces).toEqual([]);
    // The trust and approval surfaces are still reported.
    expect(report!.folderTrust.state).toBeDefined();
    expect(report!.approval.mode).toBe("default");
  });

  it("captures invalid JSON as a warning", () => {
    const settings = writeRawSettings("{ not json");
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    expect(report.extensions.error).toMatch(/invalid JSON/);
  });
});

describe("collectTrustPosture: redaction", () => {
  it("collapses the home path and never leaks argument values", () => {
    const settings = writeSettings({ mcp: MCP_READY });
    const wsUnderHome = path.join(home, "work", "project");
    fs.mkdirSync(wsUnderHome, { recursive: true });
    const report = collectTrustPosture({ workspacePath: wsUnderHome, env: {}, settingsPath: settings });
    expect(report.workspace).toBe("~/work/project");
    const json = JSON.stringify(report);
    expect(json).not.toContain("should-not-appear");
    expect(json).not.toContain(home);
  });
});

describe("formatTrustPosture", () => {
  it("renders every section and the trust/approval relationship", () => {
    const settings = writeSettings({ mcp: MCP_READY });
    const report = collectTrustPosture({
      workspacePath: workspace,
      env: {},
      settingsPath: settings,
      trustThisRun: true,
    });
    const out = formatTrustPosture(report);
    expect(out).toContain("Trust Posture");
    expect(out).toContain("Folder trust");
    expect(out).toContain("Approval");
    expect(out).toContain("Sandbox confinement");
    expect(out).toContain("Extension readiness");
    expect(out).toContain("permitted (approval mode still applies)");
    expect(out).toContain("fs — ready");
    expect(out).not.toContain("should-not-appear");
  });

  it("shows a fail-closed mutation line when enforcing an untrusted workspace", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, enforcing: true });
    expect(formatTrustPosture(report)).toContain("DENIED (fail closed)");
  });

  it("shows an advisory mutation line when untrusted and not enforcing", () => {
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, enforcing: false });
    expect(formatTrustPosture(report)).toContain("would be denied if enforcement were on");
  });

  it("renders an invalid extension contract as a visible warning", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 99, entries: [{ id: "a", command: "node" }] },
    });
    const report = collectTrustPosture({ workspacePath: workspace, env: {}, settingsPath: settings });
    expect(formatTrustPosture(report)).toContain("Invalid:");
    expect(formatTrustPosture(report)).toContain("not supported");
  });
});
