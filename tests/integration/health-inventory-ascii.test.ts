import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { asciiSafeLine } from "../../src/ascii-output.js";
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

function stripProbeMs(stdout: string): unknown {
  return JSON.parse(stdout, (k, v) => (k === "probeMs" ? undefined : v));
}

function normalizeProbeMsText(out: string): string {
  return out.replace(/in \d+ms/g, "in <probe-ms>").replace(/\[\d+ms\]/g, "[<probe-ms>]");
}

const GLYPHS = /[✓✗⚠⊘─·×…→↔]/;

describe("Integration: health inventory ascii rendering (--ascii, Issue #696)", () => {
  let homeDir: string;
  let settingsPath: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-696i-home-"));
    settingsPath = path.join(homeDir, "settings.json");
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(settingsPath, { force: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          solid: { command: "node" },
          "bad-url": { url: "not-a-url" },
          "off-one": { command: "anything", enabled: false },
        },
      }),
    );
  });

  it("keeps the default text rendering with its glyphs", async () => {
    const res = await runCli(["--health", "--settings", settingsPath], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Health Inventory");
    expect(res.stdout).toContain("─".repeat(40));
    expect(res.stdout).toContain("✓");
    expect(res.stdout).toContain("⚠");
    expect(res.stdout).toContain("⊘");
  });

  it("maps every glyph under --ascii, leaving none behind", async () => {
    const res = await runCli(["--health", "--settings", settingsPath, "--ascii"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[ok]");
    expect(res.stdout).toContain("[warn]");
    expect(res.stdout).toContain("[off]");
    expect(GLYPHS.test(res.stdout)).toBe(false);
  });

  it("keeps the ascii text identical to the default modulo the glyph map", async () => {
    const plain = await runCli(["--health", "--settings", settingsPath], baseEnv);
    const ascii = await runCli(["--health", "--settings", settingsPath, "--ascii"], baseEnv);
    // The CLI's ascii path is exactly the glyph map applied per line.
    const mapped = normalizeProbeMsText(plain.stdout)
      .split("\n")
      .map((line) => asciiSafeLine(line))
      .join("\n");
    expect(mapped).toBe(normalizeProbeMsText(ascii.stdout));
  });

  it("leaves --output json unchanged by --ascii", async () => {
    const plain = await runCli(["--health", "--settings", settingsPath, "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const ascii = await runCli(
      ["--health", "--settings", settingsPath, "--output", "json", "--ascii"],
      baseEnv,
    );
    expect(ascii.code).toBe(0);
    expect(stripProbeMs(ascii.stdout)).toStrictEqual(stripProbeMs(plain.stdout));
  });

  it("composes --ascii with --strict: mapped output, exit 1 on unhealthy", async () => {
    const res = await runCli(
      ["--health", "--settings", settingsPath, "--ascii", "--strict"],
      baseEnv,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("[warn]");
    expect(GLYPHS.test(res.stdout)).toBe(false);
  });

  it("keeps the settings byte-identical through the runs", async () => {
    const before = fs.readFileSync(settingsPath, "utf-8");
    await runCli(["--health", "--settings", settingsPath], baseEnv);
    await runCli(["--health", "--settings", settingsPath, "--ascii"], baseEnv);
    await runCli(["--health", "--settings", settingsPath, "--ascii", "--strict"], baseEnv);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});
