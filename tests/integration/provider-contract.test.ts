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

describe("Integration: provider extension contract", () => {
  let tmpRoot: string;
  let cleanEnv: Record<string, string>;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-provider-contract-int-"));
    // Blank the OPENAI_* variables so the host environment cannot leak into the
    // resolved contract (an empty value is treated as unset).
    cleanEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
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

  const validProviders = {
    providers: {
      contractVersion: 1,
      default: "alt",
      entries: [
        {
          id: "alt",
          baseUrl: "https://user:pw@alt.example/secret?token=abc",
          model: "alt-model",
          models: ["alt-small", "alt-large"],
          apiKeyEnv: "ALT_KEY",
          capabilities: { vision: true },
        },
      ],
    },
  };

  it("resolves the default provider as redacted JSON and exits 0", async () => {
    const home = homeWith(validProviders);
    const r = await runCli(["--provider-contract", "--output", "json"], {
      ...cleanEnv,
      HOME: home,
      ALT_KEY: "sk-secret-value",
    });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.provider-contract");
    expect(report.providerId).toBe("alt");
    expect(report.endpoint).toBe("alt.example");
    expect(report.modelCatalog).toEqual(["alt-small", "alt-large"]);
    expect(report.credentialAvailable).toBe(true);
    // Redaction: no secret, userinfo, path, query, or raw credential value.
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("sk-secret-value");
    expect(combined).not.toContain("user:pw");
    expect(combined).not.toContain("secret");
    expect(combined).not.toContain("token=abc");
  });

  it("selects a specific provider via --provider", async () => {
    const home = homeWith({
      providers: {
        contractVersion: 1,
        entries: [
          { id: "one", model: "m1", apiKeyEnv: "K1" },
          { id: "two", model: "m2", apiKeyEnv: "K2" },
        ],
      },
    });
    const r = await runCli(["--provider-contract", "--provider", "two", "--output", "json"], {
      ...cleanEnv,
      HOME: home,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).providerId).toBe("two");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith(validProviders);
    const r = await runCli(["--provider-contract"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Provider:");
    expect(r.stdout).toContain("alt-model");
  });

  it("honors an explicit --settings path", async () => {
    const custom = path.join(tmpRoot, "explicit.json");
    fs.writeFileSync(custom, JSON.stringify(validProviders));
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const r = await runCli(["--provider-contract", "--settings", custom, "--output", "json"], {
      ...cleanEnv,
      HOME: emptyHome,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).providerId).toBe("alt");
  });

  it("exits 2 when the settings file has no providers section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--provider-contract"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.providers section");
  });

  it("exits 2 (fail closed) on an unsupported contract version", async () => {
    const home = homeWith({ providers: { contractVersion: 99, entries: [{ id: "a", model: "m" }] } });
    const r = await runCli(["--provider-contract"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 on an unknown provider id", async () => {
    const home = homeWith(validProviders);
    const r = await runCli(["--provider-contract", "--provider", "ghost"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ghost");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith(validProviders);
    const r = await runCli(["--provider-contract", "--output", "yaml"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
