import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("Integration: session export (--export-session)", () => {
  let home: string;
  let outDir: string;
  let baseEnv: Record<string, string | undefined>;
  const sessionId = "11111111-2222-3333-4444-555555555555";

  function sessionsDir(): string {
    return path.join(home, ".oh-my-cli", "sessions");
  }

  function seedSession(): void {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const meta = JSON.stringify({ meta: true, model: "fake-model", workspace: `${home}/work`, createdAt: 1_700_000_000_000 });
    const lines = [
      meta,
      JSON.stringify({ role: "user", content: `please run with token ${SECRET}` }),
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "ls" } }],
      }),
      JSON.stringify({ role: "tool", tool_call_id: "c1", content: "file-a\nfile-b" }),
      JSON.stringify({ role: "assistant", content: "all done" }),
    ];
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-export-home-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-export-out-"));
    // No provider credentials: the export path must not need a network or model.
    baseEnv = {
      HOME: home,
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "",
    };
    seedSession();
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("exports a session to redacted Markdown + a JSON manifest", async () => {
    const r = await runCli(["--export-session", sessionId, "--out", outDir], baseEnv);
    expect(r.code).toBe(0);

    const mdPath = path.join(outDir, `${sessionId}.session-export.md`);
    const manifestPath = path.join(outDir, `${sessionId}.session-export.manifest.json`);
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const md = fs.readFileSync(mdPath, "utf8");
    expect(md).not.toContain(SECRET);
    expect(md).toContain("[REDACTED]");
    expect(md).toContain("## Transcript");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.schema).toBe("oh-my-cli.session-export");
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.counts.toolCalls).toBe(1);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    // No temp residue.
    expect(fs.readdirSync(outDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("is deterministic across repeated exports", async () => {
    const a = path.join(outDir, "a");
    const b = path.join(outDir, "b");
    const ra = await runCli(["--export-session", sessionId, "--out", a], baseEnv);
    const rb = await runCli(["--export-session", sessionId, "--out", b], baseEnv);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    const name = `${sessionId}.session-export.manifest.json`;
    expect(fs.readFileSync(path.join(a, name), "utf8")).toBe(
      fs.readFileSync(path.join(b, name), "utf8"),
    );
  });

  it("fails closed on a collision and overwrites with --force", async () => {
    const dir = path.join(outDir, "collision");
    const first = await runCli(["--export-session", sessionId, "--out", dir], baseEnv);
    expect(first.code).toBe(0);
    const blocked = await runCli(["--export-session", sessionId, "--out", dir], baseEnv);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("refusing to overwrite");
    const forced = await runCli(["--export-session", sessionId, "--out", dir, "--force"], baseEnv);
    expect(forced.code).toBe(0);
  });

  it("exits non-zero for a missing session", async () => {
    const r = await runCli(["--export-session", "no-such-id", "--out", outDir], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no such session");
  });

  it("leaves the source session untouched (no mutation, no network needed)", async () => {
    const src = path.join(sessionsDir(), `${sessionId}.jsonl`);
    const before = fs.readFileSync(src, "utf8");
    const r = await runCli(["--export-session", sessionId, "--out", path.join(outDir, "readonly")], baseEnv);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(src, "utf8")).toBe(before);
  });
});
