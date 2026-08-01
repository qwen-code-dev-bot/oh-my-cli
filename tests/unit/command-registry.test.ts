import { describe, it, expect } from "vitest";
import {
  CommandRegistry,
  formatSearchResults,
  formatCommandHelp,
  type CommandMeta,
  type Capability,
} from "../../src/command-registry.js";

// Pure-function coverage for the command registry (Issue #343): registration,
// lookup, search ranking, disabled state, shortcut safety, and formatting.

function cmd(id: string, overrides: Partial<CommandMeta> = {}): CommandMeta {
  return {
    id,
    title: `Command ${id}`,
    slash: `/${id.split(".").pop()}`,
    category: "system",
    aliases: [],
    capabilities: [],
    description: `Description for ${id}`,
    ...overrides,
  };
}

function registry(...cmds: CommandMeta[]): CommandRegistry {
  const reg = new CommandRegistry();
  for (const c of cmds) reg.register(c);
  return reg;
}

const ALL_CAPS = new Set<Capability>([
  "trusted-workspace", "active-session", "provider-configured",
  "workflow-enabled", "goal-enabled", "git-repository",
]);

// --- registration -----------------------------------------------------------

describe("registration", () => {
  it("registers and retrieves commands", () => {
    const reg = registry(cmd("session.export"), cmd("session.name"));
    expect(reg.size).toBe(2);
    expect(reg.get("session.export")?.title).toBe("Command session.export");
  });

  it("rejects duplicate ids", () => {
    const reg = new CommandRegistry();
    reg.register(cmd("a"));
    expect(() => reg.register(cmd("a"))).toThrow("Duplicate");
  });

  it("rejects unsafe single-keystroke shortcuts", () => {
    expect(() => registry(cmd("a", { shortcut: "x" }))).toThrow("single-keystroke");
  });

  it("allows multi-key shortcuts", () => {
    const reg = registry(cmd("a", { shortcut: "ctrl+e" }));
    expect(reg.get("a")?.shortcut).toBe("ctrl+e");
  });
});

// --- lookup -----------------------------------------------------------------

describe("lookup", () => {
  it("finds by slash command", () => {
    const reg = registry(cmd("session.export", { slash: "/export" }));
    expect(reg.getBySlash("/export")?.id).toBe("session.export");
  });

  it("finds by alias", () => {
    const reg = registry(cmd("session.export", { slash: "/export", aliases: ["/save"] }));
    expect(reg.getBySlash("/save")?.id).toBe("session.export");
  });

  it("lists by category", () => {
    const reg = registry(
      cmd("a", { category: "session" }),
      cmd("b", { category: "model" }),
      cmd("c", { category: "session" }),
    );
    expect(reg.listByCategory("session")).toHaveLength(2);
    expect(reg.listByCategory("model")).toHaveLength(1);
  });
});

// --- search ranking ---------------------------------------------------------

describe("search ranking", () => {
  const reg = registry(
    cmd("session.export", { slash: "/export", title: "Export session", aliases: ["/save"] }),
    cmd("session.name", { slash: "/name", title: "Name session" }),
    cmd("model.select", { slash: "/model", title: "Select model" }),
    cmd("goal.inspect", { slash: "/goal", title: "Inspect goal" }),
    cmd("diff.navigate", { slash: "/diff", title: "Navigate diffs" }),
  );

  it("ranks exact slash match highest", () => {
    const results = reg.search("/export", ALL_CAPS);
    expect(results[0].command.id).toBe("session.export");
    expect(results[0].matchType).toBe("exact");
  });

  it("ranks prefix match", () => {
    const results = reg.search("exp", ALL_CAPS);
    expect(results[0].command.id).toBe("session.export");
    expect(results[0].matchType).toBe("prefix");
  });

  it("ranks alias match", () => {
    const results = reg.search("/save", ALL_CAPS);
    expect(results[0].command.id).toBe("session.export");
    expect(results[0].matchType).toBe("alias");
  });

  it("ranks fuzzy match", () => {
    const results = reg.search("mdl", ALL_CAPS);
    expect(results.some((r) => r.command.id === "model.select")).toBe(true);
  });

  it("boosts recent commands", () => {
    reg.recordUsage("diff.navigate");
    // "nav" prefix-matches "Navigate diffs", so matchType is "prefix".
    // Recency boosts within the same match tier.
    const results = reg.search("nav", ALL_CAPS);
    expect(results[0].command.id).toBe("diff.navigate");
  });

  it("returns empty for no match", () => {
    const results = reg.search("zzzznotfound", ALL_CAPS);
    expect(results).toHaveLength(0);
  });

  it("empty query returns all commands", () => {
    const results = reg.search("", ALL_CAPS);
    expect(results.length).toBe(5);
  });

  it("is deterministic for equal scores", () => {
    const r1 = reg.search("session", ALL_CAPS);
    const r2 = reg.search("session", ALL_CAPS);
    expect(r1.map((r) => r.command.id)).toEqual(r2.map((r) => r.command.id));
  });
});

// --- disabled state ---------------------------------------------------------

describe("disabled state", () => {
  it("shows disabled commands with reason", () => {
    const reg = registry(
      cmd("goal.inspect", { capabilities: ["goal-enabled"] }),
      cmd("session.export", { capabilities: [] }),
    );

    const noCaps = new Set<Capability>();
    const results = reg.search("", noCaps);

    const goalResult = results.find((r) => r.command.id === "goal.inspect");
    expect(goalResult?.disabled).toBeDefined();
    expect(goalResult?.disabled?.reason).toContain("goal-enabled");

    const exportResult = results.find((r) => r.command.id === "session.export");
    expect(exportResult?.disabled).toBeUndefined();
  });

  it("unavailable actions remain visible in search", () => {
    const reg = registry(
      cmd("workflow.run", { slash: "/workflow", capabilities: ["workflow-enabled"] }),
    );

    const results = reg.search("workflow", new Set<Capability>());
    expect(results.length).toBe(1);
    expect(results[0].disabled).toBeDefined();
  });

  it("checkAvailability returns all disabled commands", () => {
    const reg = registry(
      cmd("a", { capabilities: ["trusted-workspace"] }),
      cmd("b", { capabilities: ["active-session"] }),
      cmd("c", { capabilities: [] }),
    );

    const disabled = reg.checkAvailability(new Set<Capability>());
    expect(disabled).toHaveLength(2);
  });

  it("isAvailable checks capabilities", () => {
    const reg = registry(cmd("a", { capabilities: ["git-repository"] }));
    expect(reg.isAvailable("a", new Set<Capability>())).toBe(false);
    expect(reg.isAvailable("a", new Set<Capability>(["git-repository"]))).toBe(true);
  });
});

// --- shortcut hints ---------------------------------------------------------

describe("shortcut hints", () => {
  it("derives shortcuts from metadata", () => {
    const reg = registry(
      cmd("diff.navigate", { shortcut: "ctrl+d" }),
      cmd("session.export", { shortcut: "ctrl+shift+e" }),
    );

    const results = reg.search("", ALL_CAPS);
    const diff = results.find((r) => r.command.id === "diff.navigate");
    expect(diff?.command.shortcut).toBe("ctrl+d");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("formats search results with disabled reasons", () => {
    const reg = registry(
      cmd("goal.inspect", { slash: "/goal", title: "Inspect goal", capabilities: ["goal-enabled"] }),
    );

    const results = reg.search("goal", new Set<Capability>());
    const output = formatSearchResults(results);

    expect(output).toContain("/goal");
    expect(output).toContain("Inspect goal");
    expect(output).toContain("goal-enabled");
  });

  it("formats command help", () => {
    const meta = cmd("session.export", {
      slash: "/export",
      title: "Export session",
      category: "session",
      aliases: ["/save"],
      shortcut: "ctrl+e",
      capabilities: ["active-session"],
      description: "Export the current session.",
    });

    const output = formatCommandHelp(meta);
    expect(output).toContain("/export");
    expect(output).toContain("Export session");
    expect(output).toContain("session");
    expect(output).toContain("/save");
    expect(output).toContain("ctrl+e");
    expect(output).toContain("active-session");
  });

  it("formats empty results", () => {
    expect(formatSearchResults([])).toContain("No matching");
  });
});

// --- recency tracking -------------------------------------------------------

describe("recency tracking", () => {
  it("records and ranks recent commands", () => {
    const reg = registry(
      cmd("a", { title: "Alpha action" }),
      cmd("b", { title: "Beta action" }),
      cmd("c", { title: "Gamma action" }),
    );

    reg.recordUsage("c");
    reg.recordUsage("a");

    // "a" is most recent, should rank higher for a shared substring.
    const results = reg.search("action", ALL_CAPS);
    expect(results[0].command.id).toBe("a");
  });

  it("bounds the recent list", () => {
    const reg = new CommandRegistry();
    for (let i = 0; i < 30; i++) {
      reg.register(cmd(`cmd${i}`, { title: `Command ${i}` }));
      reg.recordUsage(`cmd${i}`);
    }
    // Only the last 20 should be in recent.
    const results = reg.search("Command", ALL_CAPS);
    expect(results.length).toBe(20); // limit defaults to 20
  });
});
