// Unified user settings: resolve non-secret model configuration from a durable
// user-owned settings file while keeping credentials in named environment
// variables. The same file backs the MCP/extension health inventory
// (health-inventory.ts); this module reads only the optional `model` section so
// the two surfaces share one coherent configuration file.
//
// Trust boundary: the default settings file is the user-owned
// ~/.oh-my-cli/settings.json. Project-local files are never discovered
// automatically — only the user default or a path the user explicitly supplies
// may select a model endpoint, so an untrusted repository cannot silently
// redirect a credential to an attacker-controlled host. Raw credential fields
// (e.g. `apiKey`) are rejected rather than ignored, and the resolved credential
// value is never printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { DEFAULT_BASE_URL } from "./config.js";
import { redactHomePath, redactEndpointHost } from "./permission-impact.js";

// The user-owned default settings file. Never a project-local path.
export function defaultUserSettingsPath(): string {
  return path.join(os.homedir(), ".oh-my-cli", "settings.json");
}

// Apply the explicit settings path when the user supplied one; otherwise fall
// back to the user-owned default. An empty/whitespace value is treated as unset.
export function resolveSettingsPath(explicit?: string): string {
  return explicit && explicit.trim() ? explicit : defaultUserSettingsPath();
}

// Raw secret field names that must never appear in the model section. The parser
// rejects (rather than ignores) them so a plaintext secret cannot become a
// supported configuration path that users are encouraged to commit.
const FORBIDDEN_MODEL_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

export interface ModelSettings {
  baseUrl?: string;
  name: string;
  apiKeyEnv?: string;
}

// Only the model name is required from the settings file; the base URL falls back
// to the environment then the built-in default, and the credential is supplied
// by `apiKeyEnv` (an environment-variable name) or `OPENAI_API_KEY`.
const ModelSettingsSchema = z.object({
  baseUrl: z.string().url("settings.model.baseUrl must be a valid URL").optional(),
  name: z
    .string({
      required_error: "settings.model.name is required",
      invalid_type_error: "settings.model.name must be a string",
    })
    .min(1, "settings.model.name is required"),
  apiKeyEnv: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "settings.model.apiKeyEnv must be a valid environment variable name",
    )
    .optional(),
});

export type ConfigSource = "env" | "settings" | "default";

// The resolved configuration plus non-secret provenance: which source won for
// each field and which environment variable holds the credential. The credential
// value itself is never recorded here.
export interface ResolvedConfig {
  config: Config;
  settingsPath: string;
  settingsFound: boolean;
  baseUrlSource: ConfigSource;
  modelSource: "env" | "settings";
  credentialVariable: string;
  credentialFromSettings: boolean;
  // The named model profile that produced this configuration, when one was
  // selected (via --profile or settings.defaultProfile). Absent for the legacy
  // single `model` section. Never carries a credential value.
  profile?: string;
}

interface ModelSection {
  found: boolean;
  model?: ModelSettings;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

// Read and validate only the optional `model` section of the settings file.
// Throws a redacted, actionable error on invalid JSON, a non-object root, a raw
// credential field, or a malformed model section — all before any provider
// request. A missing file or absent `model` section is not an error: the caller
// then falls back to environment configuration.
function readModelSection(settingsPath: string): ModelSection {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return { found: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} contains invalid JSON`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} must contain a JSON object`);
  }

  const root = parsed as Record<string, unknown>;
  const model = root.model;
  if (model === undefined) {
    return { found: true };
  }
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("Settings error: settings.model must be an object");
  }

  const modelObj = model as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_MODEL_KEYS) {
    if (forbidden in modelObj) {
      throw new Error(
        `Settings error: settings.model.${forbidden} is a raw credential field; store the ` +
          "credential in an environment variable and reference it via settings.model.apiKeyEnv",
      );
    }
  }

  const result = ModelSettingsSchema.safeParse(modelObj);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Settings error: ${issues}`);
  }
  return { found: true, model: result.data };
}

// Resolve a validated model configuration from a settings-provided model section
// (or a selected model profile, which has the same shape) layered under
// environment variables. Precedence, highest first:
//   baseUrl:    OPENAI_BASE_URL > model.baseUrl > built-in default
//   model name: OPENAI_MODEL    > model.name    > (required)
//   credential: OPENAI_API_KEY  > env[model.apiKeyEnv] > (required)
// Every failure raises a redacted error before any network request. `model` may
// be undefined (no settings model section): resolution then falls back to the
// environment and built-in defaults. `profile`, when given, is recorded as
// non-secret provenance so headless runs can report the selected profile.
export function resolveModelFromSettings(
  model: ModelSettings | undefined,
  opts: {
    env: Record<string, string | undefined>;
    settingsPath: string;
    settingsFound: boolean;
    profile?: string;
  },
): ResolvedConfig {
  const env = opts.env;

  let baseUrl: string;
  let baseUrlSource: ConfigSource;
  const envBaseUrl = envValue(env, "OPENAI_BASE_URL");
  if (envBaseUrl !== undefined) {
    baseUrl = envBaseUrl;
    baseUrlSource = "env";
  } else if (model?.baseUrl) {
    baseUrl = model.baseUrl;
    baseUrlSource = "settings";
  } else {
    baseUrl = DEFAULT_BASE_URL;
    baseUrlSource = "default";
  }

  let modelName: string;
  let modelSource: "env" | "settings";
  const envModel = envValue(env, "OPENAI_MODEL");
  if (envModel !== undefined) {
    modelName = envModel;
    modelSource = "env";
  } else if (model?.name) {
    modelName = model.name;
    modelSource = "settings";
  } else {
    throw new Error(
      "Configuration error: no model configured; set OPENAI_MODEL or settings.model.name",
    );
  }

  let apiKey: string;
  let credentialVariable: string;
  let credentialFromSettings = false;
  const envKey = envValue(env, "OPENAI_API_KEY");
  if (envKey !== undefined) {
    apiKey = envKey;
    credentialVariable = "OPENAI_API_KEY";
  } else if (model?.apiKeyEnv) {
    credentialVariable = model.apiKeyEnv;
    credentialFromSettings = true;
    const named = envValue(env, model.apiKeyEnv);
    if (named === undefined) {
      throw new Error(
        `Configuration error: credential environment variable ${model.apiKeyEnv} ` +
          "(named by settings.model.apiKeyEnv) is not set",
      );
    }
    apiKey = named;
  } else {
    throw new Error(
      "Configuration error: no credential available; set OPENAI_API_KEY, or set " +
        "settings.model.apiKeyEnv to the name of an environment variable holding the credential",
    );
  }

  if (!isValidUrl(baseUrl)) {
    throw new Error(`Configuration error: model base URL from ${baseUrlSource} is not a valid URL`);
  }

  return {
    config: { apiKey, baseUrl, model: modelName },
    settingsPath: opts.settingsPath,
    settingsFound: opts.settingsFound,
    baseUrlSource,
    modelSource,
    credentialVariable,
    credentialFromSettings,
    ...(opts.profile ? { profile: opts.profile } : {}),
  };
}

// Resolve the validated model configuration from the user settings file layered
// under environment variables (see resolveModelFromSettings for precedence).
// This is the legacy single-`model`-section path; model-profiles.ts layers named
// profile selection on top of the same resolver.
export function resolveModelConfig(
  opts: { settingsPath?: string; env?: Record<string, string | undefined> } = {},
): ResolvedConfig {
  const env = opts.env ?? process.env;
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, model } = readModelSection(settingsPath);
  return resolveModelFromSettings(model, { env, settingsPath, settingsFound: found });
}

function isValidUrl(u: string): boolean {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

// A redacted, human-readable summary of the resolved configuration: the selected
// model, endpoint host, settings source, and credential environment-variable
// name. Never the credential value, URL userinfo, sensitive query parameters, or
// an unredacted home path.
export function describeResolvedConfig(resolved: ResolvedConfig): string {
  const settings = resolved.settingsFound
    ? redactHomePath(resolved.settingsPath)
    : `${redactHomePath(resolved.settingsPath)} (not found)`;
  const lines = [
    `Model:      ${resolved.config.model} (${resolved.modelSource})`,
    `Endpoint:   ${redactEndpointHost(resolved.config.baseUrl)} (${resolved.baseUrlSource})`,
    `Settings:   ${settings}`,
    `Credential: ${resolved.credentialVariable}`,
  ];
  // The profile name is a settings map key (non-secret), so it is safe to show.
  if (resolved.profile) {
    lines.unshift(`Profile:    ${resolved.profile}`);
  }
  return lines.join("\n");
}
