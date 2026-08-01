import { describe, it, expect } from "vitest";
import {
  evaluateRouting,
  formatRoutingDecision,
  type ProviderProfile,
  type CapabilitySet,
} from "../../src/provider-routing.js";

// Pure-function coverage for provider routing (Issue #377): routing,
// failover, offline mode, capability mismatch, multi-provider, and
// read-only guarantee.

function caps(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return { tools: true, vision: false, structuredOutput: true, streaming: true, maxContextTokens: 128_000, ...overrides };
}

function provider(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id, name: `Provider ${id}`, requiresNetwork: true,
    capabilities: caps(), latencyMs: 100, costPerMillion: 2.0,
    ...overrides,
  };
}

// --- basic routing ----------------------------------------------------------

describe("basic routing", () => {
  it("selects the lowest-latency eligible provider", () => {
    const providers = [
      provider("slow", { latencyMs: 500 }),
      provider("fast", { latencyMs: 50 }),
    ];

    const decision = evaluateRouting(providers, {});
    expect(decision.routed).toBe(true);
    expect(decision.selectedRoute!.providerId).toBe("fast");
    expect(decision.selectedRoute!.reason).toContain("Lowest latency");
  });

  it("selects preferred provider when specified", () => {
    const providers = [
      provider("a", { latencyMs: 50 }),
      provider("b", { latencyMs: 200 }),
    ];

    const decision = evaluateRouting(providers, { preferredProviderId: "b" });
    expect(decision.selectedRoute!.providerId).toBe("b");
    expect(decision.selectedRoute!.reason).toContain("Preferred");
  });

  it("reports no route when no providers", () => {
    const decision = evaluateRouting([], {});
    expect(decision.routed).toBe(false);
    expect(decision.selectedRoute).toBeUndefined();
  });
});

// --- capability matching ----------------------------------------------------

describe("capability matching", () => {
  it("skips providers missing required capabilities", () => {
    const providers = [
      provider("no-vision", { capabilities: caps({ vision: false }) }),
      provider("with-vision", { capabilities: caps({ vision: true }) }),
    ];

    const decision = evaluateRouting(providers, {
      requiredCapabilities: { vision: true },
    });

    expect(decision.routed).toBe(true);
    expect(decision.selectedRoute!.providerId).toBe("with-vision");

    const skipped = decision.routes.find((r) => r.providerId === "no-vision");
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.reason).toContain("vision");
  });

  it("skips providers with insufficient context", () => {
    const providers = [
      provider("small", { capabilities: caps({ maxContextTokens: 4_000 }) }),
      provider("large", { capabilities: caps({ maxContextTokens: 200_000 }) }),
    ];

    const decision = evaluateRouting(providers, {
      requiredCapabilities: { maxContextTokens: 100_000 },
    });

    expect(decision.selectedRoute!.providerId).toBe("large");
  });
});

// --- offline mode -----------------------------------------------------------

describe("offline mode", () => {
  it("blocks network providers in offline mode", () => {
    const providers = [
      provider("cloud", { requiresNetwork: true }),
      provider("local", { requiresNetwork: false, latencyMs: 10 }),
    ];

    const decision = evaluateRouting(providers, { offlineMode: true });
    expect(decision.routed).toBe(true);
    expect(decision.selectedRoute!.providerId).toBe("local");

    const blocked = decision.routes.find((r) => r.providerId === "cloud");
    expect(blocked!.status).toBe("blocked");
    expect(blocked!.reason).toContain("Offline mode");
  });

  it("reports no route when all providers need network in offline mode", () => {
    const providers = [provider("cloud", { requiresNetwork: true })];

    const decision = evaluateRouting(providers, { offlineMode: true });
    expect(decision.routed).toBe(false);
  });
});

// --- data sensitivity -------------------------------------------------------

describe("data sensitivity", () => {
  it("blocks network providers for restricted data", () => {
    const providers = [
      provider("cloud", { requiresNetwork: true }),
      provider("local", { requiresNetwork: false }),
    ];

    const decision = evaluateRouting(providers, { sensitivity: "restricted" });
    expect(decision.selectedRoute!.providerId).toBe("local");

    const skipped = decision.routes.find((r) => r.providerId === "cloud");
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.reason).toContain("restricted");
  });
});

// --- failover chain ---------------------------------------------------------

describe("failover chain", () => {
  it("shows failover alternatives", () => {
    const providers = [
      provider("primary", { latencyMs: 50 }),
      provider("backup", { latencyMs: 200 }),
    ];

    const decision = evaluateRouting(providers, {});
    expect(decision.routes).toHaveLength(2);
    expect(decision.routes[0].status).toBe("selected");
    expect(decision.routes[1].status).toBe("failover");
  });
});

// --- multi-provider fixture -------------------------------------------------

describe("multi-provider fixture", () => {
  it("routes across heterogeneous providers", () => {
    const providers = [
      provider("cloud-a", { latencyMs: 100, requiresNetwork: true }),
      provider("cloud-b", { latencyMs: 80, requiresNetwork: true, capabilities: caps({ vision: true }) }),
      provider("local", { latencyMs: 20, requiresNetwork: false, capabilities: caps({ tools: false }) }),
    ];

    const decision = evaluateRouting(providers, {
      requiredCapabilities: { tools: true },
      sensitivity: "internal",
    });

    // local lacks tools → skipped. cloud-b is faster → selected.
    expect(decision.routed).toBe(true);
    expect(decision.selectedRoute!.providerId).toBe("cloud-b");
    expect(decision.routes.find((r) => r.providerId === "local")!.status).toBe("skipped");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatRoutingDecision", () => {
  it("renders routing decision with routes and reasons", () => {
    const providers = [
      provider("cloud", { latencyMs: 100 }),
      provider("local", { latencyMs: 20, requiresNetwork: false }),
    ];

    const decision = evaluateRouting(providers, { offlineMode: true });
    const output = formatRoutingDecision(decision);

    expect(output).toContain("Provider Routing");
    expect(output).toContain("Offline: YES");
    expect(output).toContain("local");
    expect(output).toContain("selected");
    expect(output).toContain("cloud");
    expect(output).toContain("blocked");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("evaluation does not send requests or modify providers", () => {
    const providers = [provider("a"), provider("b")];
    const before = JSON.stringify(providers);

    evaluateRouting(providers, {});
    expect(JSON.stringify(providers)).toBe(before);
  });
});
