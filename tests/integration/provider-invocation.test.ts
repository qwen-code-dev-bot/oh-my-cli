import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startMockServer } from "../fixtures/openai-mock-server.mjs";

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

describe("Integration: provider extension invocation", () => {
  let tmpRoot: string;
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-provider-invoke-int-"));
    server = await startMockServer();
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // A home dir with a settings.json declaring one provider whose endpoint is the
  // local mock server; `model` selects the mock's behavior for each case.
  function homeWith(model: string): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    const settings = {
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", baseUrl: server.baseUrl, model, apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    };
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function workspace(): string {
    return fs.mkdtempSync(path.join(tmpRoot, "ws-"));
  }

  const cred = { TEST_PROVIDER_KEY: "sk-test" };

  it("issues one bounded request to a ready provider (yolo) and exits 0", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "hello", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("ok"), ...cred },
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.provider-invocation");
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.outcome).toBe("called");
    expect(report.content).toBe("hello");
    expect(report.totalTokens).toBe(8);
  });

  it("fails closed (exit 1) on an empty response", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("empty"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("passed");
    expect(report.outcome).toBe("empty");
  });

  it("maps a 401 to auth-rejected (exit 1)", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("auth"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("auth-rejected");
    expect(report.status).toBe(401);
  });

  it("maps a 404 referencing the model to unsupported-model (exit 1)", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("nomodel"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("unsupported-model");
    expect(report.status).toBe(404);
  });

  it("maps a 429 to rate-limited (exit 1)", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("ratelimit"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("rate-limited");
    expect(report.status).toBe(429);
  });

  it("enforces the hard timeout against a hanging endpoint and exits 1", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--invoke-timeout", "300", "--output", "json"],
      { HOME: homeWith("hang"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.timedOut).toBe(true);
    expect(report.outcome).toBe("timeout");
  });

  it("caps an oversized response and exits 1", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("flood"), ...cred },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outputCapped).toBe(true);
    expect(report.outcome).toBe("output-capped");
  });

  it("redacts secrets in the captured response", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("secret"), ...cred },
    );
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(combined).toContain("[REDACTED]");
  });

  it("never prints the credential value", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("ok"), TEST_PROVIDER_KEY: "sk-super-secret-value" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("sk-super-secret-value");
    const report = JSON.parse(r.stdout);
    expect(report.credentialVariable).toBe("TEST_PROVIDER_KEY");
  });

  it("refuses a provider whose credential is not set and exits 2", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("ok") },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
  });

  it("refuses an unapproved provider under the default mode and exits 2", async () => {
    const r = await runCli(
      ["--invoke-provider", "--workspace", workspace(), "--output", "json"],
      { HOME: homeWith("ok"), ...cred },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
  });

  it("emits a human-readable text report by default", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: homeWith("ok"), ...cred },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Provider:");
    expect(r.stdout).toContain("Gate:");
    expect(r.stdout).toContain("oh-my-cli.provider-invocation");
  });

  it("exits 2 when the settings file has no providers section", async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".oh-my-cli", "settings.json"),
      JSON.stringify({ model: { name: "m", apiKeyEnv: "K" } }),
    );
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: home, ...cred },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.providers section");
  });

  it("exits 2 on an invalid output format", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "yaml"],
      { HOME: homeWith("ok"), ...cred },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("exits 2 on an invalid approval mode", async () => {
    const r = await runCli(
      ["--invoke-provider", "--approval-mode", "rubber-stamp", "--workspace", workspace()],
      { HOME: homeWith("ok"), ...cred },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid approval mode");
  });
});
