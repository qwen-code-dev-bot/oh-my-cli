// Provider extension invocation: governed, non-interactive issuance of exactly
// one bounded model request to one resolved versioned provider through its
// contract (#118), gated by readiness (credential available, endpoint valid) and
// the existing approval mode, bounded by a hard timeout, a bounded generation
// (max tokens), and an output-size cap, and redacted. The result is emitted as
// text or JSON. This is the "invoke" step of the provider extension lifecycle
// that the read-only provider contract (provider-contract.ts) deliberately
// deferred — it resolved the non-secret Config but never issued a request. It
// reuses #118's version negotiation, deterministic selection, and Config
// resolution rather than re-implementing them, and mirrors the governed tool and
// MCP invocation paths (tool-invocation.ts, mcp-invocation.ts), completing the
// provider/tool/MCP invocation triad.
//
// Trust boundary: the provider endpoint and every byte it returns are untrusted
// input. The selected provider must be `ready` (a missing credential or an
// invalid endpoint is never called). The credential is supplied by an
// environment-variable name and its value is never printed, logged, or sent
// through the approval prompt — only the variable name is reported. The endpoint
// is reported as a redacted host. The request is bounded in time, generation,
// and captured output; the response is redacted (secrets and home/workspace
// paths). Any failure — unresolved readiness, missing approval, auth rejection,
// rate limiting, network error, API error, timeout, oversized output, or an
// empty response — fails closed with a safe redacted result and never crashes
// the run.

import path from "node:path";
import OpenAI from "openai";
import type { Config } from "./config.js";
import { redactHomePath, redactSecrets, redactEndpointHost } from "./permission-impact.js";
import type { ApprovalMode } from "./approval.js";
import { needsApproval, promptApproval } from "./approval.js";
import {
  resolveSelectedProvider,
  resolveProviderReadiness,
  resolveProviderConfig,
  type ProviderEntry,
} from "./provider-contract.js";
import {
  clampInvokeTimeout,
  redactToolOutput,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./tool-invocation.js";

export const PROVIDER_INVOCATION_SCHEMA = "oh-my-cli.provider-invocation";
export const PROVIDER_INVOCATION_VERSION = 1;

// A provider request is a network call to an external model API: it can spend
// credit, read whatever the endpoint returns, and exfiltrate the prompt. There
// is no dedicated "network" approval category, so it is gated as the most
// cautious built-in category (a shell mutation): under `default`/`auto-edit` it
// requires approval; only `yolo` auto-approves it.
const PROVIDER_APPROVAL_CATEGORY = "mutate-shell" as const;

// Bounded generation size (tokens) for the single request. A provider will not
// return more than this, so the response is inherently bounded in memory; the
// output-size cap then bounds what enters the report.
export const DEFAULT_MAX_TOKENS = 256;
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 4096;

// The minimal, safe prompt issued when the caller does not supply one. Mirrors
// the connectivity preflight's "ping" so a default invocation proves the
// contract end to end without crafting a bespoke prompt.
const DEFAULT_PROVIDER_PROMPT = "ping";

export function clampMaxTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)));
}

// The gate that decided whether the provider was called:
//   passed     — readiness satisfied and approved; called.
//   not-ready  — credential missing or endpoint invalid; never called.
//   unapproved — approval was required and not granted; never called.
export type ProviderInvocationGate = "passed" | "not-ready" | "unapproved";

// The runtime outcome of a called request. Only `called` is a success; every
// other value is a bounded, fail-closed failure.
export type ProviderOutcome =
  | "called" // a response with content was returned
  | "empty" // the provider returned no content
  | "auth-rejected" // 401/403
  | "unsupported-model" // 404 referencing the model
  | "rate-limited" // 429
  | "network-error" // connection failure
  | "api-error" // any other HTTP/API error
  | "timeout" // exceeded the hard timeout
  | "output-capped"; // captured response exceeded the output-size cap

export interface ProviderRunOptions {
  config: Config;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

// The raw, unredacted outcome of one bounded provider request. Redaction happens
// when the report is built, never here. The credential is never part of it.
export interface ProviderRunResult {
  outcome: ProviderOutcome;
  /** Raw response text (redacted later). */
  text: string;
  finishReason: string | null;
  /** HTTP status carried by an API error, when available. */
  status: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  elapsedMs: number;
  /** Raw reason (redacted later). */
  reason: string;
}

// Runs the bounded provider request and reports its raw outcome. Injectable so
// tests can drive the gate logic deterministically without a live endpoint.
export type ProviderRunner = (opts: ProviderRunOptions) => Promise<ProviderRunResult>;

// Default runner: issue one non-streaming chat completion through the OpenAI
// SDK against the resolved Config, bounded by a single hard timeout (an
// AbortController aborts the in-flight request), a bounded generation
// (max_tokens), and an output-size cap on the captured text. The SDK's own
// retries are disabled so a hung endpoint cannot multiply the wait. Every
// outcome is reported, never thrown; the credential is used only to construct
// the client and never returned.
export const openaiProviderRunner: ProviderRunner = async (opts) => {
  const start = Date.now();
  const client = new OpenAI({
    apiKey: opts.config.apiKey,
    baseURL: opts.config.baseUrl,
    maxRetries: 0,
  });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  try {
    const completion = await client.chat.completions.create(
      {
        model: opts.config.model,
        messages: [{ role: "user", content: opts.prompt }],
        max_tokens: opts.maxTokens,
        stream: false,
      },
      { signal: controller.signal },
    );
    const choice = completion.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    const usage = completion.usage;
    const tokens = {
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    };
    const text = choice?.message?.content ?? "";
    const capped = capOutput(text, opts.maxOutputBytes);
    if (capped.capped) {
      return {
        outcome: "output-capped",
        text: capped.text,
        finishReason,
        status: null,
        ...tokens,
        timedOut: false,
        outputCapped: true,
        elapsedMs: Date.now() - start,
        reason: `provider response exceeded the ${opts.maxOutputBytes}-byte output cap`,
      };
    }
    if (!text) {
      return {
        outcome: "empty",
        text: "",
        finishReason,
        status: null,
        ...tokens,
        timedOut: false,
        outputCapped: false,
        elapsedMs: Date.now() - start,
        reason: "provider returned no content",
      };
    }
    return {
      outcome: "called",
      text: capped.text,
      finishReason,
      status: null,
      ...tokens,
      timedOut: false,
      outputCapped: false,
      elapsedMs: Date.now() - start,
      reason: "provider returned a response",
    };
  } catch (err) {
    if (timedOut) {
      return {
        outcome: "timeout",
        text: "",
        finishReason: null,
        status: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        timedOut: true,
        outputCapped: false,
        elapsedMs: Date.now() - start,
        reason: `provider request exceeded the ${opts.timeoutMs}ms hard timeout`,
      };
    }
    const classified = classifyProviderError(err);
    return {
      outcome: classified.outcome,
      text: "",
      finishReason: null,
      status: classified.status,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      timedOut: false,
      outputCapped: false,
      elapsedMs: Date.now() - start,
      reason: classified.reason,
    };
  } finally {
    clearTimeout(timer);
  }
};

// Bound captured response text to the output cap so an unexpectedly large body
// cannot flood the report.
function capOutput(text: string, maxBytes: number): { text: string; capped: boolean } {
  if (text.length <= maxBytes) return { text, capped: false };
  return { text: text.slice(0, maxBytes), capped: true };
}

// Classify a thrown SDK/network error into a bounded outcome. The credential is
// never part of an SDK error message; the reason is still redacted when the
// report is built.
function classifyProviderError(err: unknown): {
  outcome: ProviderOutcome;
  status: number | null;
  reason: string;
} {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    error?: { message?: string };
    cause?: { code?: string };
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = e.code ?? e.cause?.code;
  const msg = e.message ?? e.error?.message ?? "";
  const lower = msg.toLowerCase();
  if (status === 401 || status === 403) {
    return { outcome: "auth-rejected", status, reason: `provider rejected authentication (${status})` };
  }
  if (status === 404 && lower.includes("model")) {
    return {
      outcome: "unsupported-model",
      status,
      reason: `provider reported the model is not available (${status})`,
    };
  }
  if (status === 429) {
    return { outcome: "rate-limited", status, reason: "provider rate limited the request (429)" };
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return {
      outcome: "network-error",
      status: status ?? null,
      reason: `provider endpoint unreachable (${code})`,
    };
  }
  if (status !== undefined) {
    return { outcome: "api-error", status, reason: `provider returned an API error (${status})` };
  }
  return { outcome: "api-error", status: null, reason: `provider request failed: ${msg || "unknown error"}` };
}

export interface ProviderInvocationReport {
  schema: string;
  version: number;
  contractVersion: number;
  providerId: string;
  endpoint: string;
  endpointSource: "settings" | "default";
  model: string;
  credentialVariable: string;
  credentialFromSettings: boolean;
  /** Length of the prompt, not its text — the prompt is never echoed. */
  promptChars: number;
  gate: ProviderInvocationGate;
  invoked: boolean;
  /** The ProviderOutcome when invoked, or the gate value when refused. */
  outcome: string;
  status: number | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  outputCapBytes: number;
  timeoutMs: number;
  maxTokens: number;
  elapsedMs: number;
  content: string;
  reason: string;
  settings: string;
}

// Map a resolved invocation report to a process exit code:
//   2 — refused before calling (not ready, or unapproved).
//   1 — called but failed at runtime (empty, auth-rejected, unsupported-model,
//       rate-limited, network-error, api-error, timeout, oversized output).
//   0 — called and a response was returned (outcome `called`).
// Contract/selection/version errors are thrown by resolveSelectedProvider and
// mapped to exit 2 by the caller, distinct from a request runtime failure.
export function providerInvocationExitCode(report: ProviderInvocationReport): number {
  if (report.gate !== "passed") return 2;
  if (report.timedOut || report.outputCapped) return 1;
  return report.outcome === "called" ? 0 : 1;
}

export interface InvokeProviderOptions {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  providerId?: string;
  prompt?: string;
  workspace: string;
  approvalMode: ApprovalMode;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxTokens?: number;
  /** Override the provider runner (tests). Defaults to the OpenAI client. */
  runner?: ProviderRunner;
}

// Resolve, gate, and (if every gate passes) issue one bounded model request to
// one provider. Throws the same redacted errors as the read-only contract for
// contract/selection/version failures (caller maps to exit 2); every other
// failure resolves to a safe redacted report (gate refusal or bounded runtime
// failure) and never throws.
export async function invokeProvider(opts: InvokeProviderOptions): Promise<ProviderInvocationReport> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? openaiProviderRunner;
  const timeoutMs = clampInvokeTimeout(opts.timeoutMs);
  const maxOutputBytes =
    typeof opts.maxOutputBytes === "number" && opts.maxOutputBytes > 0
      ? Math.floor(opts.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  const maxTokens = clampMaxTokens(opts.maxTokens);
  const workspace = path.resolve(opts.workspace);
  const prompt =
    typeof opts.prompt === "string" && opts.prompt.length > 0 ? opts.prompt : DEFAULT_PROVIDER_PROMPT;

  // Resolve via #118's contract (version negotiation, selection). A
  // contract/selection/version error throws here (caller → exit 2).
  const resolved = resolveSelectedProvider({
    settingsPath: opts.settingsPath,
    env,
    providerId: opts.providerId,
  });
  const entry: ProviderEntry = resolved.entry;
  const readiness = resolveProviderReadiness(entry, { env });

  const base = {
    schema: PROVIDER_INVOCATION_SCHEMA,
    version: PROVIDER_INVOCATION_VERSION,
    contractVersion: resolved.contractVersion,
    providerId: entry.id,
    endpoint: readiness.endpointValid ? redactEndpointHost(readiness.baseUrl) : "<invalid>",
    endpointSource: readiness.endpointSource,
    model: entry.model,
    credentialVariable: readiness.credentialVariable,
    credentialFromSettings: readiness.credentialFromSettings,
    promptChars: prompt.length,
    timeoutMs,
    outputCapBytes: maxOutputBytes,
    maxTokens,
    settings: resolved.settingsFound
      ? redactHomePath(resolved.settingsPath)
      : `${redactHomePath(resolved.settingsPath)} (not found)`,
  };

  const refused = (gate: ProviderInvocationGate, reason: string): ProviderInvocationReport => ({
    ...base,
    gate,
    invoked: false,
    outcome: gate,
    status: null,
    finishReason: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    timedOut: false,
    outputCapped: false,
    elapsedMs: 0,
    content: "",
    reason,
  });

  // Gate 1 — readiness: only a provider whose Config resolves (credential
  // available, endpoint valid) may be called.
  if (readiness.state !== "ready") {
    return refused("not-ready", `${readiness.reason}; invocation requires a ready provider`);
  }

  // Gate 2 — approval mode: a provider network call is gated as the most
  // cautious category. When approval is required, an interactive terminal may
  // grant it; a non-interactive run fails closed unless the mode is `yolo`. The
  // credential value is never part of the prompt.
  if (needsApproval(opts.approvalMode, PROVIDER_APPROVAL_CATEGORY)) {
    const approved = await promptApproval("provider", {
      provider: entry.id,
      endpoint: base.endpoint,
      model: entry.model,
    });
    if (!approved) {
      return refused(
        "unapproved",
        `provider invocation requires approval under approval mode "${opts.approvalMode}"; not called`,
      );
    }
  }

  // Every gate passed: resolve the Config (guaranteed to succeed now that
  // readiness holds) and issue one bounded request.
  const config = resolveProviderConfig(entry, { env });
  const run = await runner({ config, prompt, maxTokens, timeoutMs, maxOutputBytes });

  return {
    ...base,
    gate: "passed",
    invoked: true,
    outcome: run.outcome,
    status: run.status,
    finishReason: run.finishReason,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    totalTokens: run.totalTokens,
    timedOut: run.timedOut,
    outputCapped: run.outputCapped,
    elapsedMs: run.elapsedMs,
    content: redactToolOutput(run.text, workspace),
    reason: redactToolOutput(run.reason, workspace),
  };
}

// A redacted, human-readable summary of a provider invocation. Never includes the
// credential value or the prompt text.
export function formatProviderInvocation(report: ProviderInvocationReport): string {
  const reason = redactSecrets(report.reason).text;
  const lines: string[] = [
    `Provider:     ${report.providerId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Endpoint:     ${report.endpoint} (${report.endpointSource})`,
    `Model:        ${report.model}`,
    `Credential:   ${report.credentialVariable}`,
    `Prompt:       ${report.promptChars} chars`,
    `Gate:         ${report.gate}`,
    `Invoked:      ${report.invoked}`,
  ];
  if (report.invoked) {
    lines.push(`Outcome:      ${report.outcome}`);
    if (report.status !== null) lines.push(`Status:       ${report.status}`);
    if (report.totalTokens !== null) {
      lines.push(
        `Tokens:       ${report.totalTokens} (prompt ${report.promptTokens ?? 0}, completion ${report.completionTokens ?? 0})`,
      );
    }
    lines.push(
      `Bounds:       ${report.elapsedMs}ms (timeout ${report.timeoutMs}ms, max tokens ${report.maxTokens}, output cap ${report.outputCapBytes} bytes)`,
    );
    if (report.timedOut) lines.push("Timed out:    yes");
    if (report.outputCapped) lines.push("Output cap:   exceeded");
  }
  lines.push(`Reason:       ${reason}`);
  if (report.invoked && report.content) {
    lines.push(`Result:       ${collapse(report.content)}`);
  }
  lines.push(`Settings:     ${report.settings}`);
  return lines.join("\n");
}

// Collapse whitespace and bound a captured result for the one-line text view.
const MAX_DISPLAY_OUTPUT = 240;
function collapse(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_DISPLAY_OUTPUT) return oneLine;
  return `${oneLine.slice(0, MAX_DISPLAY_OUTPUT)} …[+${oneLine.length - MAX_DISPLAY_OUTPUT} chars]`;
}
