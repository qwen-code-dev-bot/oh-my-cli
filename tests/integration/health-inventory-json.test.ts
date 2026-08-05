import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

// Probe latency varies between runs; strip it before byte/deep comparisons.
function stripProbeMs(stdout: string): unknown {
  return JSON.parse(stdout, (k, v) => (k === "probeMs" ? undefined : v));
}

function normalizeProbeMsText(out: string): string {
  return out.replace(/in \d+ms/g, "in <probe-ms>").replace(/\[\d+ms\]/g, "[<probe-ms>]");
}

describe("Integration: health inventory json output (--output json, Issue #694)", () => {
  let homeDir: string;
  let settingsPath: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-694i-home-"));
    settingsPath = path.join(homeDir, "settings.json");
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(settingsPath, { force: true });
  });

  it("emits one parseable document with all expected fields", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: { ok: { command: "node" } },
        extensions: { off: { path: "/nonexistent", enabled: false } },
      }),
    );
    const res = await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    const record = JSON.parse(res.stdout);
    expect(record.schema).toBe("oh-my-cli.health-inventory");
    expect(record.v).toBe(1);
    expect(record.settingsFound).toBe(true);
    expect(typeof record.probeTimeoutMs).toBe("number");
    expect(record.integrations).toHaveLength(2);
    const mcp = record.integrations.find((i: { kind: string }) => i.kind === "mcp");
    expect(mcp.name).toBe("ok");
    expect(mcp.category).toBe("healthy");
    expect(typeof mcp.target).toBe("string");
    expect(mcp.enabled).toBe(true);
    expect(typeof mcp.reason).toBe("string");
    expect(typeof mcp.probeMs).toBe("number");
    const ext = record.integrations.find((i: { kind: string }) => i.kind === "extension");
    expect(ext.name).toBe("off");
    expect(ext.enabled).toBe(false);
    expect(ext.category).toBe("disabled");
  });

  it("keeps the default text output unchanged", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { ok: { command: "node" } } }));
    const plain = await runCli(["--health", "--settings", settingsPath], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("Health Inventory");
    expect(plain.stdout).toContain("ok");

    const strict = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(normalizeProbeMsText(strict.stdout)).toBe(normalizeProbeMsText(plain.stdout));
  });

  it("composes --strict with json: exit 1 on unhealthy, identical document", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { bad: { url: "not-a-url" } } }));
    const plain = await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);

    const strict = await runCli(
      ["--health", "--settings", settingsPath, "--output", "json", "--strict"],
      baseEnv,
    );
    expect(strict.code).toBe(1);
    expect(stripProbeMs(strict.stdout)).toStrictEqual(stripProbeMs(plain.stdout));
  });

  it("exits 0 under --strict --output json for a healthy inventory", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { ok: { command: "node" } } }));
    const res = await runCli(
      ["--health", "--settings", settingsPath, "--output", "json", "--strict"],
      baseEnv,
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).integrations[0].category).toBe("healthy");
  });

  it("exits 2 on a bad format before any output", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { ok: { command: "node" } } }));
    const res = await runCli(["--health", "--settings", settingsPath, "--output", "yaml"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('invalid output format "yaml"');
    expect(res.stdout).toBe("");
  });

  it("carries parseError and settingsFound false appropriately", async () => {
    fs.writeFileSync(settingsPath, "{ not json");
    const bad = await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.stdout).parseError).toBeDefined();

    fs.rmSync(settingsPath);
    const missing = await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    expect(missing.code).toBe(0);
    const record = JSON.parse(missing.stdout);
    expect(record.settingsFound).toBe(false);
    expect(record.parseError).toBeUndefined();
  });

  it("keeps the settings byte-identical through the runs", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { bad: { url: "not-a-url" } } }));
    const before = fs.readFileSync(settingsPath, "utf-8");
    await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    await runCli(["--health", "--settings", settingsPath, "--output", "json", "--strict"], baseEnv);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});
