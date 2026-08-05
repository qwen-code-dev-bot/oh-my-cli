import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

describe("Integration: --continue discovery semantics (Issue #616)", () => {
  let server: FakeServer;
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-616i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-616i-ws-"));
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

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  // Seed a session with an explicit mtime age (seconds back from now).
  function seed(content: string, ageSeconds: number): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content },
        { role: "assistant", content: `${content} answer` },
      ],
      { model: "fake-model", workspace: wsDir, createdAt: Date.now() - ageSeconds * 1000 },
    );
    const t = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  it("skips an archived newest session and continues the older healthy one", async () => {
    const older = seed("older mission", 3600);
    const newest = seed("retired scratch", 10);
    store.writeArchived(newest, Date.now());

    server.setResponse({ type: "text", content: "continued older" });
    const r = await runCli(
      ["--continue", "-p", "next turn", "--output", "json", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("Continuing session");
    expect(r.stderr).toContain(older.split("-")[0]);
    expect(r.stderr).not.toContain(newest.split("-")[0]);

    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("older mission");
    expect(contents).not.toContain("retired scratch");
  });

  it("continues a pinned older session over a newer unpinned one", async () => {
    const older = seed("pinned mission", 3600);
    seed("fresh scratch", 10);
    store.writePinned(older, Date.now());

    server.setResponse({ type: "text", content: "continued pinned" });
    const r = await runCli(
      ["--continue", "-p", "next turn", "--output", "json", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toContain(older.split("-")[0]);

    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("pinned mission");
    expect(contents).not.toContain("fresh scratch");
  });

  it("a pinned-and-archived session is never picked; archive prevails", async () => {
    const retired = seed("retired pinned", 10);
    store.writePinned(retired, Date.now());
    store.writeArchived(retired, Date.now());

    const r = await runCli(
      ["--continue", "-p", "next turn", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot continue");
    expect(r.stderr).toContain("no resumable session found");
  });

  it("unpinning restores pure recency selection", async () => {
    const older = seed("was pinned", 3600);
    const newer = seed("now newest", 10);
    store.writePinned(older, Date.now());
    store.clearPinned(older);

    server.setResponse({ type: "text", content: "continued newest" });
    const r = await runCli(
      ["--continue", "-p", "next turn", "--output", "json", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toContain(newer.split("-")[0]);
  });
});
