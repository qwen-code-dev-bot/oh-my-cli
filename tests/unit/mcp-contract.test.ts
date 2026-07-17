import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_CONTRACT_SCHEMA,
  MCP_CONTRACT_VERSION,
  SUPPORTED_MCP_CONTRACT_VERSIONS,
  parseMcpContract,
  selectMcpServer,
  resolveMcpLifecycle,
  buildMcpContractReport,
  collectMcpContract,
  formatMcpContract,
} from "../../src/mcp-contract.js";
import type { McpServerEntry } from "../../src/mcp-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-mcp-contract-"));
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
// that exists and is executable). Used to exercise the "ready" lifecycle.
const NODE_BIN = process.execPath;

const ENTRY: McpServerEntry = {
  id: "fs",
  transport: "stdio",
  command: NODE_BIN,
  args: ["server.js", "--flag"],
};

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseMcpContract: version negotiation", () => {
  it("accepts a supported contract version with one stdio entry", () => {
    const contract = parseMcpContract({ contractVersion: 1, entries: [ENTRY] });
    expect(contract.contractVersion).toBe(1);
    expect(contract.entries).toHaveLength(1);
    expect(contract.entries[0].id).toBe("fs");
  });

  it("fails closed when contractVersion is missing", () => {
    expect(() => parseMcpContract({ entries: [ENTRY] })).toThrow(/contractVersion is required/);
  });

  it("rejects a non-integer contractVersion", () => {
    expect(() => parseMcpContract({ contractVersion: "1", entries: [ENTRY] })).toThrow(
      /contractVersion must be an integer/,
    );
  });

  it("fails closed on an unsupported contract version", () => {
    expect(() => parseMcpContract({ contractVersion: 99, entries: [ENTRY] })).toThrow(
      /mcp contract version 99 is not supported/,
    );
    expect(SUPPORTED_MCP_CONTRACT_VERSIONS).toContain(MCP_CONTRACT_VERSION);
  });

  it("rejects a non-object mcp section", () => {
    expect(() => parseMcpContract([1, 2, 3])).toThrow(/settings.mcp must be an object/);
  });

  it("requires a non-empty entries array", () => {
    expect(() => parseMcpContract({ contractVersion: 1, entries: [] })).toThrow(
      /entries must be a non-empty array/,
    );
  });
});

describe("parseMcpContract: trust boundary and validation", () => {
  it("rejects a raw credential field in an entry, naming the server", () => {
    for (const field of ["apiKey", "token", "secret", "password", "key"]) {
      expect(() =>
        parseMcpContract({
          contractVersion: 1,
          entries: [{ id: "fs", command: "node", [field]: "leaked" }],
        }),
      ).toThrow(/raw credential field/);
    }
  });

  it("names the server in the credential rejection without echoing the value", () => {
    let message = "";
    try {
      parseMcpContract({
        contractVersion: 1,
        entries: [{ id: "fs", command: "node", apiKey: "sk-super-secret" }],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"fs"');
    expect(message).not.toContain("sk-super-secret");
  });

  it("rejects duplicate server ids", () => {
    expect(() =>
      parseMcpContract({ contractVersion: 1, entries: [ENTRY, { ...ENTRY }] }),
    ).toThrow(/duplicate mcp server id "fs"/);
  });

  it("rejects an unsupported transport (http, sse, url, other)", () => {
    expect(() =>
      parseMcpContract({ contractVersion: 1, entries: [{ id: "a", transport: "http", command: "x" }] }),
    ).toThrow(/unsupported transport/);
    expect(() =>
      parseMcpContract({ contractVersion: 1, entries: [{ id: "a", transport: "sse", command: "x" }] }),
    ).toThrow(/unsupported transport/);
    expect(() =>
      parseMcpContract({
        contractVersion: 1,
        entries: [{ id: "a", command: "x", url: "https://host.example" }],
      }),
    ).toThrow(/unsupported transport/);
  });

  it("requires a command", () => {
    expect(() =>
      parseMcpContract({ contractVersion: 1, entries: [{ id: "a", command: "" }] }),
    ).toThrow(/command is required/);
  });

  it("requires a declared default to reference a defined server", () => {
    expect(() =>
      parseMcpContract({ contractVersion: 1, default: "ghost", entries: [ENTRY] }),
    ).toThrow(/default "ghost" is not a defined mcp server id/);
  });

  it("rejects an out-of-range probeTimeoutMs", () => {
    expect(() =>
      parseMcpContract({ contractVersion: 1, entries: [{ id: "a", command: "node", probeTimeoutMs: 1 }] }),
    ).toThrow(/probeTimeoutMs must be/);
  });
});

describe("selectMcpServer: deterministic selection", () => {
  const a = { id: "a", command: "node" };
  const b = { id: "b", command: "node" };

  it("selects an explicit id over the default", () => {
    const contract = parseMcpContract({ contractVersion: 1, default: "a", entries: [a, b] });
    expect(selectMcpServer(contract, { serverId: "b" }).id).toBe("b");
  });

  it("falls back to the declared default", () => {
    const contract = parseMcpContract({ contractVersion: 1, default: "b", entries: [a, b] });
    expect(selectMcpServer(contract).id).toBe("b");
  });

  it("selects the sole entry when no id or default is given", () => {
    const contract = parseMcpContract({ contractVersion: 1, entries: [a] });
    expect(selectMcpServer(contract).id).toBe("a");
  });

  it("fails closed on ambiguity (multiple entries, no id, no default)", () => {
    const contract = parseMcpContract({ contractVersion: 1, entries: [a, b] });
    expect(() => selectMcpServer(contract)).toThrow(/multiple servers defined/);
  });

  it("rejects an unknown explicit id", () => {
    const contract = parseMcpContract({ contractVersion: 1, entries: [a] });
    expect(() => selectMcpServer(contract, { serverId: "ghost" })).toThrow(
      /server "ghost" is not defined/,
    );
  });
});

describe("resolveMcpLifecycle: safe lifecycle states", () => {
  it("reports declared without probing when probe is false", () => {
    const lc = resolveMcpLifecycle(ENTRY, { probe: false });
    expect(lc.state).toBe("declared");
    expect(lc.probeMs).toBeNull();
  });

  it("isolates a disabled server without probing", () => {
    const lc = resolveMcpLifecycle({ ...ENTRY, enabled: false });
    expect(lc.state).toBe("isolated");
    expect(lc.reason).toBe("disabled");
  });

  it("resolves a resolvable command to ready", () => {
    const lc = resolveMcpLifecycle(ENTRY);
    expect(lc.state).toBe("ready");
    expect(lc.reason).toBe("command resolved");
    expect(typeof lc.probeMs).toBe("number");
  });

  it("isolates a server whose command is not found", () => {
    const lc = resolveMcpLifecycle({
      id: "ghost",
      command: "definitely-not-a-real-binary-xyz-123",
    });
    expect(lc.state).toBe("isolated");
    expect(lc.reason).toBe("command not found");
  });

  it("isolates a server when the probe exceeds its bound (timeout)", () => {
    const prevPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const lc = resolveMcpLifecycle(
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

describe("buildMcpContractReport: redaction", () => {
  it("redacts the home path in the command and never leaks argument values", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      const report = buildMcpContractReport({
        contractVersion: 1,
        entry: {
          id: "fs",
          transport: "stdio",
          command: path.join(home, "bin", "mcp-server"),
          args: ["--token", "should-not-appear"],
          capabilities: { tools: true },
        },
        lifecycle: { state: "ready", reason: "command resolved", probeMs: 2 },
        settingsPath,
        settingsFound: true,
      });
      expect(report.schema).toBe(MCP_CONTRACT_SCHEMA);
      expect(report.command).toBe("~/bin/mcp-server");
      expect(report.argCount).toBe(2);
      expect(report.state).toBe("ready");
      expect(report.capabilities).toEqual({ tools: true });
      expect(report.settings).toContain("~");
      const json = JSON.stringify(report);
      expect(json).not.toContain("should-not-appear");
      expect(json).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("collectMcpContract: real settings file", () => {
  it("resolves a declared server end to end (ready, redacted)", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, default: "fs", entries: [ENTRY] },
    });
    const report = collectMcpContract({ settingsPath: settings, env: {} });
    expect(report.serverId).toBe("fs");
    expect(report.transport).toBe("stdio");
    expect(report.state).toBe("ready");
    expect(report.argCount).toBe(2);
  });

  it("reports declared without probing when probe is false", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectMcpContract({ settingsPath: settings, env: {}, probe: false });
    expect(report.state).toBe("declared");
    expect(report.probeMs).toBeNull();
  });

  it("isolates a disabled server (a successful resolution, not an error)", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const report = collectMcpContract({ settingsPath: settings, env: {} });
    expect(report.state).toBe("isolated");
    expect(report.reason).toBe("disabled");
    expect(report.enabled).toBe(false);
  });

  it("throws when the settings file has no mcp section", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    expect(() => collectMcpContract({ settingsPath: settings, env: {} })).toThrow(
      /no settings.mcp section/,
    );
  });

  it("throws when the settings file is missing", () => {
    expect(() => collectMcpContract({ settingsPath: missingPath(), env: {} })).toThrow(
      /settings file not found/,
    );
  });

  it("coexists with the model and providers sections (backward compatibility)", () => {
    const settings = writeSettings({
      model: { name: "model-name", apiKeyEnv: "MODEL_KEY" },
      providers: {
        contractVersion: 1,
        entries: [{ id: "alt", model: "alt-model", apiKeyEnv: "ALT_KEY" }],
      },
      mcp: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectMcpContract({ settingsPath: settings, env: {} });
    expect(report.serverId).toBe("fs");
    expect(report.schema).toBe(MCP_CONTRACT_SCHEMA);
  });
});

describe("formatMcpContract", () => {
  it("shows the server, command, and state but not argument values", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [ENTRY] },
    });
    const report = collectMcpContract({ settingsPath: settings, env: {} });
    const out = formatMcpContract(report);
    expect(out).toContain("fs");
    expect(out).toContain("stdio");
    expect(out).toContain("ready");
    expect(out).toContain(MCP_CONTRACT_SCHEMA);
    expect(out).not.toContain("should-not-appear");
  });
});
