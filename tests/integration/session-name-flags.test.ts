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

describe("Integration: session-targeted flags accept names (#536)", () => {
  let server: FakeServer;
  let homeDir: string;
  let wsDir: string;
  let outDir: string;
  let baseEnv: Record<string, string>;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-name-flags-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-name-flags-ws-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-name-flags-out-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };

    const store = new SessionStore(sessionsDir());
    sessionId = store.newId();
    store.checkpoint(
      sessionId,
      [
        { role: "user", content: "stats seed turn" },
        { role: "assistant", content: "stats seed answer" },
      ],
      { model: "fake-model", workspace: wsDir, createdAt: Date.now() },
    );
    store.writeName(sessionId, "flags target");
  });

  afterAll(async () => {
    await server.close();
    for (const dir of [homeDir, wsDir, outDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--session-stats resolves a name to the same session as its id", async () => {
    const byName = await runCli(
      ["--session-stats", "flags target", "--output", "json"],
      baseEnv,
    );
    expect(byName.code).toBe(0);
    const byId = await runCli(
      ["--session-stats", sessionId, "--output", "json"],
      baseEnv,
    );
    expect(byId.code).toBe(0);
    expect(JSON.parse(byName.stdout).sessionId).toBe(sessionId);
    expect(JSON.parse(byName.stdout)).toEqual(JSON.parse(byId.stdout));
  });

  it("--export-session exports by name", async () => {
    const r = await runCli(
      ["--export-session", "flags target", "--out", outDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(outDir, `${sessionId}.session-export.md`))).toBe(true);
    expect(
      fs.existsSync(path.join(outDir, `${sessionId}.session-export.manifest.json`)),
    ).toBe(true);
  });

  it("--compact compacts by name, preserving the original", async () => {
    const before = fs.readFileSync(
      path.join(sessionsDir(), `${sessionId}.jsonl`),
      "utf-8",
    );
    const r = await runCli(["--compact", "flags target"], baseEnv);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir(), `${sessionId}.compact.json`))).toBe(true);
    // The original checkpoint is untouched.
    expect(fs.readFileSync(path.join(sessionsDir(), `${sessionId}.jsonl`), "utf-8")).toBe(before);
  });

  it("a mutating flag fails closed for an unknown name with no side effects", async () => {
    const otherId = (() => {
      const store = new SessionStore(sessionsDir());
      const id = store.newId();
      store.checkpoint(
        id,
        [{ role: "user", content: "side session" }],
        { model: "fake-model", workspace: wsDir, createdAt: Date.now() },
      );
      return id;
    })();
    const r = await runCli(["--compact", "no such name"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no session named");
    // Nothing was compacted anywhere.
    expect(fs.existsSync(path.join(sessionsDir(), `${otherId}.compact.json`))).toBe(false);
  });

  it("an ambiguous name fails closed listing the short ids", async () => {
    const store = new SessionStore(sessionsDir());
    const dup = store.newId();
    store.checkpoint(
      dup,
      [{ role: "user", content: "dup seed" }],
      { model: "fake-model", workspace: wsDir, createdAt: Date.now() },
    );
    store.writeName(dup, "flags target");
    const r = await runCli(["--session-stats", "flags target"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("2 sessions are named");
    expect(r.stderr).toContain(sessionId.split("-")[0]);
    expect(r.stderr).toContain(dup.split("-")[0]);
    // Restore the store: clear the duplicate name for later runs.
    store.writeName(dup, null);
  });
});
