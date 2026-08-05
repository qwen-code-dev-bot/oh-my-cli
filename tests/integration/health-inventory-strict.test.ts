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

// Probe latency ("resolved in Nms") varies between runs, so normalize it
// before byte-comparing outputs of probed integrations.
function normalizeProbeMs(out: string): string {
  return out
    .replace(/in \d+ms/g, "in <probe-ms>")
    .replace(/\[\d+ms\]/g, "[<probe-ms>]");
}

describe("Integration: health inventory strict exit (--strict, Issue #690)", () => {
  let homeDir: string;
  let settingsPath: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-690i-home-"));
    settingsPath = path.join(homeDir, "settings.json");
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(settingsPath, { force: true });
  });

  function writeSettings(content: string): void {
    fs.writeFileSync(settingsPath, content);
  }

  it("exits 0 on a healthy-only inventory with and without --strict, output identical", async () => {
    writeSettings(JSON.stringify({ mcpServers: { ok: { command: "node" } } }));
    const plain = await runCli(["--health", "--settings", settingsPath], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("healthy");

    const strict = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(normalizeProbeMs(strict.stdout)).toBe(normalizeProbeMs(plain.stdout));
  });

  it("exits 1 under --strict for a misconfigured entry, 0 without, output identical", async () => {
    writeSettings(JSON.stringify({ mcpServers: { bad: { url: "not-a-url" } } }));
    const strict = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("misconfigured");

    const plain = await runCli(["--health", "--settings", settingsPath], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
  });

  it("exits 1 under --strict for a failing command probe", async () => {
    writeSettings(
      JSON.stringify({ mcpServers: { gone: { command: "omc-690-no-such-binary" } } }),
    );
    const res = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("unavailable");
  });

  it("exits 0 under --strict when every integration is disabled", async () => {
    writeSettings(
      JSON.stringify({
        mcpServers: { off: { command: "omc-690-no-such-binary", enabled: false } },
        extensions: { alsoOff: { path: "/nonexistent", enabled: false } },
      }),
    );
    const res = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("2 disabled");
  });

  it("exits 0 under --strict when no settings file exists", async () => {
    const res = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No settings file found; no integrations configured.");
  });

  it("exits 1 under --strict when the settings file is unparseable", async () => {
    writeSettings("{ this is not json");
    const res = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Settings error: invalid JSON");
  });

  it("keeps the settings byte-identical through strict runs", async () => {
    writeSettings(JSON.stringify({ mcpServers: { bad: { url: "not-a-url" } } }));
    const before = fs.readFileSync(settingsPath, "utf-8");
    const res = await runCli(["--health", "--settings", settingsPath, "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});
