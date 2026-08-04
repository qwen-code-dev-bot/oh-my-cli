import { describe, it, expect } from "vitest";
import {
  filterCommands,
  defaultCommands,
  renderPaletteLines,
  paletteStyle,
  slashPreviewQuery,
  commandDisabledReason,
} from "../../src/palette.js";
import type { PaletteCommand } from "../../src/palette.js";

describe("Palette: filterCommands", () => {
  const commands: PaletteCommand[] = [
    { name: "/new", description: "Start a new conversation session", action: () => {} },
    { name: "/resume", description: "Resume a previous session by ID", action: () => {} },
    { name: "/clear", description: "Clear the terminal screen", action: () => {} },
    { name: "/help", description: "Show available commands and options", action: () => {} },
    { name: "/exit", description: "Exit the interactive session", action: () => {} },
    { name: "/approval-mode default", description: "Require approval for all mutating tools", action: () => {} },
    { name: "/approval-mode auto-edit", description: "Auto-approve write/edit, prompt for shell", action: () => {} },
    { name: "/approval-mode yolo", description: "Auto-approve all tools (unsafe)", action: () => {} },
  ];

  it("returns all commands when query is empty", () => {
    expect(filterCommands(commands, "").length).toBe(8);
  });

  it("filters by name", () => {
    const result = filterCommands(commands, "exit");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("/exit");
  });

  it("filters by description", () => {
    const result = filterCommands(commands, "approval");
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.every((c) => c.name.startsWith("/approval-mode"))).toBe(true);
  });

  it("is case-insensitive", () => {
    const result = filterCommands(commands, "CLEAR");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("/clear");
  });

  it("returns empty array for no matches", () => {
    const result = filterCommands(commands, "xyznonexistent");
    expect(result.length).toBe(0);
  });

  it("matches partial name", () => {
    const result = filterCommands(commands, "res");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("/resume");
  });

  it("matches across name and description", () => {
    const result = filterCommands(commands, "session");
    expect(result.length).toBeGreaterThanOrEqual(2); // new, resume, exit all mention "session"
  });
});

describe("Palette: inline slash preview activation", () => {
  it("opens only for one leading slash token", () => {
    expect(slashPreviewQuery("/")).toBe("");
    expect(slashPreviewQuery("/go")).toBe("go");
    expect(slashPreviewQuery("explain /goal")).toBeNull();
    expect(slashPreviewQuery("/goal build this")).toBeNull();
    expect(slashPreviewQuery("/goal\nnext")).toBeNull();
    expect(slashPreviewQuery("//nested")).toBeNull();
  });
});

describe("Palette: defaultCommands", () => {
  it("returns a non-empty list of commands", () => {
    const commands = defaultCommands();
    expect(commands.length).toBeGreaterThan(0);
  });

  it("every command has name, description, and action", () => {
    const commands = defaultCommands();
    for (const cmd of commands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(typeof cmd.action).toBe("function");
    }
  });
});

describe("Palette: renderPaletteLines color", () => {
  const commands: PaletteCommand[] = [
    { name: "/new", description: "Start a new conversation session", action: () => {} },
    { name: "/exit", description: "Exit the interactive session", action: () => {} },
  ];

  it("includes SGR color codes when color is enabled", () => {
    const text = renderPaletteLines(commands, { query: "", selected: 0 }, paletteStyle(true)).join("\n");
    expect(text).toContain("\x1b[1m");
    expect(text).toContain("\x1b[2m");
    expect(text).toContain("\x1b[0m");
  });

  it("omits SGR color codes when color is disabled but keeps content", () => {
    const text = renderPaletteLines(commands, { query: "", selected: 0 }, paletteStyle(false)).join("\n");
    expect(text).not.toContain("\x1b[1m");
    expect(text).not.toContain("\x1b[2m");
    expect(text).not.toContain("\x1b[0m");
    // The command names and descriptions are still rendered.
    expect(text).toContain("/new");
    expect(text).toContain("Start a new conversation session");
  });
});

describe("Palette: disabled reasons (Issue #566)", () => {
  const busyReason = "a turn is in flight — available when it settles";
  const enabled: PaletteCommand = {
    name: "/status",
    description: "Show current session and workspace info",
    action: () => {},
  };
  const disabled: PaletteCommand = {
    name: "/goal",
    description: "Set, inspect, pause, resume, achieve, or clear the session goal",
    action: () => {},
    disabled: () => busyReason,
  };
  const available: PaletteCommand = {
    name: "/help",
    description: "Show available commands and options",
    action: () => {},
    disabled: () => null,
  };

  it("reports availability: absent predicate, null predicate, and reason", () => {
    expect(commandDisabledReason(enabled)).toBeNull();
    expect(commandDisabledReason(available)).toBeNull();
    expect(commandDisabledReason(disabled)).toBe(busyReason);
  });

  it("fails open when the predicate throws (execution gates remain the backstop)", () => {
    const throwing: PaletteCommand = {
      name: "/boom",
      description: "x",
      action: () => {},
      disabled: () => {
        throw new Error("state unavailable");
      },
    };
    expect(commandDisabledReason(throwing)).toBeNull();
  });

  it("renders disabled entries dimmed with the reason, color or not", () => {
    for (const color of [true, false]) {
      const text = renderPaletteLines(
        [enabled, disabled],
        { query: "", selected: 1 },
        paletteStyle(color),
      ).join("\n");
      expect(text).toContain(`/goal`);
      expect(text).toContain(busyReason);
      // The reason is readable without color.
      const noColor = renderPaletteLines(
        [enabled, disabled],
        { query: "", selected: 1 },
        paletteStyle(false),
      ).join("\n");
      expect(noColor).toContain(busyReason);
    }
  });

  it("renders enabled entries without a reason suffix", () => {
    const text = renderPaletteLines([enabled], { query: "", selected: 0 }, paletteStyle(false)).join("\n");
    expect(text).toContain("/status");
    expect(text).not.toContain("—");
  });

  it("renders the transient notice below the query line", () => {
    const lines = renderPaletteLines(
      [disabled],
      { query: "", selected: 0, notice: "/goal unavailable — " + busyReason },
      paletteStyle(false),
    );
    expect(lines[1]).toContain("> ");
    expect(lines[2]).toContain("/goal unavailable");
    expect(lines[2]).toContain(busyReason);
  });

  it("keeps disabled entries discoverable through filtering", () => {
    expect(filterCommands([enabled, disabled], "goal").map((c) => c.name)).toEqual(["/goal"]);
  });
});
