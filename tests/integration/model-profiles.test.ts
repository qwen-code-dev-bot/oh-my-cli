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

describe("Integration: model profiles", () => {
  let server: FakeServer;
  let tmpRoot: string;
  // Base env with the OPENAI_* variables explicitly blanked so the host
  // environment cannot leak into profile-driven cases (an empty value is treated
  // as unset by the resolver).
  let noOpenaiEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-profiles-int-"));
    noOpenaiEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.setResponse({ type: "text", content: "ok" });
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function workspaceWith(settings: unknown): string {
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    fs.mkdirSync(path.join(ws, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return ws;
  }

  // --- Listing / validation (no provider needed) ---

  it("lists declared profiles as redacted JSON and exits 0", async () => {
    const home = homeWith({
      defaultProfile: "qwen",
      profiles: {
        qwen: { name: "qwen-model", baseUrl: "https://dashscope.example/v1", description: "primary" },
        local: { name: "llama", disabled: true },
      },
    });
    const r = await runCli(["--list-profiles", "--output", "json"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.defaultProfile).toBe("qwen");
    expect(report.profiles.map((p: { profile: string }) => p.profile)).toEqual(["local", "qwen"]);
    const qwen = report.profiles.find((p: { profile: string }) => p.profile === "qwen");
    expect(qwen.isDefault).toBe(true);
    expect(qwen.model).toBe("qwen-model");
  });

  it("emits a human-readable list by default", async () => {
    const home = homeWith({
      defaultProfile: "qwen",
      profiles: { qwen: { name: "qwen-model" }, local: { name: "llama", disabled: true } },
    });
    const r = await runCli(["--list-profiles"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Model Profiles");
    expect(r.stdout).toContain("Default:   qwen");
    expect(r.stdout).toContain("[disabled]");
  });

  it("reports an empty list (exit 0) when no profiles section exists", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--list-profiles"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Profiles:  (none)");
  });

  it("exits 2 (fail closed) on a raw credential field in a profile", async () => {
    const home = homeWith({ profiles: { qwen: { name: "m", apiKey: "leaked" } } });
    const r = await runCli(["--list-profiles"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
    expect(r.stdout + r.stderr).not.toContain("leaked");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith({ profiles: { qwen: { name: "m" } } });
    const r = await runCli(["--list-profiles", "--output", "yaml"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("does not honor a project-scope profiles section (user scope only)", async () => {
    // User scope has no profiles; the workspace's project file declares one.
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const ws = workspaceWith({ profiles: { evil: { name: "evil-model" } } });
    const r = await runCli(["--list-profiles", "--output", "json", "--workspace", ws], {
      ...noOpenaiEnv,
      HOME: home,
    });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.profiles).toEqual([]);
    expect(r.stdout).not.toContain("evil");
  });

  // --- Selection end-to-end via --preflight (real provider call) ---

  it("selects the model and endpoint from an explicitly chosen profile", async () => {
    const home = homeWith({
      profiles: {
        qwen: { name: "qwen-model", baseUrl: server.url, apiKeyEnv: "TEST_CRED" },
      },
    });
    const r = await runCli(["--preflight", "--profile", "qwen"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Provider connected");
    expect(r.stdout).toContain("qwen-model");
    // The redacted diagnostic names the profile and credential var, not the value.
    expect(r.stderr).toContain("Profile:    qwen");
    expect(r.stderr).toContain("Credential: TEST_CRED");
    expect(r.stderr).not.toContain("fake-key");
  });

  it("uses settings.defaultProfile when no --profile is given", async () => {
    const home = homeWith({
      defaultProfile: "qwen",
      profiles: { qwen: { name: "default-model", baseUrl: server.url, apiKeyEnv: "TEST_CRED" } },
    });
    const r = await runCli(["--preflight"], { ...noOpenaiEnv, HOME: home, TEST_CRED: "fake-key" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("default-model");
    expect(r.stderr).toContain("Profile:    qwen");
  });

  it("an explicit --profile overrides settings.defaultProfile", async () => {
    const home = homeWith({
      defaultProfile: "a",
      profiles: {
        a: { name: "model-a", baseUrl: server.url, apiKeyEnv: "TEST_CRED" },
        b: { name: "model-b", baseUrl: server.url, apiKeyEnv: "TEST_CRED" },
      },
    });
    const r = await runCli(["--preflight", "--profile", "b"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("model-b");
    expect(r.stdout).not.toContain("model-a");
  });

  it("fails before any request on an unknown profile name", async () => {
    const home = homeWith({ profiles: { qwen: { name: "m", baseUrl: server.url, apiKeyEnv: "TEST_CRED" } } });
    const r = await runCli(["--preflight", "--profile", "ghost"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('profile "ghost" is not defined');
    expect(server.requests.length).toBe(0);
  });

  it("fails before any request on a disabled profile", async () => {
    const home = homeWith({
      profiles: { qwen: { name: "m", baseUrl: server.url, apiKeyEnv: "TEST_CRED", disabled: true } },
    });
    const r = await runCli(["--preflight", "--profile", "qwen"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('profile "qwen" is disabled');
    expect(server.requests.length).toBe(0);
  });

  it("fails when the selected profile's credential variable is unset", async () => {
    const home = homeWith({ profiles: { qwen: { name: "m", baseUrl: server.url, apiKeyEnv: "MISSING" } } });
    const r = await runCli(["--preflight", "--profile", "qwen"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("MISSING");
    expect(server.requests.length).toBe(0);
  });

  it("never reads a project-scope profile even for a trusted workspace", async () => {
    // The user-owned profile points at the good endpoint.
    const home = homeWith({
      profiles: { good: { name: "good-model", baseUrl: server.url, apiKeyEnv: "TEST_CRED" } },
    });
    // A trusted workspace drops a project profile pointing elsewhere; the profile
    // resolver reads only the user scope, so it must be ignored.
    const ws = workspaceWith({
      profiles: { evil: { name: "evil-model", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "X" } },
    });
    const r = await runCli(
      ["--preflight", "--profile", "good", "--workspace", ws, "--trust"],
      { ...noOpenaiEnv, HOME: home, TEST_CRED: "fake-key" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("good-model");
    expect(r.stdout + r.stderr).not.toContain("evil-model");
  });

  // --- Profile recorded in session history + resume explanation ---

  function sessionIdIn(home: string): string {
    const dir = path.join(home, ".oh-my-cli", "sessions");
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    return file.replace(".jsonl", "");
  }

  const twoProfiles = () => ({
    profiles: {
      qwen: { name: "qwen-model", baseUrl: server.url, apiKeyEnv: "TEST_CRED" },
      local: { name: "local-model", baseUrl: server.url, apiKeyEnv: "TEST_CRED" },
    },
  });

  it("records the selected profile in the new session's metadata", async () => {
    const home = homeWith(twoProfiles());
    const r = await runCli(["--profile", "qwen", "-p", "hello"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(r.code).toBe(0);
    const metaLine = fs
      .readFileSync(path.join(home, ".oh-my-cli", "sessions", `${sessionIdIn(home)}.jsonl`), "utf-8")
      .split("\n")
      .find((l) => l.includes('"meta":true'));
    expect(metaLine).toBeDefined();
    const meta = JSON.parse(metaLine!);
    expect(meta.profile).toBe("qwen");
    expect(meta.model).toBe("qwen-model");
  });

  it("explains a profile and model change when resuming, preserving history", async () => {
    const home = homeWith(twoProfiles());
    const first = await runCli(["--profile", "qwen", "-p", "first turn"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(first.code).toBe(0);
    const id = sessionIdIn(home);

    const resumed = await runCli(["--resume", id, "--profile", "local", "-p", "second turn"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toContain("changed model configuration");
    expect(resumed.stderr).toContain("model qwen-model → local-model");
    expect(resumed.stderr).toContain("profile qwen → local");
    expect(resumed.stderr).toContain("history are preserved");
  });

  it("does not warn when resuming under the same profile", async () => {
    const home = homeWith(twoProfiles());
    const first = await runCli(["--profile", "qwen", "-p", "first turn"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(first.code).toBe(0);
    const id = sessionIdIn(home);

    const resumed = await runCli(["--resume", id, "--profile", "qwen", "-p", "second turn"], {
      ...noOpenaiEnv,
      HOME: home,
      TEST_CRED: "fake-key",
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).not.toContain("changed model configuration");
  });
});

describe("Integration: profiles are protected in the effective-settings hierarchy", () => {
  let tmpRoot: string;
  let noOpenaiEnv: Record<string, string>;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-profiles-eff-"));
    noOpenaiEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
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

  function workspaceWith(settings: unknown): string {
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    fs.mkdirSync(path.join(ws, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return ws;
  }

  it("rejects a trusted project scope that sets profiles (exit 2)", async () => {
    const home = homeWith({ model: { name: "user-model" } });
    const ws = workspaceWith({ profiles: { evil: { name: "evil-model" } } });
    const r = await runCli(["--effective-settings", "--workspace", ws, "--trust"], {
      ...noOpenaiEnv,
      HOME: home,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"profiles"');
  });

  it("rejects a trusted project scope that sets defaultProfile (exit 2)", async () => {
    const home = homeWith({ model: { name: "user-model" } });
    const ws = workspaceWith({ defaultProfile: "evil" });
    const r = await runCli(["--effective-settings", "--workspace", ws, "--trust"], {
      ...noOpenaiEnv,
      HOME: home,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"defaultProfile"');
  });

  it("accepts profiles in the user scope and reports them in the snapshot", async () => {
    const home = homeWith({
      defaultProfile: "qwen",
      profiles: { qwen: { name: "qwen-model" } },
    });
    const r = await runCli(["--effective-settings", "--output", "json"], { ...noOpenaiEnv, HOME: home });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.merged.defaultProfile).toBe("qwen");
    expect(parsed.provenance.defaultProfile).toBe("user");
  });
});
