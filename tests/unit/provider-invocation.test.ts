import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../src/tool-invocation.js";
import {
  PROVIDER_INVOCATION_SCHEMA,
  PROVIDER_INVOCATION_VERSION,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS,
  clampMaxTokens,
  providerInvocationExitCode,
  openaiProviderRunner,
  invokeProvider,
  formatProviderInvocation,
  type ProviderRunner,
  type ProviderRunOptions,
  type ProviderRunResult,
  type ProviderInvocationReport,
} from "../../src/provider-invocation.js";
import { resolveProviderReadiness, type ProviderEntry } from "../../src/provider-contract.js";
import { startMockServer } from "../fixtures/openai-mock-server.mjs";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-provider-invoke-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// A fake runner that records every invocation and returns a fixed result, so the
// gate logic can be tested deterministically without a live endpoint.
function recordingRunner(
  result: Partial<ProviderRunResult> = {},
): { runner: ProviderRunner; calls: ProviderRunOptions[] } {
  const calls: ProviderRunOptions[] = [];
  const runner: ProviderRunner = async (opts) => {
    calls.push(opts);
    return {
      outcome: "called",
      text: "",
      finishReason: "stop",
      status: null,
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
      timedOut: false,
      outputCapped: false,
      elapsedMs: 1,
      reason: "provider returned a response",
      ...result,
    };
  };
  return { runner, calls };
}

describe("clampMaxTokens", () => {
  it("falls back to the default for non-finite input", () => {
    expect(clampMaxTokens(undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens(Number.NaN)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_TOKENS);
  });

  it("clamps to the [min, max] range and floors", () => {
    expect(clampMaxTokens(0)).toBe(MIN_MAX_TOKENS);
    expect(clampMaxTokens(-5)).toBe(MIN_MAX_TOKENS);
    expect(clampMaxTokens(100)).toBe(100);
    expect(clampMaxTokens(100.9)).toBe(100);
    expect(clampMaxTokens(99_999)).toBe(MAX_MAX_TOKENS);
  });
});

describe("providerInvocationExitCode", () => {
  const base: ProviderInvocationReport = {
    schema: PROVIDER_INVOCATION_SCHEMA,
    version: PROVIDER_INVOCATION_VERSION,
    contractVersion: 1,
    providerId: "p",
    endpoint: "127.0.0.1",
    endpointSource: "settings",
    model: "ok",
    credentialVariable: "OPENAI_API_KEY",
    credentialFromSettings: false,
    promptChars: 4,
    gate: "passed",
    invoked: true,
    outcome: "called",
    status: null,
    finishReason: "stop",
    promptTokens: 3,
    completionTokens: 5,
    totalTokens: 8,
    timedOut: false,
    outputCapped: false,
    outputCapBytes: DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: 30_000,
    maxTokens: DEFAULT_MAX_TOKENS,
    elapsedMs: 1,
    content: "pong",
    reason: "provider returned a response",
    settings: "~/.oh-my-cli/settings.json",
  };

  it("returns 0 for a successful response", () => {
    expect(providerInvocationExitCode(base)).toBe(0);
  });

  it("returns 2 for any refusal gate", () => {
    for (const gate of ["not-ready", "unapproved"] as const) {
      expect(providerInvocationExitCode({ ...base, gate, invoked: false, outcome: gate })).toBe(2);
    }
  });

  it("returns 1 for runtime failures after calling", () => {
    for (const outcome of [
      "empty",
      "auth-rejected",
      "unsupported-model",
      "rate-limited",
      "network-error",
      "api-error",
    ] as const) {
      expect(providerInvocationExitCode({ ...base, outcome })).toBe(1);
    }
    expect(providerInvocationExitCode({ ...base, timedOut: true, outcome: "timeout" })).toBe(1);
    expect(providerInvocationExitCode({ ...base, outputCapped: true, outcome: "output-capped" })).toBe(1);
  });
});

describe("resolveProviderReadiness", () => {
  it("is ready when the credential is exported and the endpoint is valid", () => {
    const entry: ProviderEntry = { id: "p", model: "ok", apiKeyEnv: "K" };
    const r = resolveProviderReadiness(entry, { env: { K: "sk-test" } });
    expect(r.state).toBe("ready");
    expect(r.credentialAvailable).toBe(true);
    expect(r.endpointValid).toBe(true);
    expect(r.endpointSource).toBe("default");
  });

  it("is not-ready when the credential variable is unset", () => {
    const entry: ProviderEntry = { id: "p", model: "ok", apiKeyEnv: "K" };
    const r = resolveProviderReadiness(entry, { env: {} });
    expect(r.state).toBe("not-ready");
    expect(r.reason).toContain("K");
  });

  it("is not-ready when the endpoint URL is invalid", () => {
    // Bypasses the schema (which would reject an invalid URL at parse time) to
    // exercise the defensive endpoint branch directly.
    const entry: ProviderEntry = { id: "p", baseUrl: "not a url", model: "ok", apiKeyEnv: "K" };
    const r = resolveProviderReadiness(entry, { env: { K: "sk-test" } });
    expect(r.state).toBe("not-ready");
    expect(r.endpointValid).toBe(false);
    expect(r.reason).toContain("not a valid URL");
  });
});

describe("openaiProviderRunner: bounded real request", () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeAll(async () => {
    server = await startMockServer();
  });

  afterAll(async () => {
    await server.close();
  });

  function config(model: string) {
    return { apiKey: "sk-test", baseUrl: server.baseUrl, model };
  }

  it("issues one request and returns the response with usage", async () => {
    const r = await openaiProviderRunner({
      config: config("ok"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("called");
    expect(r.text).toBe("hello");
    expect(r.totalTokens).toBe(8);
    expect(r.finishReason).toBe("stop");
    expect(r.timedOut).toBe(false);
  });

  it("reports an empty response", async () => {
    const r = await openaiProviderRunner({
      config: config("empty"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("empty");
    expect(r.text).toBe("");
  });

  it("classifies a 401 as auth-rejected", async () => {
    const r = await openaiProviderRunner({
      config: config("auth"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("auth-rejected");
    expect(r.status).toBe(401);
  });

  it("classifies a 404 referencing the model as unsupported-model", async () => {
    const r = await openaiProviderRunner({
      config: config("nomodel"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("unsupported-model");
    expect(r.status).toBe(404);
  });

  it("classifies a 429 as rate-limited", async () => {
    const r = await openaiProviderRunner({
      config: config("ratelimit"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("rate-limited");
    expect(r.status).toBe(429);
  });

  it("aborts a hanging endpoint at the hard timeout", async () => {
    const r = await openaiProviderRunner({
      config: config("hang"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 300,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.outcome).toBe("timeout");
    expect(r.timedOut).toBe(true);
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  it("caps oversized output", async () => {
    const r = await openaiProviderRunner({
      config: config("flood"),
      prompt: "hello",
      maxTokens: DEFAULT_MAX_TOKENS,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });
    expect(r.outcome).toBe("output-capped");
    expect(r.outputCapped).toBe(true);
    expect(r.text.length).toBe(1_000);
  });
});

describe("invokeProvider: readiness gating", () => {
  it("calls a resolved-ready provider (yolo) and returns a passed report", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const { runner, calls } = recordingRunner({ outcome: "called", text: "hi" });
    const report = await invokeProvider({
      settingsPath: settings,
      env: { TEST_PROVIDER_KEY: "sk-test" },
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].config.apiKey).toBe("sk-test");
    expect(providerInvocationExitCode(report)).toBe(0);
  });

  it("refuses a provider whose credential is not set without calling", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeProvider({
      settingsPath: settings,
      env: {},
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(providerInvocationExitCode(report)).toBe(2);
  });
});

describe("invokeProvider: approval gate", () => {
  it("refuses an unapproved provider under the default mode (non-interactive)", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeProvider({
      settingsPath: settings,
      env: { TEST_PROVIDER_KEY: "sk-test" },
      workspace: tmpDir(),
      approvalMode: "default",
      runner,
    });
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(providerInvocationExitCode(report)).toBe(2);
  });
});

describe("invokeProvider: redaction, bounds, and contract errors", () => {
  it("redacts secrets in the captured response and never leaks the credential", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const { runner } = recordingRunner({
      outcome: "called",
      text: "leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here",
    });
    const report = await invokeProvider({
      settingsPath: settings,
      env: { TEST_PROVIDER_KEY: "sk-super-secret-value" },
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(report.content).toContain("[REDACTED]");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(report.credentialVariable).toBe("TEST_PROVIDER_KEY");
  });

  it("reports the prompt length, not the prompt text", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const { runner } = recordingRunner({ outcome: "called", text: "ok" });
    const report = await invokeProvider({
      settingsPath: settings,
      env: { TEST_PROVIDER_KEY: "sk-test" },
      prompt: "a secret-bearing prompt that must not be echoed",
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.promptChars).toBe("a secret-bearing prompt that must not be echoed".length);
    expect(JSON.stringify(report)).not.toContain("must not be echoed");
  });

  it("throws (caller maps to exit 2) when there is no providers section", async () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    await expect(
      invokeProvider({
        settingsPath: settings,
        env: {},
        workspace: tmpDir(),
        approvalMode: "yolo",
      }),
    ).rejects.toThrow(/no settings.providers section/);
  });
});

describe("formatProviderInvocation", () => {
  it("renders the gate, provider, and reason without leaking the credential or prompt", async () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "p", model: "ok", apiKeyEnv: "TEST_PROVIDER_KEY" }],
      },
    });
    const report = await invokeProvider({
      settingsPath: settings,
      env: { TEST_PROVIDER_KEY: "sk-test" },
      prompt: "should-not-appear",
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner: recordingRunner({ outcome: "called", text: "ok" }).runner,
    });
    const out = formatProviderInvocation(report);
    expect(out).toContain("Provider:");
    expect(out).toContain("p");
    expect(out).toContain(PROVIDER_INVOCATION_SCHEMA);
    expect(out).toContain("Gate:");
    expect(out).toContain("Credential:   TEST_PROVIDER_KEY");
    expect(out).not.toContain("should-not-appear");
    expect(out).not.toContain("sk-test");
  });
});
