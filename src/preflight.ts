import OpenAI from "openai";
import type { Config } from "./config.js";

export type PreflightResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; category: PreflightFailure; message: string };

export type PreflightFailure =
  | "missing_config"
  | "auth_rejected"
  | "network_failure"
  | "unsupported_model"
  | "unknown_error";

export async function runPreflight(config: Config): Promise<PreflightResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  const start = Date.now();

  try {
    await client.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });

    return { ok: true, model: config.model, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return classifyError(err, config);
  }
}

function classifyError(err: unknown, config: Config): PreflightResult {
  const e = err as {
    status?: number;
    code?: string;
    message?: string;
    error?: { message?: string; code?: string; type?: string };
    cause?: { code?: string };
  };

  const status = e.status;
  const code = e.code ?? e.cause?.code;
  const msg = e.message ?? e.error?.message ?? "";
  const errMsg = e.error;

  if (status === 401 || status === 403) {
    return {
      ok: false,
      category: "auth_rejected",
      message: `Authentication failed (${status}). Check OPENAI_API_KEY.`,
    };
  }

  if (status === 404 && (msg.toLowerCase().includes("model") || errMsg?.message?.toLowerCase().includes("model"))) {
    return {
      ok: false,
      category: "unsupported_model",
      message: `Model "${config.model}" is not available at ${config.baseUrl}. Check OPENAI_MODEL.`,
    };
  }

  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return {
      ok: false,
      category: "network_failure",
      message: `Cannot reach ${config.baseUrl} (${code}). Check OPENAI_BASE_URL and network.`,
    };
  }

  if (!config.apiKey || !config.model) {
    return {
      ok: false,
      category: "missing_config",
      message: "Missing OPENAI_API_KEY or OPENAI_MODEL. Set both environment variables.",
    };
  }

  if (status === 404) {
    return {
      ok: false,
      category: "network_failure",
      message: `Endpoint not found at ${config.baseUrl}. Check OPENAI_BASE_URL.`,
    };
  }

  if (status === 429) {
    return {
      ok: false,
      category: "network_failure",
      message: "Rate limited by provider. Connection is valid but requests are throttled.",
    };
  }

  return {
    ok: false,
    category: "unknown_error",
    message: `Unexpected error: ${msg || "unknown"}. Status: ${status ?? "none"}.`,
  };
}

export function formatPreflight(result: PreflightResult): string {
  if (result.ok) {
    return `✓ Provider connected: model "${result.model}" (${result.latencyMs}ms)`;
  }
  return `✗ Preflight failed [${result.category}]: ${result.message}`;
}
