import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXTENSION_COMPAT_SCHEMA,
  EXTENSION_COMPAT_VERSION,
  collectExtensionCompat,
  formatExtensionCompat,
  supportedExtensionContractVersions,
} from "../../src/extension-compat.js";
import type { ExtensionCompatReport, ExtensionSurfaceKind } from "../../src/extension-compat.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ext-compat-"));
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

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

function surface(report: ExtensionCompatReport, kind: ExtensionSurfaceKind) {
  const found = report.surfaces.find((s) => s.kind === kind);
  if (!found) throw new Error(`missing surface ${kind}`);
  return found;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("extension compat constants", () => {
  it("exposes a stable schema id and version", () => {
    expect(EXTENSION_COMPAT_SCHEMA).toBe("oh-my-cli.extension-compat");
    expect(EXTENSION_COMPAT_VERSION).toBe(1);
  });
});

describe("supportedExtensionContractVersions: the matrix", () => {
  it("lists all four surfaces with their schema id and supported version range", () => {
    const matrix = supportedExtensionContractVersions();
    expect(matrix.map((s) => s.kind)).toEqual(["provider", "tool", "mcp", "workflow"]);
    const byKind = Object.fromEntries(matrix.map((s) => [s.kind, s]));
    expect(byKind.provider.schema).toBe("oh-my-cli.provider-contract");
    expect(byKind.tool.schema).toBe("oh-my-cli.tool-contract");
    expect(byKind.mcp.schema).toBe("oh-my-cli.mcp-contract");
    expect(byKind.workflow.schema).toBe("oh-my-cli.workflow-contract");
    for (const s of matrix) {
      expect(s.supportedVersions).toEqual([1]);
    }
  });

  it("is settings-independent (the matrix is the same with no settings file)", () => {
    const matrix = supportedExtensionContractVersions();
    const report = collectExtensionCompat({ settingsPath: missingPath() });
    expect(report.surfaces.map((s) => s.supportedVersions)).toEqual(
      matrix.map((s) => s.supportedVersions),
    );
  });
});

describe("collectExtensionCompat: settings source", () => {
  it("reports every surface absent when the settings file is missing (not an error)", () => {
    const report = collectExtensionCompat({ settingsPath: missingPath() });
    expect(report.settingsFound).toBe(false);
    expect(report.settings).toContain("(not found)");
    for (const kind of ["provider", "tool", "mcp", "workflow"] as const) {
      const s = surface(report, kind);
      expect(s.present).toBe(false);
      expect(s.verdict).toBe("absent");
      expect(s.declaredVersion).toBeNull();
    }
  });

  it("reports every surface absent when no contract is declared", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectExtensionCompat({ settingsPath: settings });
    expect(report.settingsFound).toBe(true);
    for (const kind of ["provider", "tool", "mcp", "workflow"] as const) {
      expect(surface(report, kind).verdict).toBe("absent");
    }
  });

  it("always reports all four surfaces, provider then tool then mcp then workflow", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectExtensionCompat({ settingsPath: settings });
    expect(report.surfaces.map((s) => s.kind)).toEqual(["provider", "tool", "mcp", "workflow"]);
  });
});

describe("collectExtensionCompat: per-surface verdicts", () => {
  it("reports compatible for a declared version within the supported range", () => {
    const settings = writeSettings({ providers: { contractVersion: 1, entries: [] } });
    const provider = surface(collectExtensionCompat({ settingsPath: settings }), "provider");
    expect(provider.present).toBe(true);
    expect(provider.declaredVersion).toBe(1);
    expect(provider.verdict).toBe("compatible");
    expect(provider.reason).toContain("supported");
  });

  it("reports incompatible for a version outside the supported range, naming both", () => {
    const settings = writeSettings({ providers: { contractVersion: 99, entries: [] } });
    const provider = surface(collectExtensionCompat({ settingsPath: settings }), "provider");
    expect(provider.present).toBe(true);
    expect(provider.declaredVersion).toBe(99);
    expect(provider.verdict).toBe("incompatible");
    expect(provider.reason).toContain("99");
    expect(provider.reason).toContain("outside the supported range");
  });

  it("distinguishes a supported version from an out-of-range one deterministically", () => {
    const ok = writeSettings({ tools: { contractVersion: 1, entries: [] } });
    const bad = writeSettings({ tools: { contractVersion: 2, entries: [] } });
    expect(surface(collectExtensionCompat({ settingsPath: ok }), "tool").verdict).toBe("compatible");
    expect(surface(collectExtensionCompat({ settingsPath: bad }), "tool").verdict).toBe(
      "incompatible",
    );
  });

  it("reports incompatible when a present section omits contractVersion", () => {
    const settings = writeSettings({ mcp: { entries: [] } });
    const mcp = surface(collectExtensionCompat({ settingsPath: settings }), "mcp");
    expect(mcp.present).toBe(true);
    expect(mcp.declaredVersion).toBeNull();
    expect(mcp.verdict).toBe("incompatible");
    expect(mcp.reason).toContain("missing");
  });

  it("reports incompatible when contractVersion is not an integer", () => {
    const settings = writeSettings({ workflows: { contractVersion: "1", definitions: {} } });
    const workflow = surface(collectExtensionCompat({ settingsPath: settings }), "workflow");
    expect(workflow.present).toBe(true);
    expect(workflow.declaredVersion).toBeNull();
    expect(workflow.verdict).toBe("incompatible");
    expect(workflow.reason).toContain("not an integer");
  });

  it("reports incompatible when a present section is not an object", () => {
    const settings = writeSettings({ providers: "nope" });
    const provider = surface(collectExtensionCompat({ settingsPath: settings }), "provider");
    expect(provider.present).toBe(true);
    expect(provider.declaredVersion).toBeNull();
    expect(provider.verdict).toBe("incompatible");
    expect(provider.reason).toContain("not an object");
  });

  it("verdicts each surface independently in one mixed report", () => {
    const settings = writeSettings({
      providers: { contractVersion: 1, entries: [] },
      tools: { contractVersion: 99, entries: [] },
      workflows: { contractVersion: 1, definitions: {} },
    });
    const report = collectExtensionCompat({ settingsPath: settings });
    expect(surface(report, "provider").verdict).toBe("compatible");
    expect(surface(report, "tool").verdict).toBe("incompatible");
    expect(surface(report, "mcp").verdict).toBe("absent");
    expect(surface(report, "workflow").verdict).toBe("compatible");
  });
});

describe("collectExtensionCompat: an unsupported version is a verdict, not a crash", () => {
  it("returns normally (does not throw) on an unsupported version", () => {
    const settings = writeSettings({
      providers: { contractVersion: 99, entries: [] },
      tools: { contractVersion: 1, entries: [] },
      mcp: { contractVersion: 99, entries: [] },
      workflows: { contractVersion: 99, definitions: {} },
    });
    expect(() => collectExtensionCompat({ settingsPath: settings })).not.toThrow();
  });
});

describe("collectExtensionCompat: does not re-validate contract structure", () => {
  it("does not throw on a raw credential field in an entry (discovery's job) and never leaks it", () => {
    const settings = writeSettings({
      mcp: {
        contractVersion: 1,
        entries: [{ id: "fs", command: "node", args: ["--token", "should-not-appear"], apiKey: "sk-leaked" }],
      },
    });
    let report: ExtensionCompatReport | undefined;
    expect(() => {
      report = collectExtensionCompat({ settingsPath: settings });
    }).not.toThrow();
    expect(surface(report!, "mcp").verdict).toBe("compatible");
    const json = JSON.stringify(report!);
    expect(json).not.toContain("should-not-appear");
    expect(json).not.toContain("sk-leaked");
  });
});

describe("collectExtensionCompat: fail closed on a malformed settings root", () => {
  it("throws on invalid JSON", () => {
    const settings = writeRawSettings("{ not valid json");
    expect(() => collectExtensionCompat({ settingsPath: settings })).toThrow(/invalid JSON/);
  });

  it("throws on a non-object settings root", () => {
    const settings = writeRawSettings("[1, 2, 3]");
    expect(() => collectExtensionCompat({ settingsPath: settings })).toThrow(
      /must contain a JSON object/,
    );
  });
});

describe("collectExtensionCompat: redaction and scope", () => {
  it("collapses the home path and never leaks secret or argument values", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          providers: {
            contractVersion: 1,
            entries: [{ id: "primary", model: "m", apiKeyEnv: "KEY_A" }],
          },
          mcp: {
            contractVersion: 99,
            entries: [{ id: "fs", command: "node", args: ["--token", "should-not-appear"] }],
          },
        }),
      );
      const report = collectExtensionCompat({ settingsPath });
      expect(report.settings).toBe("~/.oh-my-cli/settings.json");
      const json = JSON.stringify(report);
      expect(json).not.toContain("should-not-appear");
      expect(json).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("formatExtensionCompat", () => {
  it("renders the matrix and verdicts without secrets", () => {
    const settings = writeSettings({
      providers: { contractVersion: 1, entries: [] },
      tools: { contractVersion: 99, entries: [{ id: "rg", command: "node", args: ["should-not-appear"] }] },
    });
    const out = formatExtensionCompat(collectExtensionCompat({ settingsPath: settings }));
    expect(out).toContain(EXTENSION_COMPAT_SCHEMA);
    expect(out).toContain("Provider contract: compatible");
    expect(out).toContain("Tool contract: incompatible");
    expect(out).toContain("MCP contract: absent");
    expect(out).toContain("Workflow contract: absent");
    expect(out).toContain("Supported: 1");
    expect(out).toContain("Declared:  99");
    expect(out).not.toContain("should-not-appear");
  });

  it("marks an absent surface as not declared", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const out = formatExtensionCompat(collectExtensionCompat({ settingsPath: settings }));
    expect(out).toContain("Provider contract: absent");
    expect(out).toContain("Declared:  (not declared)");
  });
});
