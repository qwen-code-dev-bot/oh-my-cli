import { describe, it, expect } from "vitest";
import { normalizeIntegrations, formatHealthInventory } from "../../src/health-inventory.js";
import type { HealthInventory } from "../../src/health-inventory.js";

describe("Health inventory: normalizeIntegrations", () => {
  it("normalizes stdio, http, and extension entries", () => {
    const { records, probeTimeoutMs } = normalizeIntegrations({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "server"] },
        db: { url: "https://mcp.example.com" },
      },
      extensions: { ext: { path: "./ext" } },
    });
    expect(probeTimeoutMs).toBe(3000);
    expect(records).toHaveLength(3);

    const fsRec = records.find((r) => r.name === "fs")!;
    expect(fsRec.kind).toBe("mcp");
    expect(fsRec.transport).toBe("stdio");
    expect(fsRec.command).toBe("npx");
    expect(fsRec.args).toEqual(["-y", "server"]);

    const dbRec = records.find((r) => r.name === "db")!;
    expect(dbRec.transport).toBe("http");
    expect(dbRec.url).toBe("https://mcp.example.com");

    const extRec = records.find((r) => r.name === "ext")!;
    expect(extRec.kind).toBe("extension");
    expect(extRec.path).toBe("./ext");
  });

  it("defaults enabled to true and honors enabled:false", () => {
    const { records } = normalizeIntegrations({
      mcpServers: { a: { command: "x" }, b: { command: "y", enabled: false } },
    });
    expect(records.find((r) => r.name === "a")!.enabled).toBe(true);
    expect(records.find((r) => r.name === "b")!.enabled).toBe(false);
  });

  it("marks an entry missing command and url as misconfigured", () => {
    const { records } = normalizeIntegrations({ mcpServers: { broken: { args: [] } } });
    expect(records[0].configError).toMatch(/missing command or url/);
  });

  it("marks an invalid url as misconfigured", () => {
    const { records } = normalizeIntegrations({ mcpServers: { bad: { url: "not-a-url" } } });
    expect(records[0].configError).toMatch(/invalid url/);
  });

  it("rejects a non-http url scheme as misconfigured", () => {
    const { records } = normalizeIntegrations({ mcpServers: { bad: { url: "file:///etc/passwd" } } });
    expect(records[0].configError).toMatch(/invalid url/);
  });

  it("marks an extension missing path as misconfigured", () => {
    const { records } = normalizeIntegrations({ extensions: { e: {} } });
    expect(records[0].configError).toMatch(/missing path/);
  });

  it("clamps probeTimeoutMs within bounds", () => {
    expect(normalizeIntegrations({ probeTimeoutMs: 1 }).probeTimeoutMs).toBe(50);
    expect(normalizeIntegrations({ probeTimeoutMs: 999999 }).probeTimeoutMs).toBe(30000);
    expect(normalizeIntegrations({ probeTimeoutMs: 800 }).probeTimeoutMs).toBe(800);
  });

  it("rejects a non-object root", () => {
    const r = normalizeIntegrations("nope");
    expect(r.error).toMatch(/must be an object/);
    expect(r.records).toHaveLength(0);
  });

  it("ignores non-object args arrays gracefully", () => {
    const { records } = normalizeIntegrations({ mcpServers: { s: { command: "x", args: "nope" } } });
    expect(records[0].args).toEqual([]);
  });
});

describe("Health inventory: formatHealthInventory", () => {
  it("formats categories with symbols, sections, and a summary", () => {
    const inv: HealthInventory = {
      settingsPath: "/srv/app/.oh-my-cli/settings.json",
      settingsFound: true,
      probeTimeoutMs: 3000,
      integrations: [
        { kind: "mcp", transport: "stdio", name: "fs", target: "npx", enabled: true, category: "healthy", reason: "command resolved", probeMs: 1 },
        { kind: "mcp", transport: "http", name: "db", target: "127.0.0.1:9", enabled: true, category: "unavailable", reason: "connection refused", probeMs: 2 },
        { kind: "mcp", name: "legacy", target: "", enabled: false, category: "disabled", reason: "disabled", probeMs: null },
        { kind: "extension", name: "ext", target: "~/ext", enabled: true, category: "healthy", reason: "path exists", probeMs: 0 },
      ],
    };
    const out = formatHealthInventory(inv);
    expect(out).toContain("Health Inventory");
    expect(out).toContain("MCP servers:");
    expect(out).toContain("Extensions:");
    expect(out).toContain("✓");
    expect(out).toContain("✗");
    expect(out).toContain("⊘");
    expect(out).toMatch(/Summary: 2 healthy, 1 unavailable, 1 disabled, 0 misconfigured \(4 total\)/);
  });

  it("reports a missing settings file without integrations", () => {
    const home = process.env.HOME ?? "/tmp";
    const inv: HealthInventory = {
      settingsPath: `${home}/.oh-my-cli/settings.json`,
      settingsFound: false,
      probeTimeoutMs: 3000,
      integrations: [],
    };
    const out = formatHealthInventory(inv);
    expect(out).not.toContain(`${home}/.oh-my-cli`);
    expect(out).toContain("~");
    expect(out).toContain("No settings file found");
  });

  it("reports a settings parse error", () => {
    const inv: HealthInventory = {
      settingsPath: "/srv/.oh-my-cli/settings.json",
      settingsFound: true,
      parseError: "invalid JSON",
      probeTimeoutMs: 3000,
      integrations: [],
    };
    const out = formatHealthInventory(inv);
    expect(out).toContain("Settings error: invalid JSON");
  });

  it("redacts secret-like values that reach the formatted output", () => {
    const fakeToken = ["fake", "token", "value", "1234567890"].join("");
    const inv: HealthInventory = {
      settingsPath: "/srv/.oh-my-cli/settings.json",
      settingsFound: true,
      probeTimeoutMs: 3000,
      integrations: [
        { kind: "mcp", transport: "http", name: "db", target: `Bearer ${fakeToken}`, enabled: true, category: "unavailable", reason: "connection refused", probeMs: 1 },
      ],
    };
    const out = formatHealthInventory(inv);
    expect(out).not.toContain(fakeToken);
    expect(out).toContain("[REDACTED]");
  });
});
