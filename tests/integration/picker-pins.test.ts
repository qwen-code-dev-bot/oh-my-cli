import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: picker pin awareness (Issue #612)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_700_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-612i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-612i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: wsDir, createdAt: NOW });
    store.append(id, { role: "user", content: "picker fodder" });
    return id;
  }

  function setAge(id: string, ageSeconds: number): void {
    const t = new Date(Date.now() / 1000 - ageSeconds);
    fs.utimesSync(path.join(sessionsDir(), `${id}.jsonl`), t, t);
  }

  it("enumerates pinned rows first through the built picker path", async () => {
    const older = seed();
    const newer = seed();
    setAge(older, 3600);
    setAge(newer, 10);

    // Drive the exact built row-enumeration path the interactive picker uses.
    const script = `
      import("${path.resolve(import.meta.dirname, "../../dist/session.js")}").then(async ({ SessionStore }) => {
        const { collectSessionPickerRows } = await import("${path.resolve(import.meta.dirname, "../../dist/session-picker.js")}");
        const store = new SessionStore(process.env.HOME + "/.oh-my-cli/sessions");
        const rows = collectSessionPickerRows(store);
        console.log(JSON.stringify(rows.map((r) => ({ id: r.id, pinned: r.pinned === true }))));
      });
    `;

    const unpinnedOut = await new Promise<string>((resolve, reject) => {
      const proc = spawn("node", ["-e", script], { env: { ...process.env, ...baseEnv } });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.on("close", () => resolve(out));
      proc.on("error", reject);
    });
    expect(JSON.parse(unpinnedOut.trim()).map((r: { id: string }) => r.id)).toEqual([newer, older]);

    expect((await runCli(["--pin-session", older], baseEnv)).code).toBe(0);

    const pinnedOut = await new Promise<string>((resolve, reject) => {
      const proc = spawn("node", ["-e", script], { env: { ...process.env, ...baseEnv } });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.on("close", () => resolve(out));
      proc.on("error", reject);
    });
    const rows = JSON.parse(pinnedOut.trim()) as Array<{ id: string; pinned: boolean }>;
    expect(rows.map((r) => r.id)).toEqual([older, newer]);
    expect(rows[0].pinned).toBe(true);
    expect(rows[1].pinned).toBe(false);
  });
});
