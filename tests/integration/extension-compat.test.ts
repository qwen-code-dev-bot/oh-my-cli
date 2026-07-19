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

const PROVIDER_SECTION = {
  contractVersion: 1,
  default: "primary",
  entries: [{ id: "primary", model: "model-a", apiKeyEnv: "KEY_A" }],
};

function surface(report: { surfaces: Array<Record<string, unknown>> }, kind: string) {
  return report.surfaces.find((s) => s.kind === kind) as Record<string, unknown>;
}

describe("Integration: extension compatibility", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-ext-compat-int-"));
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

  it("publishes the supported matrix and verdicts as redacted JSON and exits 0", async () => {
    const home = homeWith({
      providers: PROVIDER_SECTION,
      tools: { contractVersion: 99, entries: [{ id: "rg", command: "node", args: ["should-not-appear"] }] },
    });
    const r = await runCli(["--extension-compat", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.extension-compat");
    expect(report.version).toBe(1);
    expect(report.surfaces.map((s: Record<string, unknown>) => s.kind)).toEqual([
      "provider",
      "tool",
      "mcp",
      "workflow",
    ]);
    // The supported matrix is published for every surface.
    for (const s of report.surfaces as Array<Record<string, unknown>>) {
      expect(s.supportedVersions).toEqual([1]);
    }
    expect(surface(report, "provider").verdict).toBe("compatible");
    const tool = surface(report, "tool");
    expect(tool.verdict).toBe("incompatible");
    expect(tool.declaredVersion).toBe(99);
    expect(surface(report, "mcp").verdict).toBe("absent");
    expect(surface(report, "workflow").verdict).toBe("absent");
    // Redaction: argument values never appear in output.
    expect(r.stdout + r.stderr).not.toContain("should-not-appear");
  });

  it("reports a compatible settings file with exit 0", async () => {
    const home = homeWith({ providers: PROVIDER_SECTION });
    const r = await runCli(["--extension-compat", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    expect(surface(JSON.parse(r.stdout), "provider").verdict).toBe("compatible");
  });

  it("reports an unsupported version as the incompatible verdict (audit, not gate) and still exits 0", async () => {
    const home = homeWith({
      providers: { contractVersion: 99, entries: [{ id: "a", model: "m", apiKeyEnv: "K" }] },
    });
    const r = await runCli(["--extension-compat", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const provider = surface(JSON.parse(r.stdout), "provider");
    expect(provider.verdict).toBe("incompatible");
    expect(provider.declaredVersion).toBe(99);
  });

  it("reports every surface absent (exit 0) when the settings file is missing", async () => {
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const r = await runCli(["--extension-compat", "--output", "json"], { HOME: emptyHome });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.settingsFound).toBe(false);
    for (const kind of ["provider", "tool", "mcp", "workflow"]) {
      expect(surface(report, kind).verdict).toBe("absent");
    }
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith({ providers: PROVIDER_SECTION });
    const r = await runCli(["--extension-compat"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Extension Compatibility");
    expect(r.stdout).toContain("Provider contract: compatible");
    expect(r.stdout).toContain("Supported: 1");
    expect(r.stdout).toContain("MCP contract: absent");
  });

  it("honors an explicit --settings path", async () => {
    const custom = path.join(tmpRoot, "explicit.json");
    fs.writeFileSync(custom, JSON.stringify({ providers: PROVIDER_SECTION }));
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty2-"));
    const r = await runCli(["--extension-compat", "--settings", custom, "--output", "json"], {
      HOME: emptyHome,
    });
    expect(r.code).toBe(0);
    expect(surface(JSON.parse(r.stdout), "provider").verdict).toBe("compatible");
  });

  it("exits 2 (fail closed) on invalid JSON", async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "badjson-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), "{ not valid json");
    const r = await runCli(["--extension-compat"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid JSON");
  });

  it("exits 2 (fail closed) on a non-object settings root", async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "nonobj-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), "[1, 2, 3]");
    const r = await runCli(["--extension-compat"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must contain a JSON object");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith({ providers: PROVIDER_SECTION });
    const r = await runCli(["--extension-compat", "--output", "yaml"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
