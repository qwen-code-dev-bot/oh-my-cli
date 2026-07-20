import { describe, it, expect } from "vitest";
import {
  filterCommands,
  defaultCommands,
  renderPaletteLines,
  paletteStyle,
  slashPreviewQuery,
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
