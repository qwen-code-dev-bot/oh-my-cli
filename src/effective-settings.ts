// Effective settings: one immutable, validated, hierarchical configuration
// snapshot for the whole CLI. This builds on the user-owned model settings
// (settings.ts) and the folder-trust authority (folder-trust.ts) to merge
// registered values deterministically across the documented precedence:
//
//   defaults < user settings < trusted project settings < environment < CLI
//
// Trust boundary: the user scope is the user-owned ~/.oh-my-cli/settings.json.
// The project scope is <workspace>/.oh-my-cli/settings.json and is considered
// ONLY after the folder is explicitly trusted, so an untrusted repository cannot
// influence configuration at all. Even once trusted, the project scope can never
// set a credential-bearing endpoint or a security-policy field (sandbox,
// approval) — those are rejected before any side effect, so a repository cannot
// redirect a credential or weaken isolation/approval through project config.
//
// A versioned schema registry rejects unknown or misspelled top-level sections
// (and unknown/forbidden fields within the security-critical `model` section)
// before any consumer runs, so a typo cannot silently become a supported path.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defaultUserSettingsPath } from "./settings.js";
import { resolveFolderTrust, isTrusted } from "./folder-trust.js";
import { redactHomePath, redactEndpointHost } from "./permission-impact.js";

export const SETTINGS_SCHEMA = "oh-my-cli.settings";
export const SETTINGS_SCHEMA_VERSION = 1;
export const SUPPORTED_SETTINGS_VERSIONS: readonly number[] = [1];

// Registered top-level keys. Any other key is rejected as unknown/misspelled so
// a typo (e.g. "modle", "mcpServer") cannot silently become configuration. The
// set covers the sections the CLI already reads plus the security-policy
// sections this hierarchy protects; it grows as a section gains a consumer.
export const REGISTERED_SETTINGS_KEYS: readonly string[] = [
  "schema",
  "version",
  "model",
  "profiles",
  "defaultProfile",
  "providers",
  "mcp",
  "mcpServers",
  "tools",
  "extensions",
  "sandbox",
  "approval",
  "ui",
  "workflows",
  "hooks",
  "diagnostics",
  "probeTimeoutMs",
];
const REGISTERED = new Set(REGISTERED_SETTINGS_KEYS);

// Top-level sections that must be JSON objects when present. Deep validation of
// the contract-backed sections (providers/mcp/tools/...) is deferred to their
// owning contract parser; `model` is validated strictly here because it carries
// the credential-bearing endpoint, and `profiles` deep validation is deferred to
// model-profiles.ts. (`defaultProfile` is a string, not an object.)
const OBJECT_SECTIONS = new Set([
  "model",
  "profiles",
  "providers",
  "mcp",
  "mcpServers",
  "tools",
  "extensions",
  "sandbox",
  "approval",
  "ui",
  "workflows",
  "hooks",
  "diagnostics",
]);

// Security-policy and credential-bearing sections a trusted project scope may
// never set at all. sandbox/approval are security policy; profiles/defaultProfile
// select the model endpoint and credential source, so a repository can never
// silently replace the selected endpoint or credential (only the user scope may).
// hooks run arbitrary local shell commands before tool calls, so a repository can
// never inject a hook either — only the user-owned scope may declare one.
const PROTECTED_PROJECT_SECTIONS = new Set([
  "sandbox",
  "approval",
  "profiles",
  "defaultProfile",
  "hooks",
]);

// Fields within a section a trusted project scope may never set. The model
// endpoint and the credential-source variable name are credential-bearing, so a
// repository can never supply them — only the user-owned scope may.
const PROTECTED_PROJECT_FIELDS: Record<string, ReadonlySet<string>> = {
  model: new Set(["baseUrl", "apiKeyEnv"]),
};

// Raw secret field names that must never appear in the model section of any
// scope. Rejected (not ignored) so a plaintext secret cannot become a supported
// configuration path. Mirrors settings.ts.
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

// The model section, validated strictly: every field is optional (the model name
// or endpoint may come from the environment or CLI), types are checked, unknown
// fields are rejected (.strict), and raw credential fields are rejected above.
const ModelSectionSchema = z
  .object({
    baseUrl: z.string().url("settings.model.baseUrl must be a valid URL").optional(),
    name: z.string().min(1, "settings.model.name must be a non-empty string").optional(),
    apiKeyEnv: z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "settings.model.apiKeyEnv must be a valid environment variable name",
      )
      .optional(),
  })
  .strict();

export interface SettingsScope {
  path: string;
  found: boolean;
  /** Validated registered keys only (envelope keys retained for inspection). */
  data: Record<string, unknown>;
}

// Read and validate one settings file against the versioned schema registry.
// A missing file is not an error (found:false). Invalid JSON, a non-object root,
// an unknown schema/version, an unregistered top-level key, a non-object
// section, or a malformed/forbidden model field all raise a redacted, actionable
// error before any consumer runs.
export function loadSettingsScope(settingsPath: string): SettingsScope {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return { path: settingsPath, found: false, data: {} };
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

  if ("schema" in root && root.schema !== SETTINGS_SCHEMA) {
    throw new Error(
      `Settings error: ${redactHomePath(settingsPath)} has unknown settings schema "${String(root.schema)}" (expected "${SETTINGS_SCHEMA}")`,
    );
  }
  if ("version" in root) {
    const v = root.version;
    if (typeof v !== "number" || !SUPPORTED_SETTINGS_VERSIONS.includes(v)) {
      throw new Error(
        `Settings error: ${redactHomePath(settingsPath)} has unsupported settings version ` +
          `${JSON.stringify(v)}; supported: ${SUPPORTED_SETTINGS_VERSIONS.join(", ")}`,
      );
    }
  }

  for (const key of Object.keys(root)) {
    if (!REGISTERED.has(key)) {
      throw new Error(
        `Settings error: ${redactHomePath(settingsPath)} has unknown settings key "${key}"`,
      );
    }
  }

  for (const section of OBJECT_SECTIONS) {
    if (section in root) {
      const val = root[section];
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        throw new Error(`Settings error: settings.${section} must be an object`);
      }
    }
  }

  if ("probeTimeoutMs" in root && typeof root.probeTimeoutMs !== "number") {
    throw new Error("Settings error: settings.probeTimeoutMs must be a number");
  }

  if (
    "defaultProfile" in root &&
    (typeof root.defaultProfile !== "string" || (root.defaultProfile as string).trim() === "")
  ) {
    throw new Error("Settings error: settings.defaultProfile must be a non-empty string");
  }

  if ("model" in root) {
    const model = root.model as Record<string, unknown>;
    for (const forbidden of FORBIDDEN_MODEL_KEYS) {
      if (forbidden in model) {
        throw new Error(
          `Settings error: settings.model.${forbidden} is a raw credential field; store the ` +
            "credential in an environment variable and reference it via settings.model.apiKeyEnv",
        );
      }
    }
    const result = ModelSectionSchema.safeParse(model);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: ${issues}`);
    }
  }

  return { path: settingsPath, found: true, data: root };
}

// The project settings file lives under the workspace and is project-controlled.
export function defaultProjectSettingsPath(workspacePath: string): string {
  return path.join(workspacePath, ".oh-my-cli", "settings.json");
}

// Throw a redacted error if a trusted project scope contains any field the
// project may never set. Fail closed: presence is rejected outright, so a
// repository cannot smuggle a credential endpoint, replace the selected profile,
// or weaken sandbox/approval.
function assertProjectScopeAllowed(project: SettingsScope): void {
  for (const section of PROTECTED_PROJECT_SECTIONS) {
    if (section in project.data) {
      throw new Error(
        `Settings error: trusted project settings may not set "${section}" ` +
          "(security policy and the model endpoint / profile selection are user-controlled, " +
          "not project-controlled)",
      );
    }
  }
  const model = project.data.model;
  if (model && typeof model === "object") {
    for (const field of PROTECTED_PROJECT_FIELDS.model) {
      if (field in (model as Record<string, unknown>)) {
        throw new Error(
          `Settings error: trusted project settings may not set "model.${field}" ` +
            "(credential-bearing endpoint and credential source are user-controlled)",
        );
      }
    }
  }
}

export type SettingsProvenance = "user" | "project" | "env" | "cli";

export interface EffectiveSettings {
  schema: string;
  version: number;
  /** Merged registered sections (envelope excluded), highest precedence wins. */
  merged: Record<string, unknown>;
  /** Which scope last set each merged section (redacted provenance). */
  provenance: Record<string, SettingsProvenance>;
  userSettingsPath: string;
  userSettingsFound: boolean;
  projectSettingsPath: string | null;
  projectSettingsFound: boolean;
  /** Whether the project scope was considered (folder explicitly trusted). */
  projectTrusted: boolean;
}

export interface ResolveEffectiveSettingsOptions {
  userSettingsPath?: string;
  workspacePath?: string;
  trustStorePath?: string;
  env?: Record<string, string | undefined>;
  /** Highest-precedence overrides (e.g. parsed CLI flags). */
  cliOverrides?: Record<string, unknown>;
  trustThisRun?: boolean;
  requireSandbox?: boolean;
}

// Resolve the one immutable effective-settings snapshot. The project scope is
// considered only when the folder is explicitly trusted (trust store or
// --trust), independent of sandbox; an untrusted folder's project file is
// ignored entirely.
export function resolveEffectiveSettings(
  opts: ResolveEffectiveSettingsOptions = {},
): EffectiveSettings {
  const env = opts.env ?? process.env;
  const userSettingsPath = opts.userSettingsPath ?? defaultUserSettingsPath();
  const user = loadSettingsScope(userSettingsPath);

  let project: SettingsScope | null = null;
  let projectTrusted = false;
  let projectSettingsPath: string | null = null;
  if (opts.workspacePath) {
    projectSettingsPath = defaultProjectSettingsPath(opts.workspacePath);
    const trust = resolveFolderTrust({
      workspacePath: opts.workspacePath,
      storePath: opts.trustStorePath,
      env,
      trustThisRun: opts.trustThisRun,
      requireSandbox: opts.requireSandbox,
    });
    projectTrusted = opts.trustThisRun === true || isTrusted(trust.store, trust.key);
    if (projectTrusted) {
      project = loadSettingsScope(projectSettingsPath);
      assertProjectScopeAllowed(project);
    }
  }

  const merged: Record<string, unknown> = {};
  const provenance: Record<string, SettingsProvenance> = {};

  const layer = (data: Record<string, unknown>, scope: SettingsProvenance): void => {
    for (const key of Object.keys(data)) {
      if (key === "schema" || key === "version") continue;
      merged[key] = data[key];
      provenance[key] = scope;
    }
  };

  layer(user.data, "user");
  if (project) layer(project.data, "project");

  // Environment overrides for the model section (the credential itself is never
  // placed in the snapshot; only the non-secret endpoint and model name).
  const envModel: Record<string, unknown> = {};
  if (env.OPENAI_BASE_URL) envModel.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_MODEL) envModel.name = env.OPENAI_MODEL;
  if (Object.keys(envModel).length > 0) {
    const base =
      merged.model && typeof merged.model === "object"
        ? (merged.model as Record<string, unknown>)
        : {};
    merged.model = { ...base, ...envModel };
    provenance.model = "env";
  }

  if (opts.cliOverrides) layer(opts.cliOverrides, "cli");

  return {
    schema: SETTINGS_SCHEMA,
    version: SETTINGS_SCHEMA_VERSION,
    merged,
    provenance,
    userSettingsPath,
    userSettingsFound: user.found,
    projectSettingsPath,
    projectSettingsFound: project?.found ?? false,
    projectTrusted,
  };
}

// A redacted, bounded one-line summary of a merged section. Never leaks a
// secret, an unredacted host, or an unredacted home path.
function summarizeSection(key: string, value: unknown): string {
  if (key === "model" && value && typeof value === "object") {
    const m = value as Record<string, unknown>;
    const name = typeof m.name === "string" && m.name ? m.name : "(unset)";
    return typeof m.baseUrl === "string" ? `${name} @ ${redactEndpointHost(m.baseUrl)}` : name;
  }
  if (value && typeof value === "object") {
    const n = Object.keys(value as object).length;
    return `${n} ${n === 1 ? "entry" : "entries"}`;
  }
  return String(value);
}

// A redacted, human-readable summary of the effective snapshot: the schema
// version, the user and (trusted) project scopes, and each merged section with
// the scope that won. Secrets and unredacted paths never appear.
export function formatEffectiveSettings(s: EffectiveSettings): string {
  const lines: string[] = [];
  lines.push("Effective Settings");
  lines.push("─".repeat(40));
  lines.push(`Schema:      ${s.schema} v${s.version}`);
  lines.push(
    `User:        ${redactHomePath(s.userSettingsPath)}${s.userSettingsFound ? "" : " (not found)"}`,
  );
  if (s.projectSettingsPath) {
    const trust = s.projectTrusted ? "trusted" : "UNTRUSTED (ignored)";
    const found = s.projectSettingsFound ? "" : " (not found)";
    lines.push(`Project:     ${redactHomePath(s.projectSettingsPath)} — ${trust}${found}`);
  }
  const sections = Object.keys(s.merged).sort();
  if (sections.length === 0) {
    lines.push("Sections:    (none)");
  } else {
    lines.push("Sections:");
    for (const key of sections) {
      lines.push(`  ${key.padEnd(14)} ${summarizeSection(key, s.merged[key])} (${s.provenance[key]})`);
    }
  }
  return lines.join("\n");
}
