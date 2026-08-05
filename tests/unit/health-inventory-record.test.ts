import { describe, it, expect } from "vitest";
import {
  healthInventoryRecord,
  HEALTH_INVENTORY_SCHEMA,
  HEALTH_INVENTORY_VERSION,
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
  overrides: Partial<HealthInventory> = {},
): HealthInventory {
  return {
    settingsPath: (process.env.HOME ?? "/root") + "/sub/settings.json",
    settingsFound: true,
    probeTimeoutMs: 3000,
    integrations,
    ...overrides,
  };
}

describe("healthInventoryRecord (Issue #694)", () => {
  it("tags the record with the health-inventory schema identity", () => {
    const record = healthInventoryRecord(inventory([]));
    expect(record.schema).toBe(HEALTH_INVENTORY_SCHEMA);
    expect(record.v).toBe(HEALTH_INVENTORY_VERSION);
  });

  it("carries the home-collapsed settings path and probe timeout", () => {
    const record = healthInventoryRecord(inventory([], { probeTimeoutMs: 2500 }));
    expect(record.settingsPath).toBe("~/sub/settings.json");
    expect(record.settingsFound).toBe(true);
    expect(record.probeTimeoutMs).toBe(2500);
  });

  it("carries every integration field", () => {
    const record = healthInventoryRecord(
      inventory([
        integration({
          name: "full",
          target: "stdio: my-server",
          transport: "stdio",
          category: "unavailable",
          reason: "spawn ENOENT",
          probeMs: 3,
        }),
      ]),
    );
    const entry = (record.integrations as Record<string, unknown>[])[0];
    expect(entry.kind).toBe("mcp");
    expect(entry.name).toBe("full");
    expect(entry.target).toBe("stdio: my-server");
    expect(entry.transport).toBe("stdio");
    expect(entry.enabled).toBe(true);
    expect(entry.category).toBe("unavailable");
    expect(entry.reason).toBe("spawn ENOENT");
    expect(entry.probeMs).toBe(3);
  });

  it("omits transport when absent", () => {
    const record = healthInventoryRecord(inventory([integration()]));
    const entry = (record.integrations as Record<string, unknown>[])[0];
    expect(entry.transport).toBeUndefined();
  });

  it("carries disabled entries with enabled false", () => {
    const record = healthInventoryRecord(
      inventory([
        integration({ enabled: false, category: "disabled", reason: "disabled", probeMs: null }),
      ]),
    );
    const entry = (record.integrations as Record<string, unknown>[])[0];
    expect(entry.enabled).toBe(false);
    expect(entry.category).toBe("disabled");
  });

  it("omits parseError when absent and carries it when present", () => {
    expect(healthInventoryRecord(inventory([])).parseError).toBeUndefined();
    expect(
      healthInventoryRecord(inventory([], { parseError: "invalid JSON" })).parseError,
    ).toBe("invalid JSON");
  });

  it("is a pure, stable builder", () => {
    const inv = inventory([integration()]);
    expect(JSON.stringify(healthInventoryRecord(inv))).toBe(
      JSON.stringify(healthInventoryRecord(inv)),
    );
  });
});
