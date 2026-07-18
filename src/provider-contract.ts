// Provider extension contract: declare one or more model providers as a versioned
// section of the unified user settings file (settings.ts), then negotiate the
// contract version, select a provider, and resolve its non-secret configuration
// — all without changing core code. This is the additive extensibility primitive
// the rest of the secure-extensibility roadmap (tool/MCP lifecycle, discovery)
// builds on.
//
// Trust boundary: provider definitions are untrusted input. The same user-owned
// settings file backs the model section (settings.ts) and the MCP/extension
// health inventory (health-inventory.ts); project-local files are never
// discovered automatically. Raw credential fields (e.g. `apiKey`) inside a
// provider entry are rejected rather than ignored, the credential is supplied by
// an environment-variable name (`apiKeyEnv`) or `OPENAI_API_KEY`, and the
// resolved credential value is never printed. An unsupported contract version
// fails closed instead of being silently coerced.

import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { DEFAULT_BASE_URL } from "./config.js";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath, redactEndpointHost } from "./permission-impact.js";

export const PROVIDER_CONTRACT_SCHEMA = "oh-my-cli.provider-contract";
export const PROVIDER_CONTRACT_VERSION = 1;

// The contract versions this build can negotiate. A settings file declaring a
// version outside this range is refused (fail closed) rather than coerced, so a
// future format change cannot silently reinterpret an older or newer definition.
export const SUPPORTED_PROVIDER_CONTRACT_VERSIONS: readonly number[] = [1];

// Raw secret field names that must never appear in a provider entry. The parser
// rejects (rather than ignores) them so a plaintext secret cannot become a
// supported configuration path that users are encouraged to commit.
const FORBIDDEN_PROVIDER_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// Bounded, optional capability flags. Unknown flags are ignored (forward
// compatible within a contract version); these are advisory metadata only and
// never widen the trust boundary.
export interface ProviderCapabilityFlags {
  vision?: boolean;
  tools?: boolean;
  streaming?: boolean;
}

// One declared provider. `model` is the default model; `models` is an optional
// catalog of additional allowed model names. `baseUrl` falls back to the
// built-in default; the credential is named by `apiKeyEnv` (or `OPENAI_API_KEY`).
export interface ProviderEntry {
  id: string;
  baseUrl?: string;
  model: string;
  models?: string[];
  apiKeyEnv?: string;
  capabilities?: ProviderCapabilityFlags;
}

// The validated `providers` section: a negotiated contract version, an optional
// default provider id, and the validated entries (ids guaranteed unique).
export interface ProviderContract {
  contractVersion: number;
  default?: string;
  entries: ProviderEntry[];
}

const CapabilitySchema = z
  .object({
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    streaming: z.boolean().optional(),
  })
  .optional();

const ProviderEntrySchema = z.object({
  id: z.string().min(1, "providers.entries[].id must be a non-empty string"),
  baseUrl: z.string().url("providers.entries[].baseUrl must be a valid URL").optional(),
  model: z.string().min(1, "providers.entries[].model is required"),
  models: z.array(z.string().min(1, "providers.entries[].models entries must be non-empty")).optional(),
  apiKeyEnv: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "providers.entries[].apiKeyEnv must be a valid environment variable name",
    )
    .optional(),
  capabilities: CapabilitySchema,
});

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function isValidUrl(u: string): boolean {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

interface ProvidersSection {
  found: boolean;
  section?: unknown;
}

// Read and return only the optional `providers` section of the settings file.
// Throws a redacted, actionable error on invalid JSON or a non-object root —
// before any provider request. A missing file or absent `providers` section is
// not an error here; the caller decides how to treat that.
function readProvidersSection(settingsPath: string): ProvidersSection {
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
  const providers = root.providers;
  if (providers === undefined) {
    return { found: true };
  }
  return { found: true, section: providers };
}

// Validate an untrusted `providers` section into a ProviderContract. Negotiates
// the contract version (fail closed on an unsupported version), rejects raw
// credential fields per entry, enforces unique ids, and validates that any
// declared default references a defined entry. Every failure raises a redacted,
// deterministic error.
export function parseProviderContract(section: unknown): ProviderContract {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.providers must be an object");
  }
  const obj = section as Record<string, unknown>;

  // Version negotiation: a required integer within the supported range.
  const version = obj.contractVersion;
  if (version === undefined) {
    throw new Error("Settings error: settings.providers.contractVersion is required");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Settings error: settings.providers.contractVersion must be an integer");
  }
  if (!SUPPORTED_PROVIDER_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `Settings error: provider contract version ${version} is not supported; ` +
        `supported versions: ${SUPPORTED_PROVIDER_CONTRACT_VERSIONS.join(", ")}`,
    );
  }

  let def: string | undefined;
  if (obj.default !== undefined) {
    if (typeof obj.default !== "string" || obj.default.trim() === "") {
      throw new Error("Settings error: settings.providers.default must be a non-empty string");
    }
    def = obj.default;
  }

  const rawEntries = obj.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error("Settings error: settings.providers.entries must be a non-empty array");
  }

  const entries: ProviderEntry[] = [];
  const seen = new Set<string>();
  rawEntries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Settings error: settings.providers.entries[${index}] must be an object`);
    }
    const entryObj = entry as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_PROVIDER_KEYS) {
      if (forbidden in entryObj) {
        const label =
          typeof entryObj.id === "string" && entryObj.id ? `"${entryObj.id}"` : `[${index}]`;
        throw new Error(
          `Settings error: provider ${label} field "${forbidden}" is a raw credential field; ` +
            "store the credential in an environment variable and reference it via apiKeyEnv",
        );
      }
    }
    const result = ProviderEntrySchema.safeParse(entryObj);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: ${issues}`);
    }
    if (seen.has(result.data.id)) {
      throw new Error(`Settings error: duplicate provider id "${result.data.id}"`);
    }
    seen.add(result.data.id);
    entries.push(result.data);
  });

  if (def !== undefined && !seen.has(def)) {
    throw new Error(
      `Settings error: settings.providers.default "${def}" is not a defined provider id`,
    );
  }

  return { contractVersion: version, default: def, entries };
}

// Deterministically select one provider entry: an explicit id wins, then the
// declared default, then the sole entry. Ambiguity (multiple entries, no id, no
// default) and unknown ids fail closed with a clear reason.
export function selectProviderEntry(
  contract: ProviderContract,
  opts: { providerId?: string } = {},
): ProviderEntry {
  const wanted = opts.providerId && opts.providerId.trim() ? opts.providerId.trim() : undefined;
  if (wanted !== undefined) {
    const found = contract.entries.find((e) => e.id === wanted);
    if (!found) {
      throw new Error(`Provider error: provider "${wanted}" is not defined in settings.providers`);
    }
    return found;
  }
  if (contract.default !== undefined) {
    const found = contract.entries.find((e) => e.id === contract.default);
    if (!found) {
      throw new Error(
        `Provider error: default provider "${contract.default}" is not defined in settings.providers`,
      );
    }
    return found;
  }
  if (contract.entries.length === 1) {
    return contract.entries[0];
  }
  throw new Error(
    "Provider error: multiple providers defined; select one via --provider <id> or settings.providers.default",
  );
}

// Resolve a selected provider entry into the same Config the model path consumes,
// proving the contract is directly usable end to end. The credential is resolved
// from the entry's `apiKeyEnv` (or `OPENAI_API_KEY` when absent); a missing
// credential fails with a redacted, actionable error. Never returns the secret.
export function resolveProviderConfig(
  entry: ProviderEntry,
  opts: { env?: Record<string, string | undefined> } = {},
): Config {
  const env = opts.env ?? process.env;
  const baseUrl = entry.baseUrl ?? DEFAULT_BASE_URL;
  if (!isValidUrl(baseUrl)) {
    throw new Error(`Provider error: provider "${entry.id}" base URL is not a valid URL`);
  }
  const credentialVariable = entry.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = envValue(env, credentialVariable);
  if (apiKey === undefined) {
    throw new Error(
      `Provider error: credential environment variable ${credentialVariable} ` +
        `for provider "${entry.id}" is not set`,
    );
  }
  return { apiKey, baseUrl, model: entry.model };
}

// The redacted, serializable result of inspecting a provider contract. No secret
// value, no URL userinfo/path/query, and no unredacted home path.
export interface ProviderContractReport {
  schema: string;
  version: number;
  contractVersion: number;
  providerId: string;
  endpoint: string;
  endpointSource: "settings" | "default";
  model: string;
  modelCatalog: string[];
  credentialVariable: string;
  credentialFromSettings: boolean;
  credentialAvailable: boolean;
  capabilities: ProviderCapabilityFlags;
  settings: string;
}

// Pure builder for the redacted report from already-resolved facts.
export function buildProviderContractReport(facts: {
  contractVersion: number;
  entry: ProviderEntry;
  baseUrl: string;
  endpointSource: "settings" | "default";
  credentialVariable: string;
  credentialFromSettings: boolean;
  credentialAvailable: boolean;
  settingsPath: string;
  settingsFound: boolean;
}): ProviderContractReport {
  return {
    schema: PROVIDER_CONTRACT_SCHEMA,
    version: PROVIDER_CONTRACT_VERSION,
    contractVersion: facts.contractVersion,
    providerId: facts.entry.id,
    endpoint: redactEndpointHost(facts.baseUrl),
    endpointSource: facts.endpointSource,
    model: facts.entry.model,
    modelCatalog: facts.entry.models ?? [],
    credentialVariable: facts.credentialVariable,
    credentialFromSettings: facts.credentialFromSettings,
    credentialAvailable: facts.credentialAvailable,
    capabilities: facts.entry.capabilities ?? {},
    settings: facts.settingsFound
      ? redactHomePath(facts.settingsPath)
      : `${redactHomePath(facts.settingsPath)} (not found)`,
  };
}

export interface ProviderResolutionOptions {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  providerId?: string;
}

// The selected provider entry plus the settings context it was resolved from.
// Readiness (credential availability, endpoint validity) is decided separately
// by resolveProviderReadiness so the read-only report can surface it without
// gating while the invocation path can gate on it.
export interface ResolvedProvider {
  contractVersion: number;
  entry: ProviderEntry;
  settingsPath: string;
  settingsFound: boolean;
}

// Read the user settings file, negotiate the provider contract, and select one
// provider entry — the shared resolution step behind both the read-only contract
// report (collectProviderContract) and the governed invocation path
// (provider-invocation.ts). Throws the same redacted contract/selection/version
// errors; readiness is decided by the caller, not here.
export function resolveSelectedProvider(opts: ProviderResolutionOptions = {}): ResolvedProvider {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readProvidersSection(settingsPath);
  if (section === undefined) {
    throw new Error(
      found
        ? "Provider error: settings file has no settings.providers section"
        : `Provider error: settings file not found at ${redactHomePath(settingsPath)}`,
    );
  }
  const contract = parseProviderContract(section);
  const entry = selectProviderEntry(contract, { providerId: opts.providerId });
  return { contractVersion: contract.contractVersion, entry, settingsPath, settingsFound: found };
}

// A provider is `ready` to be invoked when its endpoint is a valid URL and its
// credential environment variable is currently exported; otherwise it is
// `not-ready`. No secret value is read or returned — only the variable name and
// whether it is set. This is the gate the invocation path (#149) applies before
// issuing a request; the read-only report surfaces the same facts without gating.
export type ProviderReadinessState = "ready" | "not-ready";

export interface ProviderReadiness {
  state: ProviderReadinessState;
  reason: string;
  baseUrl: string;
  endpointSource: "settings" | "default";
  endpointValid: boolean;
  credentialVariable: string;
  credentialFromSettings: boolean;
  credentialAvailable: boolean;
}

export function resolveProviderReadiness(
  entry: ProviderEntry,
  opts: { env?: Record<string, string | undefined> } = {},
): ProviderReadiness {
  const env = opts.env ?? process.env;
  const baseUrl = entry.baseUrl ?? DEFAULT_BASE_URL;
  const endpointValid = isValidUrl(baseUrl);
  const credentialVariable = entry.apiKeyEnv ?? "OPENAI_API_KEY";
  const credentialAvailable = envValue(env, credentialVariable) !== undefined;
  let state: ProviderReadinessState = "ready";
  let reason = "credential available and endpoint valid";
  if (!endpointValid) {
    state = "not-ready";
    reason = `provider "${entry.id}" base URL is not a valid URL`;
  } else if (!credentialAvailable) {
    state = "not-ready";
    reason = `credential environment variable ${credentialVariable} for provider "${entry.id}" is not set`;
  }
  return {
    state,
    reason,
    baseUrl,
    endpointSource: entry.baseUrl ? "settings" : "default",
    endpointValid,
    credentialVariable,
    credentialFromSettings: entry.apiKeyEnv !== undefined,
    credentialAvailable,
  };
}

// Read the user settings file, negotiate the provider contract, select one
// provider, and build the redacted report. Throws a redacted error when no
// `providers` section exists or the contract is invalid. Credential availability
// is reported (not gated): the contract is valid even when the credential is not
// currently exported.
export function collectProviderContract(
  opts: {
    settingsPath?: string;
    env?: Record<string, string | undefined>;
    providerId?: string;
  } = {},
): ProviderContractReport {
  const env = opts.env ?? process.env;
  const resolved = resolveSelectedProvider({
    settingsPath: opts.settingsPath,
    env,
    providerId: opts.providerId,
  });
  const entry = resolved.entry;
  const readiness = resolveProviderReadiness(entry, { env });
  return buildProviderContractReport({
    contractVersion: resolved.contractVersion,
    entry,
    baseUrl: readiness.baseUrl,
    endpointSource: readiness.endpointSource,
    credentialVariable: readiness.credentialVariable,
    credentialFromSettings: readiness.credentialFromSettings,
    credentialAvailable: readiness.credentialAvailable,
    settingsPath: resolved.settingsPath,
    settingsFound: resolved.settingsFound,
  });
}

// A redacted, human-readable summary of the resolved provider contract.
export function formatProviderContract(report: ProviderContractReport): string {
  const capabilities = Object.entries(report.capabilities)
    .filter(([, value]) => value)
    .map(([name]) => name);
  const lines: Array<string | null> = [
    `Provider:     ${report.providerId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Endpoint:     ${report.endpoint} (${report.endpointSource})`,
    `Model:        ${report.model}`,
    report.modelCatalog.length ? `Catalog:      ${report.modelCatalog.join(", ")}` : null,
    `Credential:   ${report.credentialVariable}${report.credentialAvailable ? "" : " (not set)"}`,
    capabilities.length ? `Capabilities: ${capabilities.join(", ")}` : null,
    `Settings:     ${report.settings}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}
