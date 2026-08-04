import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: workspace-scoped session views (--workspace-scoped, Issue #596)", () => {
  let homeDir: string;
  let wsOne: string;
  let wsTwo: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596i-home-"));
    wsOne = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596i-ws1-"));
    wsTwo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-596i-ws2-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsOne, { recursive: true, force: true });
    fs.rmSync(wsTwo, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(workspace: string | undefined, content: string): string {
    const id = store.newId();
    store.writeMeta(
      id,
      workspace === undefined
        ? { model: "fake-model", createdAt: 1 }
        : { model: "fake-model", workspace, createdAt: 1 },
    );
    store.append(id, { role: "user", content });
    return id;
  }

  function seedAll(): { inScope: string; outOfScope: string; legacy: string } {
    const inScope = seed(wsOne, "needle in workspace one");
    const outOfScope = seed(wsTwo, "needle in workspace two");
    const legacy = seed(undefined, "needle legacy session");
    // Corrupt session with a verifiable in-scope workspace.
    fs.writeFileSync(
      path.join(homeDir, ".oh-my-cli", "sessions", "corrupt-ws1.jsonl"),
      `${JSON.stringify({ meta: true, model: "fake-model", workspace: wsOne, createdAt: 1 })}\n` +
        `${JSON.stringify({ role: "user", content: "needle corrupt" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    return { inScope, outOfScope, legacy };
  }

  it("scopes --list-sessions to the workspace with truthful exclusion counts", async () => {
    const { inScope } = seedAll();
    const r = await runCli(
      ["--list-sessions", "--workspace-scoped", "--workspace", wsOne, "--output", "json"],
      baseEnv,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    // The in-scope healthy session and the in-scope corrupt one are kept;
    // the legacy session is excluded; the other workspace is simply absent.
    expect(record.total).toBe(2);
    expect(record.resumable).toBe(1);
    expect(record.corrupt).toBe(1);
    expect(record.excludedUnverifiable).toBe(1);
    expect(record.scopedWorkspace).toBe(wsOne);
    expect(record.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
      [inScope, "corrupt-ws1"].sort(),
    );
  });

  it("renders the scope and exclusion count in text mode", async () => {
    seedAll();
    const r = await runCli(
      ["--list-sessions", "--workspace-scoped", "--workspace", wsOne],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Scoped to workspace: ${wsOne}`);
    expect(r.stdout).toContain("1 excluded (workspace unverifiable)");
  });

  it("leaves unscoped listing byte-compatible with today", async () => {
    seedAll();
    const r = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.total).toBe(4);
    expect("scopedWorkspace" in record).toBe(false);
    expect("excludedUnverifiable" in record).toBe(false);
    const text = await runCli(["--list-sessions"], baseEnv);
    expect(text.stdout).not.toContain("Scoped to workspace");
    expect(text.stdout).not.toContain("excluded");
  });

  it("composes scoping with --filter", async () => {
    const { inScope } = seedAll();
    store.writeName(inScope, "target work");
    const r = await runCli(
      [
        "--list-sessions",
        "--workspace-scoped",
        "--workspace", wsOne,
        "--filter", "target",
        "--output", "json",
      ],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.total).toBe(1);
    expect(record.sessions[0].id).toBe(inScope);
    expect(record.excludedUnverifiable).toBe(1);
  });

  it("scopes --search-sessions and composes with corrupt skip counts", async () => {
    const { inScope } = seedAll();
    const scoped = await runCli(
      ["--search-sessions", "needle", "--workspace-scoped", "--workspace", wsOne, "--output", "json"],
      baseEnv,
    );
    expect(scoped.code, `stderr: ${scoped.stderr}`).toBe(0);
    const record = JSON.parse(scoped.stdout.trim());
    expect(record.sessionsScanned).toBe(1);
    expect(record.sessionsSkippedCorrupt).toBe(1);
    expect(record.excludedUnverifiable).toBe(1);
    expect(record.scopedWorkspace).toBe(wsOne);
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(inScope);

    // Unscoped search sees every loadable session with the needle.
    const unscoped = await runCli(["--search-sessions", "needle", "--output", "json"], baseEnv);
    const u = JSON.parse(unscoped.stdout.trim());
    expect(u.sessionsScanned).toBe(3);
    expect(u.matches).toHaveLength(3);
    expect("scopedWorkspace" in u).toBe(false);
    // The store is untouched by both scans.
    const text = await runCli(
      ["--search-sessions", "needle", "--workspace-scoped", "--workspace", wsOne],
      baseEnv,
    );
    expect(text.stdout).toContain(`Scoped to workspace: ${wsOne}`);
    expect(text.stdout).toContain("excluded 1 (workspace unverifiable)");
  });
});
