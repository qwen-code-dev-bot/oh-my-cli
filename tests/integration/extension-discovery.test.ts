import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.on("error", reject);
  });
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

const TOOL_SECTION = {
  contractVersion: 1,
  default: "rg",
  entries: [
    {
      id: "rg",
      command: NODE_BIN,
      args: ["--version", "should-not-appear"],
    },
  ],
};

const WORKFLOW_SECTION = {
  contractVersion: 1,
  definitions: {
    "lint-fix": {
      description: "Lint then apply fixes",
      steps: [{ prompt: "run the linter" }, { prompt: "apply the suggested fixes" }],
    },
  },
};

function surface(report: { surfaces: Array<Record<string, unknown>> }, kind: string) {
  return report.surfaces.find((s) => s.kind === kind) as Record<string, unknown>;
}

describe("Integration: extension discovery", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ext-discovery-int-"));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  it("discovers all four declared contracts as redacted JSON and exits 0", async () => {
    const home = homeWith({
      providers: PROVIDER_SECTION,
      mcp: MCP_SECTION,
      tools: TOOL_SECTION,
      workflows: WORKFLOW_SECTION,
    });
    const r = await runCli(["--discover-extensions", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.extension-discovery");
    const provider = surface(report, "provider");
    const mcp = surface(report, "mcp");
    const tool = surface(report, "tool");
    const workflow = surface(report, "workflow");
    expect(provider.present).toBe(true);
    expect(provider.selectedId).toBe("primary");
    expect(mcp.present).toBe(true);
    expect(mcp.selectedId).toBe("fs");
    expect(mcp.state).toBe("ready");
    expect(tool.present).toBe(true);
    expect(tool.selectedId).toBe("rg");
    expect(tool.state).toBe("ready");
    expect(workflow.present).toBe(true);
    expect(workflow.selectedId).toBeNull();
    expect(workflow.state).toBe("ready");
    // Redaction: argument values never appear in output.
    expect(r.stdout + r.stderr).not.toContain("should-not-appear");
  });

  it("reports every surface absent (exit 0) when no contract is declared", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--discover-extensions", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.settingsFound).toBe(true);
    expect(surface(report, "provider").present).toBe(false);
    expect(surface(report, "mcp").present).toBe(false);
    expect(surface(report, "tool").present).toBe(false);
    expect(surface(report, "workflow").present).toBe(false);
  });

  it("reports every surface absent (exit 0) when the settings file is missing", async () => {
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const r = await runCli(["--discover-extensions", "--output", "json"], { HOME: emptyHome });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.settingsFound).toBe(false);
    expect(surface(report, "provider").present).toBe(false);
    expect(surface(report, "mcp").present).toBe(false);
    expect(surface(report, "tool").present).toBe(false);
    expect(surface(report, "workflow").present).toBe(false);
  });

  it("reports the MCP surface as declared without probing via --no-probe", async () => {
    const home = homeWith({ mcp: MCP_SECTION });
    const r = await runCli(["--discover-extensions", "--no-probe", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const mcp = surface(JSON.parse(r.stdout), "mcp");
    expect(mcp.state).toBe("declared");
    expect(mcp.probeMs).toBeNull();
  });

  it("isolates a disabled MCP server and still exits 0", async () => {
    const home = homeWith({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const r = await runCli(["--discover-extensions", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const mcp = surface(JSON.parse(r.stdout), "mcp");
    expect(mcp.state).toBe("isolated");
    expect(mcp.stateReason).toBe("disabled");
  });

  it("reports the tool surface as declared without probing via --no-probe", async () => {
    const home = homeWith({ tools: TOOL_SECTION });
    const r = await runCli(["--discover-extensions", "--no-probe", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const tool = surface(JSON.parse(r.stdout), "tool");
    expect(tool.state).toBe("declared");
    expect(tool.probeMs).toBeNull();
  });

  it("isolates a disabled tool and still exits 0", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "rg", command: NODE_BIN, enabled: false }] },
    });
    const r = await runCli(["--discover-extensions", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const tool = surface(JSON.parse(r.stdout), "tool");
    expect(tool.state).toBe("isolated");
    expect(tool.stateReason).toBe("disabled");
  });

  it("reports the workflow surface as ready, with no selection (and via --no-probe)", async () => {
    const home = homeWith({ workflows: WORKFLOW_SECTION });
    const probed = await runCli(["--discover-extensions", "--output", "json"], { HOME: home });
    expect(probed.code).toBe(0);
    const workflow = surface(JSON.parse(probed.stdout), "workflow");
    expect(workflow.present).toBe(true);
    expect(workflow.entryCount).toBe(1);
    expect(workflow.default).toBeNull();
    expect(workflow.selectedId).toBeNull();
    expect(workflow.state).toBe("ready");
    expect(workflow.probeMs).toBeNull();

    // A workflow has nothing to probe: --no-probe reports the same ready state.
    const noProbe = await runCli(["--discover-extensions", "--no-probe", "--output", "json"], {
      HOME: home,
    });
    expect(noProbe.code).toBe(0);
    expect(surface(JSON.parse(noProbe.stdout), "workflow").state).toBe("ready");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith({ mcp: MCP_SECTION, workflows: WORKFLOW_SECTION });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Extension Discovery");
    expect(r.stdout).toContain("Provider contract: not declared");
    expect(r.stdout).toContain("Workflow contract: 1 definition (contract version 1)");
    expect(r.stdout).toContain("ready");
    expect(r.stdout).not.toContain("should-not-appear");
  });

  it("honors an explicit --settings path", async () => {
    const custom = path.join(tmpRoot, "explicit.json");
    fs.writeFileSync(custom, JSON.stringify({ providers: PROVIDER_SECTION }));
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty2-"));
    const r = await runCli(["--discover-extensions", "--settings", custom, "--output", "json"], {
      HOME: emptyHome,
    });
    expect(r.code).toBe(0);
    expect(surface(JSON.parse(r.stdout), "provider").selectedId).toBe("primary");
  });

  it("exits 2 (fail closed) on an unsupported provider contract version", async () => {
    const home = homeWith({
      providers: { contractVersion: 99, entries: [{ id: "a", model: "m", apiKeyEnv: "K" }] },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 (fail closed) on a raw credential field in an MCP entry", async () => {
    const home = homeWith({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: "node", apiKey: "sk-leaked" }] },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
    expect(r.stdout + r.stderr).not.toContain("sk-leaked");
  });

  it("exits 2 (fail closed) on an unsupported tool contract version", async () => {
    const home = homeWith({
      tools: { contractVersion: 99, entries: [{ id: "rg", command: "node" }] },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 (fail closed) on a raw credential field in a tool entry", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "rg", command: "node", token: "sk-leaked" }] },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
    expect(r.stdout + r.stderr).not.toContain("sk-leaked");
  });

  it("exits 2 (fail closed) on an unsupported workflow contract version", async () => {
    const home = homeWith({
      workflows: { contractVersion: 99, definitions: { a: { steps: [{ prompt: "x" }] } } },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 (fail closed) on a raw credential field in a workflow step", async () => {
    const home = homeWith({
      workflows: {
        contractVersion: 1,
        definitions: { a: { steps: [{ prompt: "x", token: "sk-leaked" }] } },
      },
    });
    const r = await runCli(["--discover-extensions"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
    expect(r.stdout + r.stderr).not.toContain("sk-leaked");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith({ mcp: MCP_SECTION });
    const r = await runCli(["--discover-extensions", "--output", "yaml"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
