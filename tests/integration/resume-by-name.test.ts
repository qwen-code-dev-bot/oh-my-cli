import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { createFakeServer, type FakeServer } from "../fake-provider.js";

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

describe("Integration: --resume accepts a user-owned session name (#534)", () => {
  let server: FakeServer;
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-resume-name-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-resume-name-ws-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  function seedSession(history: Array<{ role: "user" | "assistant"; content: string }>): string {
    const store = new SessionStore(sessionsDir());
    const id = store.newId();
    store.checkpoint(id, history, {
      model: "fake-model",
      workspace: wsDir,
      createdAt: Date.now(),
    });
    return id;
  }

  it("resumes a uniquely named session and carries its history", async () => {
    const id = seedSession([
      { role: "user", content: "remember the lighthouse" },
      { role: "assistant", content: "noted" },
    ]);
    const store = new SessionStore(sessionsDir());
    store.writeName(id, "auth refactor");

    server.setResponse({ type: "text", content: "resumed by name" });
    const before = server.requests.length;
    const r = await runCli(
      ["--resume", "auth refactor", "-p", "continue the work", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("resumed by name");

    // The resumed history reached the provider alongside the new prompt.
    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("remember the lighthouse");
    expect(contents).toContain("noted");
    expect(contents).toContain("continue the work");
    expect(server.requests.length).toBe(before + 1);
  });

  it("an exact session id wins over a same-value name", async () => {
    const alpha = seedSession([{ role: "user", content: "alpha history" }]);
    const beta = seedSession([{ role: "user", content: "beta history" }]);
    // Session alpha carries a name that IS beta's id: resuming by that id
    // must still land on beta (id resolution comes first).
    const store = new SessionStore(sessionsDir());
    store.writeName(alpha, beta);

    server.setResponse({ type: "text", content: "id wins" });
    const r = await runCli(
      ["--resume", beta, "-p", "next", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("beta history");
    expect(contents).not.toContain("alpha history");
  });

  it("fails closed on an ambiguous name, listing the matching short ids", async () => {
    const a = seedSession([{ role: "user", content: "one" }]);
    const b = seedSession([{ role: "user", content: "two" }]);
    const store = new SessionStore(sessionsDir());
    store.writeName(a, "dup name");
    store.writeName(b, "dup name");

    const before = server.requests.length;
    const r = await runCli(
      ["--resume", "dup name", "-p", "next", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("2 sessions are named");
    expect(r.stderr).toContain(a.split("-")[0]);
    expect(r.stderr).toContain(b.split("-")[0]);
    // Nothing reached the provider.
    expect(server.requests.length).toBe(before);
  });

  it("fails closed for an unknown value without starting fresh", async () => {
    const before = server.requests.length;
    const r = await runCli(
      ["--resume", "no such session", "-p", "next", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no session named");
    expect(server.requests.length).toBe(before);
  });
});
