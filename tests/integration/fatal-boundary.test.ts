import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
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

describe("Integration: fatal runtime boundary (#246)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-fatal-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-fatal-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  function runWithFault(fault: string) {
    return runCli(
      ["-p", "hello", "--output", "json", "--workspace", tmpDir],
      { ...baseEnv, OMC_FAULT_INJECT: fault },
    );
  }

  it("emits exactly one terminal record and exits non-zero on an unhandled rejection", async () => {
    const r = await runWithFault("unhandled-rejection");
    expect(r.code).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    // The protocol started before the failure.
    expect(recs.some((x) => x.type === "start")).toBe(true);
    // Exactly one schema-valid terminal record, classified as an internal failure.
    const completes = recs.filter((x) => x.type === "complete");
    expect(completes.length).toBe(1);
    const term = completes[0];
    if (term.type !== "complete") throw new Error("expected a complete record");
    expect(term.ok).toBe(false);
    expect(term.reason).toBe("internal_runtime_failure");
    expect(term.exitCode).toBe(1);

    // A bounded redacted error is surfaced on stderr.
    expect(r.stderr).toContain("Fatal runtime error");
  });

  it("emits exactly one terminal record and exits non-zero on an uncaught exception", async () => {
    const r = await runWithFault("uncaught-exception");
    expect(r.code).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    const completes = recs.filter((x) => x.type === "complete");
    expect(completes.length).toBe(1);
    const term = completes[0];
    if (term.type !== "complete") throw new Error("expected a complete record");
    expect(term.ok).toBe(false);
    expect(term.reason).toBe("internal_runtime_failure");
    expect(term.exitCode).toBe(1);
    expect(r.stderr).toContain("Fatal runtime error");
  });

  it("leaves ordinary runs unchanged when no fault is injected", async () => {
    const r = await runCli(
      ["-p", "hello", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const recs = parseHeadlessStream(r.stdout);
    const completes = recs.filter((x) => x.type === "complete");
    expect(completes.length).toBe(1);
    if (completes[0].type !== "complete") throw new Error("expected a complete record");
    expect(completes[0].ok).toBe(true);
    expect(completes[0].reason).toBe("completed");
  });
});
