// Read-only experience center: inspects redacted provider, model, and MCP
// health with provenance.
//
// Delivers a secret-safe health view for configured providers, models, and
// MCP servers. Shows capability, provenance, effective availability, latency
// or last-probe state, trust posture, and actionable failure reasons while
// displaying only redacted references to credentials. This slice does not
// edit settings or enable integrations. The model is surface-independent.

export const EXPERIENCE_CENTER_SCHEMA = "oh-my-cli.experience-center";
export const EXPERIENCE_CENTER_VERSION = 1;

// --- health types -----------------------------------------------------------

export type HealthKind = "provider" | "model" | "mcp-server";

export type Availability = "available" | "degraded" | "unavailable" | "unknown";

export type FailureCategory =
  | "configuration"
  | "authentication"
  | "connectivity"
  | "capability"
  | "permission"
  | "lifecycle";

export type TrustPosture = "trusted" | "untrusted" | "sandbox-enforced";

export interface FailureInfo {
  category: FailureCategory;
  /** Actionable recovery guidance. */
  guidance: string;
}

export interface HealthEntry {
  /** Stable identifier. */
  id: string;
  kind: HealthKind;
  /** Display name. */
  name: string;
  /** Effective capability description. */
  capability: string;
  availability: Availability;
  /** Where this configuration came from. */
  provenance: string;
  trustPosture: TrustPosture;
  /** Redacted credential reference (never the raw value). */
  credentialRef?: string;
  /** Last probe latency in ms (when known). */
  latencyMs?: number;
  /** Epoch ms of last probe. */
  lastProbeAt?: number;
  /** Failure details (when not available). */
  failure?: FailureInfo;
}

// --- credential redaction ---------------------------------------------------

// Redact a credential value to a safe reference. Never returns the raw value.
export function redactCredential(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  // Show only the first 4 and last 4 characters.
  return `${value.slice(0, 4)}…${value.slice(-4)} [REDACTED]`;
}

// --- health view ------------------------------------------------------------

export interface HealthView {
  schema: typeof EXPERIENCE_CENTER_SCHEMA;
  v: typeof EXPERIENCE_CENTER_VERSION;
  entries: HealthEntry[];
  /** Counts by availability. */
  availableCount: number;
  degradedCount: number;
  unavailableCount: number;
  unknownCount: number;
  /** True when any entry has a failure. */
  hasFailures: boolean;
  snapshotAt: number;
}

// Assemble a read-only health view from health entries.
export function assembleHealthView(entries: HealthEntry[]): HealthView {
  let availableCount = 0;
  let degradedCount = 0;
  let unavailableCount = 0;
  let unknownCount = 0;

  for (const e of entries) {
    switch (e.availability) {
      case "available": availableCount++; break;
      case "degraded": degradedCount++; break;
      case "unavailable": unavailableCount++; break;
      case "unknown": unknownCount++; break;
    }
  }

  return {
    schema: EXPERIENCE_CENTER_SCHEMA,
    v: EXPERIENCE_CENTER_VERSION,
    entries,
    availableCount,
    degradedCount,
    unavailableCount,
    unknownCount,
    hasFailures: entries.some((e) => e.failure !== undefined),
    snapshotAt: Date.now(),
  };
}

// --- failure guidance -------------------------------------------------------

// Default recovery guidance by failure category.
const DEFAULT_GUIDANCE: Record<FailureCategory, string> = {
  configuration: "Check the configuration file or environment variable for this entry.",
  authentication: "Verify the API key or token is valid and not expired.",
  connectivity: "Check network connectivity and firewall rules.",
  capability: "This entry does not support the requested capability.",
  permission: "Insufficient permissions. Check access control settings.",
  lifecycle: "This entry is not yet initialized or has been shut down.",
};

// Create a FailureInfo with default guidance when none is provided.
export function createFailure(category: FailureCategory, guidance?: string): FailureInfo {
  return { category, guidance: guidance ?? DEFAULT_GUIDANCE[category] };
}

// --- formatting -------------------------------------------------------------

// Format a health view as a compact, color-independent TUI view.
export function formatHealthView(view: HealthView): string {
  const lines: string[] = [];
  lines.push("Experience Center");
  lines.push("═".repeat(50));
  lines.push(`Available: ${view.availableCount}  Degraded: ${view.degradedCount}  Unavailable: ${view.unavailableCount}  Unknown: ${view.unknownCount}`);

  // Group by kind.
  const kinds: HealthKind[] = ["provider", "model", "mcp-server"];
  for (const kind of kinds) {
    const group = view.entries.filter((e) => e.kind === kind);
    if (group.length === 0) continue;

    lines.push("");
    lines.push(`${kindLabel(kind)} (${group.length}):`);

    for (const entry of group) {
      const icon = availabilityIcon(entry.availability);
      const latency = entry.latencyMs !== undefined ? ` ${entry.latencyMs}ms` : "";
      const trust = entry.trustPosture !== "trusted" ? ` [${entry.trustPosture}]` : "";
      const cred = entry.credentialRef ? ` cred:${entry.credentialRef}` : "";
      lines.push(`  ${icon} ${entry.name} [${entry.availability}]${latency}${trust}${cred}`);
      lines.push(`    capability: ${entry.capability}`);
      lines.push(`    provenance: ${entry.provenance}`);

      if (entry.failure) {
        lines.push(`    ✗ ${entry.failure.category}: ${entry.failure.guidance}`);
      }
    }
  }

  lines.push("");
  lines.push("Read-only: no settings changed, no integrations enabled.");

  return lines.join("\n");
}

function kindLabel(kind: HealthKind): string {
  switch (kind) {
    case "provider": return "Providers";
    case "model": return "Models";
    case "mcp-server": return "MCP Servers";
  }
}

function availabilityIcon(availability: Availability): string {
  switch (availability) {
    case "available": return "●";
    case "degraded": return "◐";
    case "unavailable": return "○";
    case "unknown": return "?";
  }
}
