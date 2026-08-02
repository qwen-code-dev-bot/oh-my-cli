// Sandbox network strict allowlist: restricts sandboxed command network
// access to an explicit list of trusted host patterns.
//
// When the allowlist is non-empty, sandboxed commands can only reach
// matching hosts; all other destinations are blocked with a structured
// refusal. Patterns support exact hostnames and wildcard subdomains
// (e.g., *.npmjs.org). Empty allowlist means unrestricted (backward
// compatible). The effective decision is explainable.

export const SANDBOX_NETWORK_ALLOWLIST_SCHEMA = "oh-my-cli.sandbox-network-allowlist";
export const SANDBOX_NETWORK_ALLOWLIST_VERSION = 1;

// --- types ------------------------------------------------------------------

export type AllowlistAction = "allowed" | "blocked" | "unrestricted";

export interface AllowlistDecision {
  /** The host being evaluated. */
  host: string;
  /** The action taken. */
  action: AllowlistAction;
  /** The pattern that matched (when allowed by pattern). */
  matchedPattern?: string;
  /** Human-readable explanation. */
  explanation: string;
}

export interface AllowlistConfig {
  /** List of allowed host patterns. Empty means unrestricted. */
  patterns: string[];
}

// --- pattern matching -------------------------------------------------------

// Match a host against a pattern. Supports:
// - Exact hostname: "registry.npmjs.org"
// - Wildcard subdomain: "*.npmjs.org" matches "registry.npmjs.org" and
//   "foo.bar.npmjs.org" but NOT "npmjs.org" itself.
// - Wildcard all: "*" matches any host.
export function matchHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().trim();
  const normalizedPattern = pattern.toLowerCase().trim();

  if (normalizedPattern === "*") return true;

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1); // ".npmjs.org"
    return normalizedHost.endsWith(suffix) && normalizedHost !== suffix.slice(1);
  }

  return normalizedHost === normalizedPattern;
}

// --- allowlist evaluation ---------------------------------------------------

// Evaluate whether a host is allowed by the allowlist configuration.
export function evaluateHost(
  host: string,
  config: AllowlistConfig,
): AllowlistDecision {
  // Empty allowlist means unrestricted.
  if (config.patterns.length === 0) {
    return {
      host,
      action: "unrestricted",
      explanation: "Allowlist is empty; network access is unrestricted.",
    };
  }

  // Check each pattern.
  for (const pattern of config.patterns) {
    if (matchHostPattern(host, pattern)) {
      return {
        host,
        action: "allowed",
        matchedPattern: pattern,
        explanation: `Host "${host}" matches allowlist pattern "${pattern}".`,
      };
    }
  }

  // No pattern matched — blocked.
  return {
    host,
    action: "blocked",
    explanation: `Host "${host}" does not match any allowlist pattern. Blocked by sandbox.network.strictAllowlist.`,
  };
}

// Evaluate multiple hosts and return all decisions.
export function evaluateHosts(
  hosts: string[],
  config: AllowlistConfig,
): AllowlistDecision[] {
  return hosts.map((host) => evaluateHost(host, config));
}

// --- allowlist summary ------------------------------------------------------

export interface AllowlistSummary {
  schema: typeof SANDBOX_NETWORK_ALLOWLIST_SCHEMA;
  v: typeof SANDBOX_NETWORK_ALLOWLIST_VERSION;
  /** Whether the allowlist is active (non-empty). */
  active: boolean;
  /** Number of patterns. */
  patternCount: number;
  /** The patterns. */
  patterns: string[];
  /** Decisions for evaluated hosts. */
  decisions: AllowlistDecision[];
  /** Number of blocked hosts. */
  blockedCount: number;
  /** Number of allowed hosts. */
  allowedCount: number;
}

export function summarizeAllowlist(
  config: AllowlistConfig,
  decisions: AllowlistDecision[],
): AllowlistSummary {
  return {
    schema: SANDBOX_NETWORK_ALLOWLIST_SCHEMA,
    v: SANDBOX_NETWORK_ALLOWLIST_VERSION,
    active: config.patterns.length > 0,
    patternCount: config.patterns.length,
    patterns: [...config.patterns],
    decisions,
    blockedCount: decisions.filter((d) => d.action === "blocked").length,
    allowedCount: decisions.filter((d) => d.action === "allowed").length,
  };
}

// --- formatting -------------------------------------------------------------

export function formatAllowlistSummary(summary: AllowlistSummary): string {
  const lines: string[] = [];
  lines.push("Sandbox Network Allowlist");
  lines.push("═".repeat(50));

  if (!summary.active) {
    lines.push("Status: INACTIVE (empty allowlist, unrestricted)");
  } else {
    lines.push(`Status: ACTIVE (${summary.patternCount} patterns)`);
    lines.push("Patterns:");
    for (const p of summary.patterns) {
      lines.push(`  · ${p}`);
    }
  }

  if (summary.decisions.length > 0) {
    lines.push("");
    lines.push(`Evaluated: ${summary.decisions.length} hosts (${summary.allowedCount} allowed, ${summary.blockedCount} blocked)`);
    for (const d of summary.decisions) {
      const icon = d.action === "allowed" ? "✓" : d.action === "blocked" ? "✗" : "○";
      lines.push(`  ${icon} ${d.host} — ${d.explanation}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no network connections made, no settings modified.");

  return lines.join("\n");
}
