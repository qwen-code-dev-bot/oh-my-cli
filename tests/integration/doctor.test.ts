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

describe("Integration: doctor readiness checks", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-doctor-home-"));
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("passes all checks on a healthy host and exits 0", async () => {
    const r = await runCli(["--doctor"], { HOME: homeDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Doctor");
    expect(r.stdout).toContain("Node runtime");
    expect(r.stdout).toContain("CLI entry");
    expect(r.stdout).toContain("State directory");
    expect(r.stdout).toContain("Platform");
    expect(r.stdout).toContain("✓");
    expect(r.stdout).toMatch(/Summary: \d+ passed, \d+ warnings, 0 failed/);
  });

  it("reports a safe simulated failure (no HOME) and exits non-zero", async () => {
    // A read-only, side-effect-free failure: without HOME the state directory
    // cannot be located, so the doctor must fail without changing anything.
    const r = await runCli(["--doctor"], { HOME: "" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗");
    expect(r.stdout).toContain("State directory");
    expect(r.stdout).toMatch(/Summary: \d+ passed, \d+ warnings, [1-9]\d* failed/);
  });

  it("emits a versioned oh-my-cli.doctor record with --output json (Issue #540)", async () => {
    const r = await runCli(["--doctor", "--output", "json"], { HOME: homeDir });
    expect(r.code).toBe(0);
    const rec = JSON.parse(r.stdout.trim());
    expect(rec.schema).toBe("oh-my-cli.doctor");
    expect(rec.v).toBe(1);
    expect(rec.ok).toBe(true);
    expect(Array.isArray(rec.checks)).toBe(true);
    expect(rec.checks.length).toBeGreaterThan(0);
    const ids = rec.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain("node-version");
    expect(ids).toContain("cli-resolution");
    expect(ids).toContain("state-directory");
    expect(ids).toContain("platform-support");
    // Every check carries the structured fields automation needs.
    for (const c of rec.checks) {
      expect(typeof c.label).toBe("string");
      expect(["pass", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
  });

  it("maps ok=false to exit 1 in JSON mode too (Issue #540)", async () => {
    const r = await runCli(["--doctor", "--output", "json"], { HOME: "" });
    expect(r.code).toBe(1);
    const rec = JSON.parse(r.stdout.trim());
    expect(rec.schema).toBe("oh-my-cli.doctor");
    expect(rec.ok).toBe(false);
    expect(rec.checks.some((c: { status: string }) => c.status === "fail")).toBe(true);
  });

  it("rejects an unknown --output format with a usage error", async () => {
    const r = await runCli(["--doctor", "--output", "yaml"], { HOME: homeDir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
