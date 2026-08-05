import { describe, it, expect } from "vitest";
import {
  healthInventoryStrictExit,
  type HealthInventory,
  type IntegrationHealth,
} from "../../src/health-inventory.js";

function integration(overrides: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    kind: "mcp",
    name: "srv",
    target: "stdio: node",
    enabled: true,
    category: "healthy",
    reason: "command resolved",
    probeMs: 0,
    ...overrides,
  };
}

function inventory(
  integrations: IntegrationHealth[],
  parseError?: string,
): HealthInventory {
  return {
    settingsPath: "/tmp/settings.json",
    settingsFound: true,
    ...(parseError !== undefined ? { parseError } : {}),
    probeTimeoutMs: 3000,
    integrations,
  };
}

describe("healthInventoryStrictExit (Issue #690)", () => {
  it("maps an empty inventory to exit 0", () => {
    expect(healthInventoryStrictExit(inventory([]))).toBe(0);
  });

  it("maps a healthy-only inventory to exit 0", () => {
    expect(
      healthInventoryStrictExit(
        inventory([integration(), integration({ name: "srv-2" })]),
      ),
    ).toBe(0);
  });

  it("maps disabled entries to exit 0", () => {
    expect(
      healthInventoryStrictExit(
        inventory([
          integration({ enabled: false, category: "disabled", reason: "disabled", probeMs: null }),
        ]),
      ),
    ).toBe(0);
  });

  it("maps an enabled unavailable integration to exit 1", () => {
    expect(
      healthInventoryStrictExit(
        inventory([integration({ category: "unavailable", reason: "spawn ENOENT", probeMs: 1 })]),
      ),
    ).toBe(1);
  });

  it("maps an enabled misconfigured integration to exit 1", () => {
    expect(
      healthInventoryStrictExit(
        inventory([integration({ category: "misconfigured", reason: "invalid url", probeMs: null })]),
      ),
    ).toBe(1);
  });

  it("maps a settings parse error to exit 1 even with no integrations", () => {
    expect(healthInventoryStrictExit(inventory([], "invalid JSON"))).toBe(1);
  });

  it("maps a mixed healthy + disabled + unhealthy inventory to exit 1", () => {
    expect(
      healthInventoryStrictExit(
        inventory([
          integration(),
          integration({ name: "off", enabled: false, category: "disabled", reason: "disabled", probeMs: null }),
          integration({ name: "broken", category: "unavailable", reason: "spawn ENOENT", probeMs: 1 }),
        ]),
      ),
    ).toBe(1);
  });

  it("is a pure, stable mapping", () => {
    const failing = inventory([integration({ category: "misconfigured", reason: "missing command or url", probeMs: null })]);
    expect(healthInventoryStrictExit(failing)).toBe(healthInventoryStrictExit(failing));
    const clean = inventory([integration()]);
    expect(healthInventoryStrictExit(clean)).toBe(healthInventoryStrictExit(clean));
  });
});
