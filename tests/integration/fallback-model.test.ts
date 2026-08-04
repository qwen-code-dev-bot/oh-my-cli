import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 30_000,
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

const fail503 = { failWith: { status: 503 } } as const;
const modelOf = (r: { body: unknown }) => (r.body as { model?: string }).model;

describe("Integration: one-shot fallback model (--fallback-model, Issue #590)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-590i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-590i-home-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "primary-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  it("degrades once to the fallback after retryable primary failures and records it in the summary", async () => {
    // The pre-run fallback probe consumes the first entry; the primary then
    // exhausts its bounded retries (three 503s) before the degrade succeeds.
    server.setResponses([
      { type: "text", content: "probe" },
      fail503,
      fail503,
      fail503,
      { type: "text", content: "fallback answer" },
    ]);
    const r = await runCli(
      [
        "-p", "answer me",
        "--fallback-model", "fallback-model",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
        "--summary",
      ],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fallback answer");
    // Truthful degrade notice on stderr.
    expect(r.stderr).toContain(
      'Provider fallback: model "primary-model" failed transiently (server_error); ' +
        'degrading this run to fallback model "fallback-model".',
    );
    // The printed run summary records the degrade.
    expect(r.stdout).toContain('fallback:  degraded to "fallback-model"');

    // Request-level truth: probe on the fallback, three primary attempts, then
    // the successful round on the fallback model.
    const models = server.requests.map(modelOf);
    expect(models[0]).toBe("fallback-model");
    expect(models[1]).toBe("primary-model");
    expect(models[2]).toBe("primary-model");
    expect(models[3]).toBe("primary-model");
    expect(models[4]).toBe("fallback-model");
  });

  it("carries the degrade in the headless stream and the persisted summary file", async () => {
    server.setResponses([
      { type: "text", content: "probe" },
      fail503,
      fail503,
      fail503,
      { type: "text", content: "fallback answer" },
    ]);
    const summaryPath = path.join(tmpDir, "summary-590.json");
    const r = await runCli(
      [
        "-p", "answer me",
        "--fallback-model", "fallback-model",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
        "--output", "json",
        "--summary",
        "--summary-out", summaryPath,
      ],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const records = r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    const fallbackRec = records.find((rec) => rec.type === "fallback");
    expect(fallbackRec).toBeDefined();
    expect(fallbackRec?.fromModel).toBe("primary-model");
    expect(fallbackRec?.toModel).toBe("fallback-model");
    expect(fallbackRec?.reasonClass).toBe("server_error");

    const summaryRec = records.find((rec) => rec.type === "summary");
    expect(summaryRec).toBeDefined();
    const summary = (summaryRec as { summary: { fellBack: boolean; fallbackModel: string | null } }).summary;
    expect(summary.fellBack).toBe(true);
    expect(summary.fallbackModel).toBe("fallback-model");

    // The persisted artifact carries the same truth.
    const fileSummary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
      fellBack: boolean;
      fallbackModel: string | null;
    };
    expect(fileSummary.fellBack).toBe(true);
    expect(fileSummary.fallbackModel).toBe("fallback-model");
  });

  it("fails as today when the primary exhausts retries and no fallback is configured", async () => {
    server.setResponses([fail503, fail503, fail503]);
    const r = await runCli(
      ["-p", "answer me", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("fallback answer");
    expect(r.stderr).toContain("Provider error");
    expect(server.requests.map(modelOf)).toEqual([
      "primary-model",
      "primary-model",
      "primary-model",
    ]);
  });

  it("honors OMC_FALLBACK_MODEL when the flag is absent", async () => {
    server.setResponses([
      { type: "text", content: "probe" },
      fail503,
      fail503,
      fail503,
      { type: "text", content: "env fallback answer" },
    ]);
    const r = await runCli(
      ["-p", "answer me", "--approval-mode", "yolo", "--workspace", tmpDir],
      { ...baseEnv, OMC_FALLBACK_MODEL: "fallback-model" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("env fallback answer");
    expect(r.stderr).toContain("Provider fallback");
  });

  it("fails closed before any work when the fallback model cannot be probed", async () => {
    // The probe itself fails (a 404 the SDK does not retry); the run must end
    // before any session or provider work.
    server.setResponses([{ failWith: { status: 404 } }]);
    const r = await runCli(
      [
        "-p", "answer me",
        "--fallback-model", "broken-model",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
      ],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Fallback model preflight failed");
    // Only the probe reached the server — no run request, no answer.
    expect(server.requests).toHaveLength(1);
    expect(modelOf(server.requests[0])).toBe("broken-model");
  });

  it("rejects invalid overrides fail-closed without any request", async () => {
    const blank = await runCli(
      [
        "-p", "answer me",
        "--fallback-model", "   ",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
      ],
      baseEnv,
    );
    expect(blank.code).toBe(1);
    expect(blank.stderr).toContain("--fallback-model requires a non-empty model name");

    const same = await runCli(
      [
        "-p", "answer me",
        "--fallback-model", "primary-model",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
      ],
      baseEnv,
    );
    expect(same.code).toBe(1);
    expect(same.stderr).toContain("must differ from the primary model");
    expect(server.requests).toHaveLength(0);
  });

  it("validates both models on the --preflight surface", async () => {
    server.setResponses([
      { type: "text", content: "primary ping" },
      { type: "text", content: "fallback ping" },
    ]);
    const r = await runCli(
      ["--preflight", "--fallback-model", "fallback-model"],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Provider connected: model "primary-model"');
    expect(r.stdout).toContain('fallback model "fallback-model" ready');
    expect(server.requests.map(modelOf)).toEqual(["primary-model", "fallback-model"]);
  });

  it("fails the --preflight surface closed on an unusable fallback", async () => {
    server.setResponses([
      { type: "text", content: "primary ping" },
      { failWith: { status: 404 } },
    ]);
    const r = await runCli(
      ["--preflight", "--fallback-model", "broken-model"],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ Preflight failed");
    expect(r.stdout).toContain('Fallback model "broken-model"');
  });
});
