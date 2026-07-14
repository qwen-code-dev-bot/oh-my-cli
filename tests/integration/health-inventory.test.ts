import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 10_000,
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

describe("Integration: health inventory", () => {
  let server: FakeServer;
  let hangingServer: http.Server;
  let hangingUrl: string;
  let tmpDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();

    // A server that accepts the connection but responds only after a long delay,
    // so a bounded probe aborts first. The timer is cleared when the client
    // aborts and the socket closes, avoiding a late write to a dead socket.
    hangingServer = http.createServer((_req, res) => {
      const t = setTimeout(() => {
        if (!res.destroyed) res.end("late");
      }, 4000);
      res.on("close", () => clearTimeout(t));
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
    const addr = hangingServer.address() as AddressInfo;
    hangingUrl = `http://127.0.0.1:${addr.port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-health-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: tmpDir,
    };
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSettings(name: string, obj: unknown): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("reports a reachable http MCP server as healthy", async () => {
    const settings = writeSettings("healthy.json", {
      probeTimeoutMs: 2000,
      mcpServers: { reach: { url: server.url } },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Health Inventory");
    expect(result.stdout).toContain("reach");
    expect(result.stdout).toContain("healthy");
    expect(result.stdout).toContain("reachable");
  });

  it("reports a hanging http MCP server as unavailable (timeout)", async () => {
    const settings = writeSettings("timeout.json", {
      probeTimeoutMs: 300,
      mcpServers: { slow: { url: hangingUrl } },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.stdout).toContain("slow");
    expect(result.stdout).toContain("unavailable");
    expect(result.stdout).toContain("timed out");
  });

  it("reports a disabled integration without probing it", async () => {
    const settings = writeSettings("disabled.json", {
      mcpServers: { legacy: { command: "node", enabled: false } },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.stdout).toContain("legacy");
    expect(result.stdout).toContain("disabled");
  });

  it("reports a malformed integration as misconfigured", async () => {
    const settings = writeSettings("malformed.json", {
      mcpServers: { broken: { args: ["--no-command"] } },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.stdout).toContain("broken");
    expect(result.stdout).toContain("misconfigured");
  });

  it("reports a resolvable stdio command as healthy", async () => {
    const settings = writeSettings("stdio.json", {
      mcpServers: { local: { command: "node" } },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.stdout).toContain("local");
    expect(result.stdout).toContain("healthy");
    expect(result.stdout).toContain("command resolved");
  });

  it("does not leak credentials from urls or env values", async () => {
    const user = "alice";
    const pass = ["s3", "cr3t"].join("");
    const tokenValue = ["tok", "secret", "value"].join("");
    const settings = writeSettings("secrets.json", {
      mcpServers: {
        cred: { url: `http://${user}:${pass}@127.0.0.1:1/` },
        withenv: { command: "node", env: { SECRET_TOKEN: tokenValue } },
      },
    });
    const result = await runCli(["--health", "--settings", settings], baseEnv);
    expect(result.stdout).not.toContain(pass);
    expect(result.stdout).not.toContain(tokenValue);
    expect(result.stdout).not.toContain(`${user}:${pass}`);
  });

  it("reports no integrations when the settings file is absent", async () => {
    const result = await runCli(
      ["--health", "--settings", path.join(tmpDir, "does-not-exist.json")],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No settings file found");
  });

  it("shows --health in help", async () => {
    const result = await runCli(["--help"], baseEnv);
    expect(result.stdout).toContain("--health");
  });
});
