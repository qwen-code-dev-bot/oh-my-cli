// Ecosystem dogfood (Issue #151, capstone of parent #34): prove the four
// extension surfaces — alternate provider, bounded tool, MCP server, and
// non-interactive workflow — COMPOSE from a single user settings document under
// one governance model, in one non-interactive run, with no core code changes.
//
// Each surface was already proven in isolation (provider #149, tool #145, MCP
// #147, workflow #143). Nothing yet proved a single settings file can declare
// all four and that one governed, redacted run can exercise each through its own
// path. This test consumes the merged contracts, invokers, discovery, and
// workflow runner; it adds no new surface and changes no core path.
//
// Everything runs against LOCAL fixtures only (an in-process OpenAI-compatible
// mock provider, the local stdio MCP server fixture, a local `node -e` tool, and
// a declared workflow) so the dogfood is repeatable headlessly with no TTY and no
// external network. The example settings document lives at
// tests/fixtures/ecosystem.settings.json and is validated against every contract
// schema below before being exercised end to end.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startMockServer } from "../fixtures/openai-mock-server.mjs";
import { parseProviderContract } from "../../src/provider-contract.js";
import { parseToolContract } from "../../src/tool-contract.js";
import { parseMcpContract } from "../../src/mcp-contract.js";
import { parseWorkflowContract } from "../../src/workflow-contract.js";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
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

// The running Node binary: a command guaranteed to resolve on this host (used as
// the tool command and the MCP server transport).
const NODE_BIN = process.execPath;
// The local stdio MCP server fixture (one file, behavior selected by --mode).
const MCP_FIXTURE = path.resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");
// The single example composed ecosystem settings document under test.
const EXAMPLE = path.resolve(import.meta.dirname, "../fixtures/ecosystem.settings.json");

// The shape of the example document — only the fields this dogfood patches or
// asserts on. The document is the single source of truth for the composed setup;
// runtime values (dynamic mock port, absolute command paths) are patched in.
interface EcosystemSettings {
  providers: {
    contractVersion: number;
    entries: Array<{ id: string; baseUrl: string; model: string; apiKeyEnv: string }>;
  };
  tools: { contractVersion: number; entries: Array<{ id: string; command: string; args: string[] }> };
  mcp: { contractVersion: number; entries: Array<{ id: string; command: string; args: string[] }> };
  workflows: {
    contractVersion: number;
    definitions: Record<string, { description?: string; steps: Array<{ prompt: string }> }>;
  };
}

describe("Integration: extension ecosystem dogfood", () => {
  let tmpRoot: string;
  let server: { baseUrl: string; close: () => Promise<void> };
  let cleanEnv: Record<string, string>;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ecosystem-dogfood-"));
    server = await startMockServer();
    // Blank the OPENAI_* variables so the host environment cannot leak into a
    // workflow step run (an empty value is treated as unset).
    cleanEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function loadExample(): EcosystemSettings {
    return JSON.parse(fs.readFileSync(EXAMPLE, "utf8")) as EcosystemSettings;
  }

  // Clone the example document and patch in the runtime-specific values that the
  // static fixture cannot carry: the mock provider's dynamic base URL and the
  // absolute command paths for the tool and the MCP server. The composed shape
  // (one provider, one tool, one MCP server, one workflow) is unchanged.
  function runtimeSettings(
    opts: {
      providerModel?: string;
      toolCommand?: string;
      toolArgs?: string[];
      workflowPrompt?: string;
    } = {},
  ): EcosystemSettings {
    const doc = JSON.parse(JSON.stringify(loadExample())) as EcosystemSettings;
    doc.providers.entries[0].baseUrl = server.baseUrl;
    if (opts.providerModel) doc.providers.entries[0].model = opts.providerModel;
    doc.tools.entries[0].command = opts.toolCommand ?? NODE_BIN;
    if (opts.toolArgs) doc.tools.entries[0].args = opts.toolArgs;
    doc.mcp.entries[0].command = NODE_BIN;
    doc.mcp.entries[0].args = [MCP_FIXTURE, "--mode", "echo"];
    if (opts.workflowPrompt) {
      doc.workflows.definitions["daily-standup"].steps[0].prompt = opts.workflowPrompt;
    }
    return doc;
  }

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function workspace(): string {
    return fs.mkdtempSync(path.join(tmpRoot, "ws-"));
  }

  // One environment that satisfies every surface at once: the provider credential
  // (referenced by name in the settings), and the OPENAI_* triple the workflow's
  // headless step path uses to reach the same mock provider.
  function runEnv(home: string, opts: { credential?: string } = {}): Record<string, string> {
    return {
      ...cleanEnv,
      HOME: home,
      OMC_DOGFOOD_KEY: opts.credential ?? "sk-dogfood-super-secret-value",
      OPENAI_API_KEY: "dogfood-key",
      OPENAI_BASE_URL: server.baseUrl,
      OPENAI_MODEL: "dogfood-model",
    };
  }

  it("the example settings document is valid across all four extension contracts", () => {
    const doc = loadExample();

    const providers = parseProviderContract(doc.providers);
    const tools = parseToolContract(doc.tools);
    const mcp = parseMcpContract(doc.mcp);
    const workflows = parseWorkflowContract(doc.workflows);

    expect(providers.contractVersion).toBe(1);
    expect(providers.entries.map((e) => e.id)).toEqual(["assistant"]);
    // Credentials are referenced by environment-variable name only.
    expect(providers.entries[0].apiKeyEnv).toBe("OMC_DOGFOOD_KEY");

    expect(tools.contractVersion).toBe(1);
    expect(tools.entries.map((e) => e.id)).toEqual(["echo-tool"]);

    expect(mcp.contractVersion).toBe(1);
    expect(mcp.entries.map((e) => e.id)).toEqual(["echo-server"]);

    expect(workflows.contractVersion).toBe(1);
    expect(workflows.definitions.map((d) => d.name)).toEqual(["daily-standup"]);
  });

  it("composes provider + tool + MCP + workflow from one settings document in one governed run", async () => {
    const home = homeWith(runtimeSettings());
    const env = runEnv(home);
    const ws = workspace();

    // Provider surface: one bounded request to the resolved-ready provider.
    const provider = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "compose the ecosystem", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(provider.code).toBe(0);
    const pr = JSON.parse(provider.stdout);
    expect(pr.schema).toBe("oh-my-cli.provider-invocation");
    expect(pr.gate).toBe("passed");
    expect(pr.invoked).toBe(true);
    expect(pr.outcome).toBe("called");
    expect(pr.content).toBe("compose the ecosystem");
    expect(pr.credentialVariable).toBe("OMC_DOGFOOD_KEY");

    // Tool surface: the resolved-ready local command runs once.
    const tool = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(tool.code).toBe(0);
    const tr = JSON.parse(tool.stdout);
    expect(tr.schema).toBe("oh-my-cli.tool-invocation");
    expect(tr.gate).toBe("passed");
    expect(tr.invoked).toBe(true);
    expect(tr.exitCode).toBe(0);
    expect(tr.stdout).toContain("tool composed ok");

    // MCP surface: connect to the resolved-ready server and call its tool.
    const mcp = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", "channel=eng", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(mcp.code).toBe(0);
    const mr = JSON.parse(mcp.stdout);
    expect(mr.schema).toBe("oh-my-cli.mcp-invocation");
    expect(mr.gate).toBe("passed");
    expect(mr.invoked).toBe(true);
    expect(mr.outcome).toBe("called");
    expect(mr.toolName).toBe("echo");
    expect(mr.content).toContain("eng");

    // Workflow surface: the declared workflow runs its step through the headless
    // provider path, reaching the same mock provider.
    const workflow = await runCli(
      ["--run-workflow", "daily-standup", "--workspace", ws, "--output", "json"],
      env,
      30_000,
    );
    expect(workflow.code).toBe(0);
    const wr = JSON.parse(workflow.stdout);
    expect(wr.schema).toBe("oh-my-cli.workflow-contract");
    expect(wr.workflow).toBe("daily-standup");
    expect(wr.result).toBe("completed");
    expect(wr.stepsRun).toBe(1);
    expect(wr.stepsTotal).toBe(1);
    expect(wr.steps[0].ok).toBe(true);
  });

  it("emits redacted human-readable evidence for the composed run (no credential value)", async () => {
    const home = homeWith(runtimeSettings());
    const env = runEnv(home);
    const ws = workspace();
    // Default (text) output: the human-readable governed report.
    const text = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "standup", "--workspace", ws],
      env,
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Provider:");
    expect(text.stdout).toContain("oh-my-cli.provider-invocation");
    expect(text.stdout + text.stderr).not.toContain("sk-dogfood-super-secret-value");
  });

  it("an unapproved provider fails closed while tool and MCP still govern correctly", async () => {
    const home = homeWith(runtimeSettings());
    const env = runEnv(home);
    const ws = workspace();

    // Provider under the default approval mode: refused, never invoked.
    const provider = await runCli(
      ["--invoke-provider", "--provider-prompt", "x", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(provider.code).toBe(2);
    const pr = JSON.parse(provider.stdout);
    expect(pr.gate).toBe("unapproved");
    expect(pr.invoked).toBe(false);

    // The sibling surfaces remain fully governed and runnable from the same file.
    const tool = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(tool.code).toBe(0);
    expect(JSON.parse(tool.stdout).invoked).toBe(true);

    const mcp = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", "k=v", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(mcp.code).toBe(0);
    expect(JSON.parse(mcp.stdout).outcome).toBe("called");
  });

  it("a missing provider credential fails closed (not-ready) while the tool still runs", async () => {
    const home = homeWith(runtimeSettings());
    const ws = workspace();
    const noCred = { ...runEnv(home), OMC_DOGFOOD_KEY: "" };

    const provider = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      noCred,
    );
    expect(provider.code).toBe(2);
    const pr = JSON.parse(provider.stdout);
    expect(pr.gate).toBe("not-ready");
    expect(pr.invoked).toBe(false);

    const tool = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      runEnv(home),
    );
    expect(tool.code).toBe(0);
    expect(JSON.parse(tool.stdout).invoked).toBe(true);
  });

  it("a policy-denied tool command fails closed while the provider still runs", async () => {
    const home = homeWith(runtimeSettings({ toolCommand: "git", toolArgs: ["push", "--force"] }));
    const env = runEnv(home);
    const ws = workspace();

    const tool = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(tool.code).toBe(2);
    const tr = JSON.parse(tool.stdout);
    expect(tr.gate).toBe("policy-denied");
    expect(tr.invoked).toBe(false);

    const provider = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "x", "--workspace", ws, "--output", "json"],
      env,
    );
    expect(provider.code).toBe(0);
    expect(JSON.parse(provider.stdout).outcome).toBe("called");
  });

  it("redacts every secret value and host path across all four surfaces", async () => {
    // Distinct, LOW-ENTROPY decoys planted in each surface's output. They still
    // match the redactor's patterns (a ghp_ token, an sk- token, and the
    // --token / token= flag forms) but stay well under gitleaks' entropy
    // threshold so CI's secret scan does not flag this test as a leaked
    // credential — the same approach the workflow-contract test uses.
    const toolDecoy = "ghp_aaaaaaaaaaaaaaaaaaaaaaaa";
    const mcpDecoy = "ghp_cccccccccccccccccccccccc";
    const wfDecoy = "sk-bbbbbbbbbbbbbbbbbbbb";
    const envDecoy = "sk-dddddddddddddddddddddddd";

    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    const secretPath = path.join(home, ".ssh", "id_rsa");
    const settings = runtimeSettings({
      providerModel: "secret",
      toolArgs: ["-e", `process.stdout.write('--token ${toolDecoy}')`],
      workflowPrompt: `read ${secretPath} using ${wfDecoy}`,
    });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));

    const env = runEnv(home, { credential: envDecoy });
    const ws = workspace();

    const provider = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "x", "--workspace", ws, "--output", "json"],
      env,
    );
    const tool = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", ws, "--output", "json"],
      env,
    );
    const mcp = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", `token=${mcpDecoy}`, "--workspace", ws, "--output", "json"],
      env,
    );
    const workflow = await runCli(
      ["--run-workflow", "daily-standup", "--workspace", ws, "--output", "json"],
      env,
      30_000,
    );

    const combined = [provider, tool, mcp, workflow]
      .map((r) => r.stdout + r.stderr)
      .join("\n");
    // The mock "secret" model returns this fixed token in the provider response.
    expect(combined).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(combined).not.toContain(toolDecoy);
    expect(combined).not.toContain(mcpDecoy);
    expect(combined).not.toContain(wfDecoy);
    expect(combined).not.toContain(envDecoy);
    expect(combined).not.toContain(home);
    expect(combined).toContain("[REDACTED]");

    // The workflow's redacted step view collapses the home path to "~".
    const wr = JSON.parse(workflow.stdout);
    expect(wr.steps[0].prompt).toContain("~");
  });
});
