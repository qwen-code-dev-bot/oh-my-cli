import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildRunSummary } from "../../src/run-summary.js";
import { writeRecoveryCheckpoint, hashEvidence } from "../../src/run-recovery.js";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
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

describe("Integration: evidence archive (--export-evidence / --verify-evidence)", () => {
  let dir: string;
  const write = (name: string, content: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-evidence-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSummary(name: string, ok = true): string {
    return write(
      name,
      JSON.stringify(
        buildRunSummary({
          ok,
          exitCode: ok ? 0 : 1,
          reason: ok ? "completed" : "error",
          elapsedMs: 1000,
          rounds: 2,
          toolCalls: { read_file: 2, edit: 1 },
          toolFailures: {},
          tokens: { prompt: 5, completion: 5, total: 10 },
          sessionId: "sess",
          sessionPath: "~/.qwen/sessions/sess.jsonl",
        }),
      ),
    );
  }

  function writeCheckpoint(name: string): string {
    const p = path.join(dir, name);
    writeRecoveryCheckpoint(p, {
      schema: "oh-my-cli.recovery",
      v: 1,
      taskIdentity: `deploy ${SECRET}`,
      repoHead: "abc123",
      steps: [
        { id: "build", digest: hashEvidence("artifact-1") },
        { id: "test", digest: hashEvidence("artifact-2") },
      ],
    });
    return p;
  }

  function writeOutcomes(name: string): string {
    return write(
      name,
      JSON.stringify([
        { command: "npm run build", exitCode: 0, ok: true },
        { command: "npm test", exitCode: 1, ok: false },
      ]),
    );
  }

  function writeEvidence(name: string): string {
    return write(name, JSON.stringify({ "write:src/foo.ts": hashEvidence("content-1") }));
  }

  it("exports a bundle from a run summary and exits 0", async () => {
    const out = path.join(dir, "a.json");
    const r = await runCli(["--export-evidence", out, "--summary-file", writeSummary("s1.json")]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(r.stdout).toContain("Evidence archive");
    expect(r.stdout).toContain("run-summary");
  });

  it("emits the bundle as JSON with --output json", async () => {
    const out = path.join(dir, "b.json");
    const r = await runCli([
      "--export-evidence", out,
      "--summary-file", writeSummary("s2.json"),
      "--output", "json",
    ]);
    expect(r.code).toBe(0);
    const bundle = JSON.parse(r.stdout.trim());
    expect(bundle.schema).toBe("oh-my-cli.evidence-archive");
    expect(bundle.v).toBe(1);
    expect(bundle.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bundles every supplied kind and redacts secrets", async () => {
    const out = path.join(dir, "full.json");
    const r = await runCli([
      "--export-evidence", out,
      "--summary-file", writeSummary("s3.json"),
      "--checkpoint", writeCheckpoint("cp.json"),
      "--outcomes-file", writeOutcomes("oc.json"),
      "--evidence", writeEvidence("ev.json"),
      "--task-identity", "task-A",
    ]);
    expect(r.code).toBe(0);
    const text = fs.readFileSync(out, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED]");
    const bundle = JSON.parse(text);
    expect(bundle.entries.map((e: { name: string }) => e.name)).toEqual([
      "checkpoint",
      "command-outcomes",
      "content-digests",
      "run-summary",
    ]);
  });

  it("produces deterministic bytes for identical inputs", async () => {
    const s = writeSummary("s4.json");
    const out1 = path.join(dir, "det1.json");
    const out2 = path.join(dir, "det2.json");
    expect((await runCli(["--export-evidence", out1, "--summary-file", s])).code).toBe(0);
    expect((await runCli(["--export-evidence", out2, "--summary-file", s])).code).toBe(0);
    expect(fs.readFileSync(out1, "utf8")).toBe(fs.readFileSync(out2, "utf8"));
  });

  it("verifies an intact bundle and exits 0", async () => {
    const out = path.join(dir, "v.json");
    expect((await runCli(["--export-evidence", out, "--summary-file", writeSummary("s5.json")])).code).toBe(0);
    const r = await runCli(["--verify-evidence", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("result:    valid");
  });

  it("verifies with machine-readable JSON output", async () => {
    const out = path.join(dir, "vj.json");
    expect((await runCli(["--export-evidence", out, "--summary-file", writeSummary("s6.json")])).code).toBe(0);
    const r = await runCli(["--verify-evidence", out, "--output", "json"]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout.trim());
    expect(result.schema).toBe("oh-my-cli.evidence-archive");
    expect(result.ok).toBe(true);
    expect(result.signatureValid).toBe(true);
  });

  it("detects tampering and exits 1", async () => {
    const out = path.join(dir, "tampered.json");
    expect((await runCli(["--export-evidence", out, "--summary-file", writeSummary("s7.json")])).code).toBe(0);
    // Flip a byte inside an entry's content while keeping the JSON parseable.
    const obj = JSON.parse(fs.readFileSync(out, "utf8"));
    obj.entries[0].content = obj.entries[0].content + " ";
    fs.writeFileSync(out, JSON.stringify(obj), "utf8");
    const r = await runCli(["--verify-evidence", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("result:    invalid");
  });

  it("exits 2 when --export-evidence has no inputs", async () => {
    const r = await runCli(["--export-evidence", path.join(dir, "none.json")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("at least one of");
  });

  it("exits 2 when verifying a missing bundle", async () => {
    const r = await runCli(["--verify-evidence", path.join(dir, "missing.json")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("file not found");
  });

  it("exits 2 on a malformed outcomes file", async () => {
    const bad = write("bad-oc.json", JSON.stringify([{ command: "x" }]));
    const r = await runCli(["--export-evidence", path.join(dir, "x.json"), "--outcomes-file", bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("string command, number exitCode, boolean ok");
  });
});
