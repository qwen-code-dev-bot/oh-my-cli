import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXTENSION_DISCOVERY_SCHEMA,
  EXTENSION_DISCOVERY_VERSION,
  collectExtensionDiscovery,
  formatExtensionDiscovery,
} from "../../src/extension-discovery.js";
import type { ExtensionDiscoveryReport } from "../../src/extension-discovery.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ext-discovery-"));
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

// A command guaranteed to resolve on this host: the running Node binary.
const NODE_BIN = process.execPath;

const PROVIDER_SECTION = {
  contractVersion: 1,
  default: "primary",
  entries: [
    { id: "primary", model: "model-a", apiKeyEnv: "KEY_A" },
    { id: "secondary", model: "model-b", apiKeyEnv: "KEY_B" },
  ],
};

const MCP_SECTION = {
  contractVersion: 1,
  default: "fs",
  entries: [
    {
      id: "fs",
      transport: "stdio",
      command: NODE_BIN,
      args: ["server.js", "--token", "should-not-appear"],
    },
  ],
};

function surface(report: ExtensionDiscoveryReport, kind: "provider" | "mcp") {
  const found = report.surfaces.find((s) => s.kind === kind);
  if (!found) throw new Error(`missing surface ${kind}`);
  return found;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("extension discovery constants", () => {
  it("exposes a stable schema id and version", () => {
    expect(EXTENSION_DISCOVERY_SCHEMA).toBe("oh-my-cli.extension-discovery");
    expect(EXTENSION_DISCOVERY_VERSION).toBe(1);
  });
});

describe("collectExtensionDiscovery: settings source", () => {
  it("reports every surface absent when the settings file is missing (not an error)", () => {
    const report = collectExtensionDiscovery({ settingsPath: missingPath() });
    expect(report.settingsFound).toBe(false);
    expect(report.settings).toContain("(not found)");
    expect(surface(report, "provider").present).toBe(false);
    expect(surface(report, "mcp").present).toBe(false);
  });

  it("reports both surfaces absent when neither contract is declared", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    expect(report.settingsFound).toBe(true);
    expect(surface(report, "provider").present).toBe(false);
    expect(surface(report, "mcp").present).toBe(false);
  });

  it("always reports both surfaces, provider first then mcp", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    expect(report.surfaces.map((s) => s.kind)).toEqual(["provider", "mcp"]);
  });
});

describe("collectExtensionDiscovery: provider surface", () => {
  it("summarizes a declared provider contract", () => {
    const settings = writeSettings({ providers: PROVIDER_SECTION });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    const provider = surface(report, "provider");
    expect(provider.present).toBe(true);
    expect(provider.schema).toBe("oh-my-cli.provider-contract");
    expect(provider.contractVersion).toBe(1);
    expect(provider.entryCount).toBe(2);
    expect(provider.default).toBe("primary");
    expect(provider.selectedId).toBe("primary");
    // The provider surface carries no lifecycle state.
    expect(provider.state).toBeUndefined();
  });

  it("selects the sole provider entry when no default is declared", () => {
    const settings = writeSettings({
      providers: { contractVersion: 1, entries: [{ id: "solo", model: "m", apiKeyEnv: "K" }] },
    });
    const provider = surface(collectExtensionDiscovery({ settingsPath: settings }), "provider");
    expect(provider.selectedId).toBe("solo");
  });

  it("reports no selection when providers are ambiguous (multiple, no default)", () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [
          { id: "a", model: "m", apiKeyEnv: "K" },
          { id: "b", model: "m2", apiKeyEnv: "K2" },
        ],
      },
    });
    const provider = surface(collectExtensionDiscovery({ settingsPath: settings }), "provider");
    expect(provider.entryCount).toBe(2);
    expect(provider.default).toBeNull();
    expect(provider.selectedId).toBeNull();
  });
});

describe("collectExtensionDiscovery: mcp surface", () => {
  it("summarizes a declared MCP contract and resolves the selected server to ready", () => {
    const settings = writeSettings({ mcp: MCP_SECTION });
    const mcp = surface(collectExtensionDiscovery({ settingsPath: settings }), "mcp");
    expect(mcp.present).toBe(true);
    expect(mcp.schema).toBe("oh-my-cli.mcp-contract");
    expect(mcp.contractVersion).toBe(1);
    expect(mcp.entryCount).toBe(1);
    expect(mcp.selectedId).toBe("fs");
    expect(mcp.state).toBe("ready");
    expect(typeof mcp.probeMs).toBe("number");
  });

  it("reports declared without probing when probe is false", () => {
    const settings = writeSettings({ mcp: MCP_SECTION });
    const mcp = surface(collectExtensionDiscovery({ settingsPath: settings, probe: false }), "mcp");
    expect(mcp.state).toBe("declared");
    expect(mcp.probeMs).toBeNull();
  });

  it("isolates a disabled server (a safe resolution, not an error)", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const mcp = surface(collectExtensionDiscovery({ settingsPath: settings }), "mcp");
    expect(mcp.state).toBe("isolated");
    expect(mcp.stateReason).toBe("disabled");
  });

  it("isolates a server whose command is not found", () => {
    const settings = writeSettings({
      mcp: {
        contractVersion: 1,
        entries: [{ id: "ghost", command: "definitely-not-a-real-binary-xyz-123" }],
      },
    });
    const mcp = surface(collectExtensionDiscovery({ settingsPath: settings }), "mcp");
    expect(mcp.state).toBe("isolated");
    expect(mcp.stateReason).toBe("command not found");
  });

  it("reports no selection or state when MCP servers are ambiguous", () => {
    const settings = writeSettings({
      mcp: {
        contractVersion: 1,
        entries: [
          { id: "a", command: NODE_BIN },
          { id: "b", command: NODE_BIN },
        ],
      },
    });
    const mcp = surface(collectExtensionDiscovery({ settingsPath: settings }), "mcp");
    expect(mcp.entryCount).toBe(2);
    expect(mcp.selectedId).toBeNull();
    expect(mcp.state).toBeNull();
  });
});

describe("collectExtensionDiscovery: both surfaces declared", () => {
  it("summarizes both contracts in one report", () => {
    const settings = writeSettings({ providers: PROVIDER_SECTION, mcp: MCP_SECTION });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    expect(surface(report, "provider").present).toBe(true);
    expect(surface(report, "mcp").present).toBe(true);
    expect(surface(report, "mcp").state).toBe("ready");
  });
});

describe("collectExtensionDiscovery: fail closed on an invalid contract", () => {
  it("throws on an unsupported provider contract version", () => {
    const settings = writeSettings({
      providers: { contractVersion: 99, entries: [{ id: "a", model: "m", apiKeyEnv: "K" }] },
    });
    expect(() => collectExtensionDiscovery({ settingsPath: settings })).toThrow(/not supported/);
  });

  it("throws on a raw credential field in an MCP entry", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: "node", apiKey: "sk-leaked" }] },
    });
    expect(() => collectExtensionDiscovery({ settingsPath: settings })).toThrow(
      /raw credential field/,
    );
  });

  it("throws on invalid JSON", () => {
    const settings = writeRawSettings("{ not valid json");
    expect(() => collectExtensionDiscovery({ settingsPath: settings })).toThrow(/invalid JSON/);
  });

  it("throws on a non-object settings root", () => {
    const settings = writeRawSettings("[1, 2, 3]");
    expect(() => collectExtensionDiscovery({ settingsPath: settings })).toThrow(
      /must contain a JSON object/,
    );
  });
});

describe("collectExtensionDiscovery: backward compatibility and redaction", () => {
  it("coexists with the model, providers, mcp, and mcpServers sections", () => {
    const settings = writeSettings({
      model: { name: "model-name", apiKeyEnv: "MODEL_KEY" },
      providers: PROVIDER_SECTION,
      mcp: MCP_SECTION,
      mcpServers: { legacy: { command: "node" } },
    });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    expect(surface(report, "provider").selectedId).toBe("primary");
    expect(surface(report, "mcp").selectedId).toBe("fs");
  });

  it("collapses the home path and never leaks argument values", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ mcp: MCP_SECTION }));
      const report = collectExtensionDiscovery({ settingsPath });
      expect(report.settings).toBe("~/.oh-my-cli/settings.json");
      const json = JSON.stringify(report);
      expect(json).not.toContain("should-not-appear");
      expect(json).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("formatExtensionDiscovery", () => {
  it("renders both surfaces, marks absent ones, and shows MCP state without secrets", () => {
    const settings = writeSettings({ mcp: MCP_SECTION });
    const report = collectExtensionDiscovery({ settingsPath: settings });
    const out = formatExtensionDiscovery(report);
    expect(out).toContain(EXTENSION_DISCOVERY_SCHEMA);
    expect(out).toContain("Provider contract: not declared");
    expect(out).toContain("MCP contract:");
    expect(out).toContain("ready");
    expect(out).not.toContain("should-not-appear");
  });

  it("flags an ambiguous selection in the human-readable report", () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [
          { id: "a", model: "m", apiKeyEnv: "K" },
          { id: "b", model: "m2", apiKeyEnv: "K2" },
        ],
      },
    });
    const out = formatExtensionDiscovery(collectExtensionDiscovery({ settingsPath: settings }));
    expect(out).toContain("ambiguous");
  });
});
