import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("Integration: persisted session names (#249)", () => {
  let home: string;
  let sessionsDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-name-int-"));
    sessionsDir = path.join(home, ".oh-my-cli", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Seed one readable session: a meta line plus a user message.
    const meta = { meta: { model: "fake-model", workspace: "/ws", createdAt: 1000 } };
    fs.writeFileSync(
      path.join(sessionsDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify(meta)}\n${JSON.stringify({ role: "user", content: "hello" })}\n`,
    );
    env = { HOME: home, OPENAI_API_KEY: "fake-key", OPENAI_MODEL: "fake-model" };
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function nameSidecar(): string {
    return path.join(sessionsDir, `${SESSION_ID}.name.json`);
  }
  function transcriptBytes(): string {
    return fs.readFileSync(path.join(sessionsDir, `${SESSION_ID}.jsonl`), "utf-8");
  }

  it("sets a name that persists, appears in export, and leaves the transcript unchanged", async () => {
    const before = transcriptBytes();
    const r = await runCli(["--rename-session", SESSION_ID, "--session-name", "Release Prep"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Release Prep");

    // Persisted as bounded sidecar metadata.
    expect(JSON.parse(fs.readFileSync(nameSidecar(), "utf-8")).name).toBe("Release Prep");
    // Transcript bytes are unchanged.
    expect(transcriptBytes()).toBe(before);

    // The name appears in the redacted export manifest.
    const exp = await runCli(["--export-session", SESSION_ID, "--output", "json", "--out", home, "--force"], env);
    expect(exp.code).toBe(0);
    const parsed = JSON.parse(exp.stdout);
    expect(parsed.manifest.name).toBe("Release Prep");
  });

  it("survives a restart (a fresh store reads the same name)", async () => {
    // A new process (fresh SessionStore over the same HOME) still sees the name.
    const r = await runCli(["--export-session", SESSION_ID, "--output", "json", "--out", home, "--force"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).manifest.name).toBe("Release Prep");
  });

  it("clears the override with an empty name", async () => {
    const r = await runCli(["--rename-session", SESSION_ID, "--session-name", "   "], env);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("cleared");
    expect(fs.existsSync(nameSidecar())).toBe(false);
  });

  it("fails closed (exit 2) for a missing session without touching others", async () => {
    const r = await runCli(["--rename-session", "no-such-session", "--session-name", "x"], env);
    expect(r.code).toBe(2);
    // Id-or-name targeting (#536): shared resolution reason.
    expect(r.stderr).toContain("no session named");
  });

  it("rejects overlong and secret-like names (exit 2)", async () => {
    const overlong = await runCli(["--rename-session", SESSION_ID, "--session-name", "x".repeat(200)], env);
    expect(overlong.code).toBe(2);
    expect(overlong.stderr).toContain("exceeds");

    const secret = await runCli(["--rename-session", SESSION_ID, "--session-name", `key ghp_${"a".repeat(24)}`], env);
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain("secret");
  });

  it("requires --session-name with --rename-session", async () => {
    const r = await runCli(["--rename-session", SESSION_ID], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--session-name");
  });
});
