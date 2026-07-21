// Model profiles: declare one or more named model profiles as a section of the
// unified user settings file (settings.ts), then select or switch the active
// profile by name — in headless runs via `--profile`, or via the user-owned
// default (`settings.defaultProfile`). A profile reuses the exact shape of the
// `model` section (endpoint, model name, credential environment-variable name)
// plus optional human metadata and a `disabled` flag, so selecting a profile is
// just choosing which validated model section feeds the existing secure resolver
// (resolveModelFromSettings). No raw credential is ever stored: the credential
// is an environment-variable name, never a value.
//
// Trust boundary: profiles are untrusted input read ONLY from the user-owned
// settings scope (resolveSettingsPath never resolves a project-local path), and
// the effective-settings hierarchy additionally forbids a trusted project scope
// from setting `profiles` or `defaultProfile` at all, so a repository cannot
// silently replace the selected endpoint or credential source. Raw credential
// fields inside a profile are rejected rather than ignored, matching the
// model/workflow contracts. A malformed profile, an unknown profile name, or a
// disabled profile fails closed before any request, and every error is redacted.

import fs from "node:fs";
import { z } from "zod";
import {
  resolveSettingsPath,
  resolveModelConfig,
  resolveModelFromSettings,
  type ModelSettings,
  type ResolvedConfig,
} from "./settings.js";
import { redactHomePath, redactEndpointHost } from "./permission-impact.js";

// Raw secret field names that must never appear in a profile. Rejected (not
// ignored) so a plaintext secret cannot become a supported configuration path.
// Mirrors the model/workflow contracts.
const FORBIDDEN_PROFILE_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// A profile name is a portable, shell-safe identifier: it is used as a CLI
// argument (`--profile <name>`) and as a settings map key, so it cannot carry
// whitespace, path separators, or leading punctuation. Mirrors workflow names.
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_NAME = 128;
const MAX_DESCRIPTION = 500;

// One declared model profile. The profile's identity is its key in
// `settings.profiles` (carried here as `profile`); `name` is the model name it
// selects, mirroring the `model` section's `name` field. The remaining fields
// are the same non-secret model fields, so a profile feeds resolveModelFromSettings
// directly.
export interface ModelProfile {
  /** The profile's identity: its key in settings.profiles. */
  profile: string;
  /** The model name this profile selects (settings.model.name equivalent). */
  name: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  description?: string;
  disabled?: boolean;
}

// A profile entry mirrors the `model` section (`name`/`baseUrl`/`apiKeyEnv`) plus
// optional metadata. Validated strictly: unknown fields are rejected so a typo
// cannot silently become a supported path.
const ProfileSchema = z
  .object({
    description: z.string().max(MAX_DESCRIPTION, "profile description is too long").optional(),
    baseUrl: z.string().url("profile.baseUrl must be a valid URL").optional(),
    name: z
      .string({
        required_error: "profile.name (model name) is required",
        invalid_type_error: "profile.name must be a string",
      })
      .min(1, "profile.name (model name) is required"),
    apiKeyEnv: z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "profile.apiKeyEnv must be a valid environment variable name",
      )
      .optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

function assertNoForbiddenKeys(obj: Record<string, unknown>, label: string): void {
  for (const forbidden of FORBIDDEN_PROFILE_KEYS) {
    if (forbidden in obj) {
      throw new Error(
        `Settings error: ${label} field "${forbidden}" is a raw credential field; ` +
          "reference credentials via the environment-variable model, never inline in a profile",
      );
    }
  }
}

interface ProfilesSection {
  found: boolean;
  profiles?: unknown;
  defaultProfile?: string;
}

// Read only the optional `profiles` and `defaultProfile` fields of the user
// settings file. Throws a redacted, actionable error on invalid JSON, a
// non-object root, or a malformed defaultProfile — before any request. A missing
// file or absent fields is not an error here; the caller decides how to treat
// that (resolution falls back to the legacy `model` section).
function readProfilesSection(settingsPath: string): ProfilesSection {
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
  const out: ProfilesSection = { found: true };

  if (root.defaultProfile !== undefined) {
    if (typeof root.defaultProfile !== "string" || root.defaultProfile.trim() === "") {
      throw new Error("Settings error: settings.defaultProfile must be a non-empty string");
    }
    out.defaultProfile = root.defaultProfile;
  }

  if (root.profiles !== undefined) {
    out.profiles = root.profiles;
  }
  return out;
}

// Validate an untrusted `profiles` map into ModelProfile[]. Rejects a non-object
// section, raw credential fields per profile, invalid names, unknown profile
// fields, and malformed profiles. Every failure raises a redacted, deterministic
// error. An empty map is allowed (no profiles defined).
export function parseProfiles(section: unknown): ModelProfile[] {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.profiles must be an object");
  }
  const entries = Object.entries(section as Record<string, unknown>);
  const profiles: ModelProfile[] = [];
  for (const [name, raw] of entries) {
    if (name.length > MAX_NAME || !PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `Settings error: profile name "${name}" must match ${PROFILE_NAME_RE.source} ` +
          "(a portable, shell-safe identifier)",
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Settings error: profile "${name}" must be an object`);
    }
    const profileObj = raw as Record<string, unknown>;
    assertNoForbiddenKeys(profileObj, `profile "${name}"`);
    const result = ProfileSchema.safeParse(profileObj);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: profile "${name}": ${issues}`);
    }
    profiles.push({
      profile: name,
      name: result.data.name,
      baseUrl: result.data.baseUrl,
      apiKeyEnv: result.data.apiKeyEnv,
      description: result.data.description,
      disabled: result.data.disabled,
    });
  }
  return profiles;
}

// Resolve a profile by name. The name is required (profiles run by explicit
// selection); an unknown name fails closed with an actionable reason listing the
// available profiles, and a disabled profile is refused so it cannot be selected.
export function selectProfile(profiles: ModelProfile[], name: string): ModelProfile {
  const wanted = name.trim();
  if (wanted === "") {
    throw new Error("Profile error: profile name must be a non-empty string");
  }
  const found = profiles.find((p) => p.profile === wanted);
  if (!found) {
    const available = profiles
      .map((p) => p.profile)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    throw new Error(
      `Profile error: profile "${wanted}" is not defined in settings.profiles` +
        (available ? `; available: ${available}` : ""),
    );
  }
  if (found.disabled === true) {
    throw new Error(`Profile error: profile "${wanted}" is disabled in settings.profiles`);
  }
  return found;
}

// The redacted, serializable result of listing the declared profiles. No secret,
// no unredacted host, and no unredacted home path.
export interface ProfileListEntry {
  profile: string;
  model: string;
  host?: string;
  description?: string;
  disabled: boolean;
  isDefault: boolean;
}

export interface ProfileListReport {
  profiles: ProfileListEntry[];
  defaultProfile?: string;
  settings: string;
}

// Read the user settings file and build the redacted profile list. Unlike
// resolution, listing never throws when no `profiles` section exists — it reports
// an empty list — but a present-but-malformed section still fails closed.
export function collectProfileList(opts: { settingsPath?: string } = {}): ProfileListReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, profiles: rawProfiles, defaultProfile } = readProfilesSection(settingsPath);
  const profiles = rawProfiles === undefined ? [] : parseProfiles(rawProfiles);
  const entries: ProfileListEntry[] = profiles
    .map((p) => ({
      profile: p.profile,
      model: p.name,
      host: p.baseUrl ? redactEndpointHost(p.baseUrl) : undefined,
      description: p.description,
      disabled: p.disabled === true,
      isDefault: defaultProfile !== undefined && p.profile === defaultProfile,
    }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
  return {
    profiles: entries,
    defaultProfile,
    settings: found ? redactHomePath(settingsPath) : `${redactHomePath(settingsPath)} (not found)`,
  };
}

// A redacted, human-readable summary of the declared profiles.
export function formatProfileList(report: ProfileListReport): string {
  const lines: string[] = [];
  lines.push("Model Profiles");
  lines.push("─".repeat(40));
  lines.push(`Settings:  ${report.settings}`);
  lines.push(`Default:   ${report.defaultProfile ?? "(none)"}`);
  if (report.profiles.length === 0) {
    lines.push("Profiles:  (none)");
  } else {
    lines.push(`Profiles:  ${report.profiles.length}`);
    for (const p of report.profiles) {
      const flags: string[] = [];
      if (p.isDefault) flags.push("default");
      if (p.disabled) flags.push("disabled");
      const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
      const host = p.host ? ` @ ${p.host}` : "";
      lines.push(
        `  ${p.profile} — ${p.model}${host}${suffix}${p.description ? `: ${p.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

// Resolve the active model configuration, selecting a profile when one applies.
// Selection precedence: an explicit `--profile` wins; otherwise the user-owned
// `settings.defaultProfile` applies; otherwise this falls back to the legacy
// single `model` section (resolveModelConfig). The selected profile reuses the
// secure resolver, so all precedence, credential, and redaction rules are
// identical to the `model` section — and the chosen profile name is recorded as
// non-secret provenance on the result. Every failure raises a redacted error
// before any request.
export function resolveModelProfileConfig(
  opts: {
    settingsPath?: string;
    env?: Record<string, string | undefined>;
    profile?: string;
  } = {},
): ResolvedConfig {
  const env = opts.env ?? process.env;
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, profiles: rawProfiles, defaultProfile } = readProfilesSection(settingsPath);

  const explicit = opts.profile?.trim();
  const wanted = explicit !== undefined && explicit !== "" ? explicit : defaultProfile;

  if (wanted === undefined) {
    // No profile selected: fall back to the legacy single `model` section.
    return resolveModelConfig({ settingsPath, env });
  }

  if (rawProfiles === undefined) {
    throw new Error(
      explicit !== undefined
        ? `Profile error: --profile "${wanted}" was given but settings has no settings.profiles section`
        : "Profile error: settings.defaultProfile is set but settings has no settings.profiles section",
    );
  }

  const profile = selectProfile(parseProfiles(rawProfiles), wanted);
  const modelSettings: ModelSettings = {
    name: profile.name,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
  };
  return resolveModelFromSettings(modelSettings, {
    env,
    settingsPath,
    settingsFound: found,
    profile: profile.profile,
  });
}
