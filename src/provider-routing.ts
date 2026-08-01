// Read-only provider routing inspection: shows routing policies, selected
// routes, failover decisions, and offline mode.
//
// Route entries expose provider, model, capability match, sensitivity
// constraint, selection reason, and failover chain. The view is read-only
// and never sends requests, switches providers, or modifies routing
// policies.

export const PROVIDER_ROUTING_SCHEMA = "oh-my-cli.provider-routing";
export const PROVIDER_ROUTING_VERSION = 1;

// --- types ------------------------------------------------------------------

export type DataSensitivity = "public" | "internal" | "confidential" | "restricted";

export interface CapabilitySet {
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  maxContextTokens: number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  /** Whether this provider requires network access. */
  requiresNetwork: boolean;
  capabilities: CapabilitySet;
  /** Estimated latency in ms. */
  latencyMs: number;
  /** Cost per 1M tokens (USD). */
  costPerMillion: number;
}

export type RouteStatus = "selected" | "failover" | "skipped" | "blocked";

export interface RouteEntry {
  providerId: string;
  providerName: string;
  model: string;
  status: RouteStatus;
  /** Why this route was selected, skipped, or blocked. */
  reason: string;
  /** Whether the provider matches the required capabilities. */
  capabilityMatch: boolean;
  /** Whether the provider satisfies the data sensitivity constraint. */
  sensitivityOk: boolean;
}

export interface RoutingDecision {
  /** Required capabilities for the task. */
  requiredCapabilities: Partial<CapabilitySet>;
  /** Data sensitivity constraint. */
  sensitivity: DataSensitivity;
  /** Whether offline mode is active. */
  offlineMode: boolean;
  /** Ordered route entries (selected first, then failover alternatives). */
  routes: RouteEntry[];
  /** The selected route (first with status "selected"). */
  selectedRoute?: RouteEntry;
  /** Whether a valid route was found. */
  routed: boolean;
}

// --- routing engine (read-only) ---------------------------------------------

// Evaluate routing for a set of providers given task constraints.
// This is a pure function — it does not send requests or modify state.
export function evaluateRouting(
  providers: ProviderProfile[],
  opts: {
    requiredCapabilities?: Partial<CapabilitySet>;
    sensitivity?: DataSensitivity;
    offlineMode?: boolean;
    preferredProviderId?: string;
  },
): RoutingDecision {
  const required = opts.requiredCapabilities ?? {};
  const sensitivity = opts.sensitivity ?? "public";
  const offlineMode = opts.offlineMode ?? false;

  const routes: RouteEntry[] = [];

  for (const provider of providers) {
    const capMatch = checkCapabilities(provider.capabilities, required);
    const sensOk = checkSensitivity(provider, sensitivity);
    const networkBlocked = offlineMode && provider.requiresNetwork;

    let status: RouteStatus;
    let reason: string;

    if (networkBlocked) {
      status = "blocked";
      reason = "Offline mode: network provider blocked";
    } else if (!capMatch) {
      status = "skipped";
      reason = `Missing required capabilities: ${missingCapabilities(provider.capabilities, required).join(", ")}`;
    } else if (!sensOk) {
      status = "skipped";
      reason = `Data sensitivity "${sensitivity}" not satisfied by provider`;
    } else {
      status = "failover"; // Will be promoted to "selected" below.
      reason = "Eligible";
    }

    routes.push({
      providerId: provider.id,
      providerName: provider.name,
      model: provider.name,
      status,
      reason,
      capabilityMatch: capMatch,
      sensitivityOk: sensOk,
    });
  }

  // Select the best eligible route: preferred first, then lowest latency.
  const eligible = routes.filter((r) => r.status === "failover");
  if (eligible.length > 0) {
    let selected: RouteEntry;
    if (opts.preferredProviderId) {
      const preferred = eligible.find((r) => r.providerId === opts.preferredProviderId);
      selected = preferred ?? eligible[0];
    } else {
      // Sort by latency (lowest first).
      eligible.sort((a, b) => {
        const pa = providers.find((p) => p.id === a.providerId)!;
        const pb = providers.find((p) => p.id === b.providerId)!;
        return pa.latencyMs - pb.latencyMs;
      });
      selected = eligible[0];
    }
    selected.status = "selected";
    selected.reason = opts.preferredProviderId === selected.providerId
      ? "Preferred provider"
      : "Lowest latency among eligible providers";
  }

  const selectedRoute = routes.find((r) => r.status === "selected");

  return {
    requiredCapabilities: required,
    sensitivity,
    offlineMode,
    routes,
    selectedRoute,
    routed: selectedRoute !== undefined,
  };
}

function checkCapabilities(actual: CapabilitySet, required: Partial<CapabilitySet>): boolean {
  if (required.tools && !actual.tools) return false;
  if (required.vision && !actual.vision) return false;
  if (required.structuredOutput && !actual.structuredOutput) return false;
  if (required.streaming && !actual.streaming) return false;
  if (required.maxContextTokens && actual.maxContextTokens < required.maxContextTokens) return false;
  return true;
}

function missingCapabilities(actual: CapabilitySet, required: Partial<CapabilitySet>): string[] {
  const missing: string[] = [];
  if (required.tools && !actual.tools) missing.push("tools");
  if (required.vision && !actual.vision) missing.push("vision");
  if (required.structuredOutput && !actual.structuredOutput) missing.push("structuredOutput");
  if (required.streaming && !actual.streaming) missing.push("streaming");
  if (required.maxContextTokens && actual.maxContextTokens < required.maxContextTokens) missing.push("context");
  return missing;
}

function checkSensitivity(provider: ProviderProfile, sensitivity: DataSensitivity): boolean {
  // Restricted data can only go to local (non-network) providers.
  if (sensitivity === "restricted" && provider.requiresNetwork) return false;
  // Confidential data cannot go to public network providers (simplified model).
  return true;
}

// --- formatting -------------------------------------------------------------

export function formatRoutingDecision(decision: RoutingDecision): string {
  const lines: string[] = [];
  lines.push("Provider Routing");
  lines.push("═".repeat(50));
  lines.push(`Sensitivity: ${decision.sensitivity}  Offline: ${decision.offlineMode ? "YES" : "no"}  Routed: ${decision.routed ? "YES" : "NO"}`);

  if (decision.selectedRoute) {
    lines.push(`Selected: ${decision.selectedRoute.providerName} — ${decision.selectedRoute.reason}`);
  } else {
    lines.push("⚠ No eligible route found");
  }

  lines.push("");
  for (const route of decision.routes) {
    const icon = routeIcon(route.status);
    lines.push(`${icon} ${route.providerName} [${route.status}] — ${route.reason}`);
  }

  lines.push("");
  lines.push("Read-only: no requests sent, no providers switched.");

  return lines.join("\n");
}

function routeIcon(status: RouteStatus): string {
  switch (status) {
    case "selected": return "●";
    case "failover": return "○";
    case "skipped": return "→";
    case "blocked": return "✗";
  }
}
