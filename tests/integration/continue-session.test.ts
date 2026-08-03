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

describe("Integration: --continue resumes the most recent workspace session (#513)", () => {
  let server: FakeServer;
  let homeDir: string;
  let wsDir: string;
  let otherWsDir: string;
  let emptyWsDir: string;
  let baseEnv: Record<string, string>;
  let olderId: string;
  let targetId: string;
  let foreignId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continue-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continue-ws-"));
    otherWsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continue-other-"));
    emptyWsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continue-empty-"));

    // Seed three sessions: two for the current workspace (one older) and a
    // newer one declared for a different workspace. The foreign session is the
    // most recent overall, so selecting it would mean the workspace scope was
    // violated.
    const store = new SessionStore(sessionsDir());
    const now = Date.now();

    olderId = store.newId();
    store.checkpoint(
      olderId,
      [
        { role: "user", content: "older turn" },
        { role: "assistant", content: "older answer" },
      ],
      { model: "fake-model", workspace: wsDir, createdAt: now - 200_000 },
    );

    targetId = store.newId();
    store.checkpoint(
      targetId,
      [
        { role: "user", content: "first user turn" },
        { role: "assistant", content: "first answer" },
      ],
      { model: "fake-model", workspace: wsDir, createdAt: now - 100_000 },
    );

    foreignId = store.newId();
    store.checkpoint(
      foreignId,
      [{ role: "user", content: "foreign turn" }],
      { model: "fake-model", workspace: otherWsDir, createdAt: now },
    );

    fs.utimesSync(store.filePath(olderId), new Date(now - 200_000), new Date(now - 200_000));
    fs.utimesSync(store.filePath(targetId), new Date(now - 100_000), new Date(now - 100_000));
    fs.utimesSync(store.filePath(foreignId), new Date(now), new Date(now));

    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    for (const dir of [homeDir, wsDir, otherWsDir, emptyWsDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues the most recent healthy session for the workspace, carrying its history", async () => {
    server.setResponse({ type: "text", content: "second answer" });
    const r = await runCli(
      ["--continue", "-p", "second turn", "--output", "json", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    // The selection is explicit and names the target session (not the newer
    // foreign one).
    expect(r.stderr).toContain("Continuing session");
    expect(r.stderr).toContain(targetId.split("-")[0]);
    expect(r.stderr).not.toContain(foreignId.split("-")[0]);

    // The resumed history reached the provider alongside the new prompt.
    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("first user turn");
    expect(contents).toContain("first answer");
    expect(contents).toContain("second turn");
    expect(contents).not.toContain("foreign turn");
    expect(contents).not.toContain("older turn");

    // The run sealed back into the same session.
    const after = new SessionStore(sessionsDir()).load(targetId);
    expect(after.some((m) => m.content === "second turn")).toBe(true);
    expect(after.some((m) => m.content === "second answer")).toBe(true);
  });

  it("fails closed when the workspace has no resumable session", async () => {
    const sessionCountBefore = fs.readdirSync(sessionsDir()).length;
    const requestCountBefore = server.requests.length;
    const r = await runCli(
      ["--continue", "-p", "hello", "--output", "json", "--workspace", emptyWsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot continue: no resumable session found for this workspace");
    expect(r.stderr).toContain("--list-sessions");
    // Nothing was created, resumed, or sent to the provider.
    expect(fs.readdirSync(sessionsDir()).length).toBe(sessionCountBefore);
    expect(server.requests.length).toBe(requestCountBefore);
  });

  it("refuses to combine --continue with --resume", async () => {
    const r = await runCli(
      ["--continue", "--resume", targetId, "-p", "hello", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--continue cannot be combined with --resume or --browse-sessions");
  });
});
