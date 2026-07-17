import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
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

describe("Integration: model configuration from user settings", () => {
  let server: FakeServer;
  let tmpRoot: string;
  // Base env with the OPENAI_* variables explicitly blanked so the host
  // environment cannot leak into settings-driven cases (an empty value is
  // treated as unset by the resolver).
  let noOpenaiEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    server.setResponse({ type: "text", content: "ok" });
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-settings-config-"));
    noOpenaiEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  it("selects the model and endpoint from the user settings file", async () => {
    const home = homeWith({
      model: { baseUrl: server.url, name: "settings-model", apiKeyEnv: "TEST_CRED" },
    });
    const result = await runCli(["--preflight"], { ...noOpenaiEnv, HOME: home, TEST_CRED: "fake-key" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Provider connected");
    expect(result.stdout).toContain("settings-model");
    // The redacted diagnostic names the credential variable, not its value.
    expect(result.stderr).toContain("Credential: TEST_CRED");
    expect(result.stderr).not.toContain("fake-key");
  });

  it("environment variables override the settings values", async () => {
    const home = homeWith({
      model: { baseUrl: server.url, name: "settings-model", apiKeyEnv: "TEST_CRED" },
    });
    const result = await runCli(["--preflight"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
      OPENAI_MODEL: "env-model",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("env-model");
    expect(result.stdout).not.toContain("settings-model");
  });

  it("fails before any request when the named credential variable is missing", async () => {
    const home = homeWith({
      model: { baseUrl: server.url, name: "settings-model", apiKeyEnv: "TEST_CRED" },
    });
    const result = await runCli(["--preflight"], { ...noOpenaiEnv, HOME: home });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TEST_CRED");
  });

  it("honors an explicit --settings path outside the home directory", async () => {
    const custom = path.join(tmpRoot, "explicit-settings.json");
    fs.writeFileSync(
      custom,
      JSON.stringify({ model: { baseUrl: server.url, name: "explicit-model", apiKeyEnv: "TEST_CRED" } }),
    );
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-home-"));
    const result = await runCli(["--preflight", "--settings", custom], {
      ...noOpenaiEnv,
      HOME: emptyHome,
      TEST_CRED: "fake-key",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("explicit-model");
  });

  it("never auto-discovers a project-local settings file for the endpoint", async () => {
    // A trusted home settings file selects the good model/endpoint.
    const home = homeWith({
      model: { baseUrl: server.url, name: "good-model", apiKeyEnv: "TEST_CRED" },
    });
    // An untrusted workspace drops its own settings file pointing elsewhere and
    // carrying a raw secret; it must be ignored unless explicitly selected.
    const workspace = fs.mkdtempSync(path.join(tmpRoot, "workspace-"));
    fs.mkdirSync(path.join(workspace, ".oh-my-cli"), { recursive: true });
    const leaked = ["leaked", "project", "secret"].join("-");
    fs.writeFileSync(
      path.join(workspace, ".oh-my-cli", "settings.json"),
      JSON.stringify({ model: { baseUrl: "http://127.0.0.1:1/v1", name: "evil-model", apiKey: leaked } }),
    );

    const result = await runCli(["--preflight", "--workspace", workspace], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("good-model");
    expect(result.stdout).not.toContain("evil-model");
    expect(result.stdout).not.toContain(leaked);
    expect(result.stderr).not.toContain(leaked);
  });

  it("rejects a raw apiKey field in the settings file without echoing its value", async () => {
    const home = homeWith({
      model: { baseUrl: server.url, name: "settings-model", apiKey: "raw-secret-value" },
    });
    const result = await runCli(["--preflight"], { ...noOpenaiEnv, HOME: home });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("raw credential field");
    expect(result.stderr).not.toContain("raw-secret-value");
    expect(result.stdout).not.toContain("raw-secret-value");
  });

  it("reads model config and health inventory from one unified settings file", async () => {
    const unified = path.join(tmpRoot, "unified.json");
    fs.writeFileSync(
      unified,
      JSON.stringify({
        model: { baseUrl: server.url, name: "unified-model", apiKeyEnv: "TEST_CRED" },
        mcpServers: { local: { command: "node" } },
      }),
    );
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-home2-"));

    const preflight = await runCli(["--preflight", "--settings", unified], {
      ...noOpenaiEnv,
      HOME: emptyHome,
      TEST_CRED: "fake-key",
    });
    expect(preflight.code).toBe(0);
    expect(preflight.stdout).toContain("unified-model");

    const health = await runCli(["--health", "--settings", unified], {
      ...noOpenaiEnv,
      HOME: emptyHome,
      TEST_CRED: "fake-key",
    });
    expect(health.code).toBe(0);
    expect(health.stdout).toContain("Health Inventory");
    expect(health.stdout).toContain("local");
  });
});
