import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOL_CONTRACT_SCHEMA,
  TOOL_CONTRACT_VERSION,
  SUPPORTED_TOOL_CONTRACT_VERSIONS,
  parseToolContract,
  selectTool,
  resolveToolReadiness,
  buildToolContractReport,
  collectToolContract,
  formatToolContract,
} from "../../src/tool-contract.js";
import type { ToolEntry } from "../../src/tool-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-tool-contract-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

// A command guaranteed to resolve: the running Node binary (an absolute path
// that exists and is executable). Used to exercise the "ready" readiness state.
const NODE_BIN = process.execPath;

const ENTRY: ToolEntry = {
  id: "fs",
  kind: "command",
  command: NODE_BIN,
  args: ["server.js", "--flag"],
};

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseToolContract: version negotiation", () => {
  it("accepts a supported contract version with one command entry", () => {
    const contract = parseToolContract({ contractVersion: 1, entries: [ENTRY] });
    expect(contract.contractVersion).toBe(1);
    expect(contract.entries).toHaveLength(1);
    expect(contract.entries[0].id).toBe("fs");
  });

  it("fails closed when contractVersion is missing", () => {
    expect(() => parseToolContract({ entries: [ENTRY] })).toThrow(/contractVersion is required/);
  });

  it("rejects a non-integer contractVersion", () => {
    expect(() => parseToolContract({ contractVersion: "1", entries: [ENTRY] })).toThrow(
      /contractVersion must be an integer/,
    );
  });

  it("fails closed on an unsupported contract version", () => {
    expect(() => parseToolContract({ contractVersion: 99, entries: [ENTRY] })).toThrow(
      /tools contract version 99 is not supported/,
    );
    expect(SUPPORTED_TOOL_CONTRACT_VERSIONS).toContain(TOOL_CONTRACT_VERSION);
  });

  it("rejects a non-object tools section", () => {
    expect(() => parseToolContract([1, 2, 3])).toThrow(/settings.tools must be an object/);
  });

  it("requires a non-empty entries array", () => {
    expect(() => parseToolContract({ contractVersion: 1, entries: [] })).toThrow(
      /entries must be a non-empty array/,
    );
  });
});

describe("parseToolContract: trust boundary and validation", () => {
  it("rejects a raw credential field in an entry, naming the tool", () => {
    for (const field of ["apiKey", "token", "secret", "password", "key"]) {
      expect(() =>
        parseToolContract({
          contractVersion: 1,
          entries: [{ id: "fs", command: "node", [field]: "leaked" }],
        }),
      ).toThrow(/raw credential field/);
    }
  });

  it("names the tool in the credential rejection without echoing the value", () => {
    let message = "";
    try {
      parseToolContract({
        contractVersion: 1,
        entries: [{ id: "fs", command: "node", apiKey: "sk-super-secret" }],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"fs"');
    expect(message).not.toContain("sk-super-secret");
  });

  it("rejects duplicate tool ids", () => {
    expect(() =>
      parseToolContract({ contractVersion: 1, entries: [ENTRY, { ...ENTRY }] }),
    ).toThrow(/duplicate tool id "fs"/);
  });

  it("rejects an unsupported kind (remote/network/url)", () => {
    expect(() =>
      parseToolContract({ contractVersion: 1, entries: [{ id: "a", kind: "http", command: "x" }] }),
    ).toThrow(/unsupported kind/);
    expect(() =>
      parseToolContract({ contractVersion: 1, entries: [{ id: "a", kind: "mcp", command: "x" }] }),
    ).toThrow(/unsupported kind/);
    expect(() =>
      parseToolContract({
        contractVersion: 1,
        entries: [{ id: "a", command: "x", url: "https://host.example" }],
      }),
    ).toThrow(/unsupported kind/);
  });

  it("requires a command", () => {
    expect(() =>
      parseToolContract({ contractVersion: 1, entries: [{ id: "a", command: "" }] }),
    ).toThrow(/command is required/);
  });

  it("requires a declared default to reference a defined tool", () => {
    expect(() =>
      parseToolContract({ contractVersion: 1, default: "ghost", entries: [ENTRY] }),
    ).toThrow(/default "ghost" is not a defined tool id/);
  });

  it("rejects an out-of-range probeTimeoutMs", () => {
    expect(() =>
      parseToolContract({ contractVersion: 1, entries: [{ id: "a", command: "node", probeTimeoutMs: 1 }] }),
    ).toThrow(/probeTimeoutMs must be/);
  });
});

describe("selectTool: deterministic selection", () => {
  const a = { id: "a", command: "node" };
  const b = { id: "b", command: "node" };

  it("selects an explicit id over the default", () => {
    const contract = parseToolContract({ contractVersion: 1, default: "a", entries: [a, b] });
    expect(selectTool(contract, { toolId: "b" }).id).toBe("b");
  });

  it("falls back to the declared default", () => {
    const contract = parseToolContract({ contractVersion: 1, default: "b", entries: [a, b] });
    expect(selectTool(contract).id).toBe("b");
  });

  it("selects the sole entry when no id or default is given", () => {
    const contract = parseToolContract({ contractVersion: 1, entries: [a] });
    expect(selectTool(contract).id).toBe("a");
  });

  it("fails closed on ambiguity (multiple entries, no id, no default)", () => {
    const contract = parseToolContract({ contractVersion: 1, entries: [a, b] });
    expect(() => selectTool(contract)).toThrow(/multiple tools defined/);
  });

  it("rejects an unknown explicit id", () => {
    const contract = parseToolContract({ contractVersion: 1, entries: [a] });
    expect(() => selectTool(contract, { toolId: "ghost" })).toThrow(/tool "ghost" is not defined/);
  });
});

describe("resolveToolReadiness: safe readiness states", () => {
  it("reports declared without probing when probe is false", () => {
    const lc = resolveToolReadiness(ENTRY, { probe: false });
    expect(lc.state).toBe("declared");
    expect(lc.probeMs).toBeNull();
  });

  it("isolates a disabled tool without probing", () => {
    const lc = resolveToolReadiness({ ...ENTRY, enabled: false });
    expect(lc.state).toBe("isolated");
    expect(lc.reason).toBe("disabled");
  });

  it("resolves a resolvable command to ready", () => {
    const lc = resolveToolReadiness(ENTRY);
    expect(lc.state).toBe("ready");
    expect(lc.reason).toBe("command resolved");
    expect(typeof lc.probeMs).toBe("number");
  });

  it("isolates a tool whose command is not found", () => {
    const lc = resolveToolReadiness({
      id: "ghost",
      command: "definitely-not-a-real-binary-xyz-123",
    });
    expect(lc.state).toBe("isolated");
    expect(lc.reason).toBe("command not found");
  });

  it("isolates a tool when the probe exceeds its bound (timeout)", () => {
    const prevPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const lc = resolveToolReadiness(
        { id: "slow", command: "some-bare-command" },
        { deadline: Date.now() - 1 },
      );
      expect(lc.state).toBe("isolated");
      expect(lc.reason).toBe("probe timed out");
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe("buildToolContractReport: redaction", () => {
  it("redacts the home path in the command and never leaks argument values", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      const report = buildToolContractReport({
        contractVersion: 1,
        entry: {
          id: "fs",
          kind: "command",
          command: path.join(home, "bin", "my-tool"),
          args: ["--token", "should-not-appear"],
          capabilities: { readOnly: true },
        },
        readiness: { state: "ready", reason: "command resolved", probeMs: 2 },
        settingsPath,
        settingsFound: true,
      });
      expect(report.schema).toBe(TOOL_CONTRACT_SCHEMA);
      expect(report.command).toBe("~/bin/my-tool");
      expect(report.argCount).toBe(2);
      expect(report.state).toBe("ready");
      expect(report.capabilities).toEqual({ readOnly: true });
      expect(report.settings).toContain("~");
      const json = JSON.stringify(report);
      expect(json).not.toContain("should-not-appear");
      expect(json).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("collectToolContract: real settings file", () => {
  it("resolves a declared tool end to end (ready, redacted)", () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, default: "fs", entries: [ENTRY] },
    });
    const report = collectToolContract({ settingsPath: settings, env: {} });
    expect(report.toolId).toBe("fs");
    expect(report.kind).toBe("command");
    expect(report.state).toBe("ready");
    expect(report.argCount).toBe(2);
  });

  it("reports declared without probing when probe is false", () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectToolContract({ settingsPath: settings, env: {}, probe: false });
    expect(report.state).toBe("declared");
    expect(report.probeMs).toBeNull();
  });

  it("isolates a disabled tool (a successful resolution, not an error)", () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const report = collectToolContract({ settingsPath: settings, env: {} });
    expect(report.state).toBe("isolated");
    expect(report.reason).toBe("disabled");
    expect(report.enabled).toBe(false);
  });

  it("throws when the settings file has no tools section", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    expect(() => collectToolContract({ settingsPath: settings, env: {} })).toThrow(
      /no settings.tools section/,
    );
  });

  it("throws when the settings file is missing", () => {
    expect(() => collectToolContract({ settingsPath: missingPath(), env: {} })).toThrow(
      /settings file not found/,
    );
  });

  it("coexists with the model, providers, and mcp sections (backward compatibility)", () => {
    const settings = writeSettings({
      model: { name: "model-name", apiKeyEnv: "MODEL_KEY" },
      providers: {
        contractVersion: 1,
        entries: [{ id: "alt", model: "alt-model", apiKeyEnv: "ALT_KEY" }],
      },
      mcp: { contractVersion: 1, entries: [{ id: "srv", command: NODE_BIN }] },
      tools: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectToolContract({ settingsPath: settings, env: {} });
    expect(report.toolId).toBe("fs");
    expect(report.schema).toBe(TOOL_CONTRACT_SCHEMA);
  });
});

describe("formatToolContract", () => {
  it("shows the tool, command, and state but not argument values", () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectToolContract({ settingsPath: settings, env: {} });
    const out = formatToolContract(report);
    expect(out).toContain("fs");
    expect(out).toContain("command");
    expect(out).toContain("ready");
    expect(out).toContain(TOOL_CONTRACT_SCHEMA);
    expect(out).not.toContain("should-not-appear");
  });
});
