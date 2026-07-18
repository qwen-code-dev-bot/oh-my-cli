import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

describe("Integration: workflow contract", () => {
  let server: FakeServer;
  let tmpRoot: string;
  let cleanEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-workflow-int-"));
    // Blank the OPENAI_* variables so the host environment cannot leak into a
    // step run (an empty value is treated as unset).
    cleanEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function runEnv(home: string): Record<string, string> {
    return {
      ...cleanEnv,
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: home,
    };
  }

  const validWorkflows = {
    workflows: {
      contractVersion: 1,
      definitions: {
        "ci-readonly": {
          description: "Two read-only steps",
          steps: [{ prompt: "List files" }, { prompt: "Summarize README" }],
        },
      },
    },
  };

  // --- Listing / contract validation (no provider needed) ---

  it("lists declared workflows as redacted JSON and exits 0", async () => {
    const home = homeWith(validWorkflows);
    const r = await runCli(["--list-workflows", "--output", "json"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.workflow-contract");
    expect(report.contractVersion).toBe(1);
    expect(report.workflows[0].name).toBe("ci-readonly");
    expect(report.workflows[0].steps).toBe(2);
  });

  it("emits a human-readable list by default", async () => {
    const home = homeWith(validWorkflows);
    const r = await runCli(["--list-workflows"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Workflows");
    expect(r.stdout).toContain("ci-readonly");
    expect(r.stdout).toContain("2 steps");
  });

  it("exits 2 when the user settings have no workflows section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--list-workflows"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.workflows section");
  });

  it("exits 2 (fail closed) on an unsupported contract version", async () => {
    const home = homeWith({
      workflows: { contractVersion: 99, definitions: { wf: { steps: [{ prompt: "x" }] } } },
    });
    const r = await runCli(["--list-workflows"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 on a raw credential field in a workflow", async () => {
    const home = homeWith({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: "x" }], apiKey: "leaked" } } },
    });
    const r = await runCli(["--list-workflows"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith(validWorkflows);
    const r = await runCli(["--list-workflows", "--output", "yaml"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("does not honor a project-scope workflow (user scope only)", async () => {
    // User scope has no workflows; the workspace's project file declares one.
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    fs.mkdirSync(path.join(ws, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".oh-my-cli", "settings.json"),
      JSON.stringify({
        workflows: { contractVersion: 1, definitions: { evil: { steps: [{ prompt: "x" }] } } },
      }),
    );
    const r = await runCli(["--list-workflows", "--output", "json", "--workspace", ws], {
      ...cleanEnv,
      HOME: home,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.workflows section");
    expect(r.stdout + r.stderr).not.toContain("evil");
  });

  // --- Running a workflow end-to-end via the headless -p path ---

  it("runs a minimal two-step workflow end-to-end and exits 0", async () => {
    server.setResponses([
      { type: "text", content: "step one done" },
      { type: "text", content: "step two done" },
    ]);
    const home = homeWith(validWorkflows);
    const r = await runCli(
      ["--run-workflow", "ci-readonly", "--output", "json", "--workspace", tmpRoot],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.workflow).toBe("ci-readonly");
    expect(report.result).toBe("completed");
    expect(report.stepsRun).toBe(2);
    expect(report.stepsTotal).toBe(2);
    expect(report.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    // Each step ran through the headless path: one provider call per step.
    expect(server.requests.length).toBe(2);
  });

  it("streams a human-readable per-step report and exits 0", async () => {
    server.setResponses([
      { type: "text", content: "one" },
      { type: "text", content: "two" },
    ]);
    const home = homeWith(validWorkflows);
    const r = await runCli(
      ["--run-workflow", "ci-readonly", "--workspace", tmpRoot],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Step 1/2");
    expect(r.stdout).toContain("Step 2/2");
    expect(r.stdout).toContain('Workflow "ci-readonly": completed (2/2 steps');
  });

  it("exits 2 on an unknown workflow name", async () => {
    const home = homeWith(validWorkflows);
    const r = await runCli(["--run-workflow", "ghost", "--output", "json"], runEnv(home));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('workflow "ghost" is not defined');
  });

  it("halts on the first failing step; remaining steps do not run", async () => {
    // A persistent 500 fails the first step after the bounded retry budget; the
    // workflow must halt so the second step never executes.
    server.setResponses([
      { type: "text", failWith: { status: 500 } },
      { type: "text", failWith: { status: 500 } },
      { type: "text", failWith: { status: 500 } },
      { type: "text", failWith: { status: 500 } },
      { type: "text", failWith: { status: 500 } },
    ]);
    const home = homeWith({
      workflows: {
        contractVersion: 1,
        definitions: { wf: { steps: [{ prompt: "one" }, { prompt: "two" }] } },
      },
    });
    const r = await runCli(
      ["--run-workflow", "wf", "--output", "json", "--workspace", tmpRoot],
      runEnv(home),
      40_000,
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.result).toBe("failed");
    expect(report.stepsRun).toBe(1);
    expect(report.stepsTotal).toBe(2);
    expect(report.steps[0].ok).toBe(false);
  });

  it("redacts secrets and home paths in the run output", async () => {
    server.setResponses([{ type: "text", content: "done" }]);
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    // Low-entropy fake token: still matches the redactor's `sk-<16+ alnum>`
    // pattern, but stays well under gitleaks' entropy threshold so CI's secret
    // scan does not flag this fixture as a leaked credential.
    const decoy = "sk-aaaaaaaaaaaaaaaaaaaa";
    const secretPath = path.join(home, ".ssh", "id_rsa");
    fs.writeFileSync(
      path.join(home, ".oh-my-cli", "settings.json"),
      JSON.stringify({
        workflows: {
          contractVersion: 1,
          definitions: { wf: { steps: [{ prompt: `read ${secretPath} using ${decoy}` }] } },
        },
      }),
    );
    const r = await runCli(
      ["--run-workflow", "wf", "--output", "json", "--workspace", tmpRoot],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain(decoy);
    expect(combined).not.toContain(secretPath);
    expect(combined).not.toContain(home);
    const report = JSON.parse(r.stdout);
    expect(report.steps[0].prompt).toContain("[REDACTED]");
    expect(report.steps[0].prompt).toContain("~");
  });
});
