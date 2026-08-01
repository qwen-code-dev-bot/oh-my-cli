// Read-only effective-settings inspection: shows each setting's resolved
// value, configuration provenance, and validation state.
//
// Setting entries expose key, effective value (redacted for secrets),
// source layer (default/user/project/env/flag), and validation warnings.
// The view is read-only and never writes, creates, or modifies settings.

export const SETTINGS_INSPECTION_SCHEMA = "oh-my-cli.settings-inspection";
export const SETTINGS_INSPECTION_VERSION = 1;

// --- setting types ----------------------------------------------------------

export type SettingsLayer = "default" | "user" | "project" | "env" | "flag";

export type ValidationState = "valid" | "type-mismatch" | "unknown-key" | "deprecated";

export interface SettingEntry {
  /** Setting key (e.g. "model.name", "provider.apiKey"). */
  key: string;
  /** Effective value (redacted for secrets). */
  displayValue: string;
  /** Whether the raw value is a secret. */
  isSecret: boolean;
  /** The layer that provided the effective value. */
  sourceLayer: SettingsLayer;
  /** Validation state. */
  validationState: ValidationState;
  /** Recovery guidance (when not valid). */
  guidance?: string;
}

// --- secret detection -------------------------------------------------------

// Keys that are secret-bearing and must be redacted.
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private[_-]?key/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

// Redact a setting value for display.
export function redactValue(value: string): string {
  if (value.length <= 4) return "[REDACTED]";
  return `${value.slice(0, 2)}…${value.slice(-2)} [REDACTED]`;
}

// --- deprecated keys --------------------------------------------------------

const DEPRECATED_KEYS: Record<string, string> = {
  "model.provider": "Use 'provider.name' instead.",
  "theme.dark": "Use 'theme.mode' with value 'dark' instead.",
  "mcp.timeout": "Use 'mcp.servers.<name>.timeout' instead.",
};

export function isDeprecatedKey(key: string): boolean {
  return key in DEPRECATED_KEYS;
}

export function deprecationGuidance(key: string): string | undefined {
  return DEPRECATED_KEYS[key];
}

// --- settings resolver ------------------------------------------------------

export interface RawSetting {
  key: string;
  value: string;
  layer: SettingsLayer;
}

// Resolve effective settings from multiple layers. Later layers override
// earlier ones (default < user < project < env < flag).
export function resolveSettings(rawSettings: RawSetting[]): SettingEntry[] {
  const layerOrder: SettingsLayer[] = ["default", "user", "project", "env", "flag"];
  const effective = new Map<string, RawSetting>();

  // Sort by layer priority, then apply (later overrides earlier).
  const sorted = [...rawSettings].sort(
    (a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer),
  );

  for (const raw of sorted) {
    effective.set(raw.key, raw);
  }

  const entries: SettingEntry[] = [];
  for (const [key, raw] of effective) {
    const secret = isSecretKey(key);
    const deprecated = isDeprecatedKey(key);

    let validationState: ValidationState = "valid";
    let guidance: string | undefined;

    if (deprecated) {
      validationState = "deprecated";
      guidance = deprecationGuidance(key);
    }

    entries.push({
      key,
      displayValue: secret ? redactValue(raw.value) : raw.value,
      isSecret: secret,
      sourceLayer: raw.layer,
      validationState,
      guidance,
    });
  }

  // Sort by key for deterministic output.
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

// --- inspection view --------------------------------------------------------

export interface SettingsInspectionView {
  schema: typeof SETTINGS_INSPECTION_SCHEMA;
  v: typeof SETTINGS_INSPECTION_VERSION;
  entries: SettingEntry[];
  totalSettings: number;
  secretCount: number;
  deprecatedCount: number;
  hasWarnings: boolean;
  snapshotAt: number;
}

// Assemble a read-only inspection view.
export function assembleSettingsView(rawSettings: RawSetting[]): SettingsInspectionView {
  const entries = resolveSettings(rawSettings);
  const secretCount = entries.filter((e) => e.isSecret).length;
  const deprecatedCount = entries.filter((e) => e.validationState === "deprecated").length;

  return {
    schema: SETTINGS_INSPECTION_SCHEMA,
    v: SETTINGS_INSPECTION_VERSION,
    entries,
    totalSettings: entries.length,
    secretCount,
    deprecatedCount,
    hasWarnings: deprecatedCount > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format an inspection view as a compact TUI view.
export function formatSettingsView(view: SettingsInspectionView): string {
  const lines: string[] = [];
  lines.push("Effective Settings");
  lines.push("═".repeat(50));
  lines.push(`Settings: ${view.totalSettings}  Secrets: ${view.secretCount}  Deprecated: ${view.deprecatedCount}`);

  if (view.hasWarnings) {
    lines.push("⚠ Deprecated settings detected");
  }

  for (const entry of view.entries) {
    const icon = validationIcon(entry.validationState);
    const secret = entry.isSecret ? " 🔒" : "";
    lines.push(`${icon} ${entry.key} = ${entry.displayValue} [${entry.sourceLayer}]${secret}`);
    if (entry.guidance) {
      lines.push(`  → ${entry.guidance}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no settings files written or modified.");

  return lines.join("\n");
}

function validationIcon(state: ValidationState): string {
  switch (state) {
    case "valid": return "●";
    case "type-mismatch": return "✗";
    case "unknown-key": return "?";
    case "deprecated": return "⚠";
  }
}
