import { describe, it, expect } from "vitest";
import {
  filterCommands,
  defaultCommands,
  renderPaletteLines,
  paletteStyle,
  slashPreviewQuery,
  commandDisabledReason,
  formatPalettePickerLines,
  parsePaletteSelection,
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

describe("Palette: filterCommands ranking (Issue #765)", () => {
  // Declaration order deliberately puts the description-matcher first: the
  // ranking, not the catalog order, must decide what Enter runs.
  const commands: PaletteCommand[] = [
    { name: "/resume", description: "Resume a session (exit, then --resume)", action: () => {} },
    { name: "/reset-view", description: "Reset the view layout", action: () => {} },
    { name: "/exit", description: "Exit the interactive session", action: () => {} },
    { name: "/export", description: "Export the transcript", action: () => {} },
  ];

  it("ranks the exact name match first even when declared after description matches", () => {
    const names = filterCommands(commands, "exit").map((c) => c.name);
    expect(names[0]).toBe("/exit");
    expect(names).toContain("/resume"); // description still matches, just ranks lower
  });

  it("ranks name starts-with above other name substrings and descriptions", () => {
    const names = filterCommands(commands, "res").map((c) => c.name);
    expect(names).toEqual(["/resume", "/reset-view"]);
  });

  it("keeps declaration order as the tie-break within a tier", () => {
    const names = filterCommands(commands, "e").map((c) => c.name);
    // /exit and /export start with "e" (prefix tier); /resume and
    // /reset-view merely contain it (substring tier). Declaration order
    // holds within each tier.
    expect(names).toEqual(["/exit", "/export", "/resume", "/reset-view"]);
  });

  it("treats a leading slash in the query the same as without", () => {
    expect(filterCommands(commands, "/exit").map((c) => c.name)[0]).toBe("/exit");
    expect(filterCommands(commands, "exit").map((c) => c.name)[0]).toBe("/exit");
  });

  it("matches multi-word names by their full name including the slash form", () => {
    const approval: PaletteCommand[] = [
      { name: "/approval-mode default", description: "Require approval", action: () => {} },
      { name: "/approval", description: "Show approvals", action: () => {} },
    ];
    expect(filterCommands(approval, "approval-mode default").map((c) => c.name)[0]).toBe(
      "/approval-mode default",
    );
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

describe("Palette: honest session commands (Issue #713)", () => {
  const find = (name: string) => {
    const cmd = defaultCommands().find((c) => c.name === name);
    expect(cmd).toBeTruthy();
    return cmd!;
  };

  it("/resume states that in-shell switching is not supported and names the supported paths", async () => {
    const resume = find("/resume");
    const output = await resume.action("");
    expect(typeof output).toBe("string");
    expect(output).toContain("In-shell session switching is not supported");
    expect(output).toContain("--resume <id-or-name>");
    expect(output).toContain("--browse-sessions");
    // The palette listing itself no longer advertises an in-shell capability.
    expect(resume.description).toContain("--resume");
    expect(resume.description).toContain("--browse-sessions");
  });

  it("/resume ignores arguments: the notice is identical with or without one", async () => {
    const resume = find("/resume");
    expect(await resume.action("some-session-id")).toBe(await resume.action(""));
  });

  it("/new fallback action reports the surface limitation instead of silently no-oping", async () => {
    const cmd = find("/new");
    const output = await cmd.action("");
    expect(typeof output).toBe("string");
    expect(output).toContain("interactive shell");
  });
});

describe("Palette: single honest /approval-mode entry (Issue #715)", () => {
  it("advertises one /approval-mode command naming the three modes", () => {
    const cmd = defaultCommands().find((c) => c.name === "/approval-mode");
    expect(cmd).toBeTruthy();
    expect(cmd!.description).toContain("default");
    expect(cmd!.description).toContain("auto-edit");
    expect(cmd!.description).toContain("yolo");
  });

  it("the three hollow multi-word stubs are gone — no advertised command is unreachable", () => {
    const names = defaultCommands().map((c) => c.name);
    expect(names).not.toContain("/approval-mode default");
    expect(names).not.toContain("/approval-mode auto-edit");
    expect(names).not.toContain("/approval-mode yolo");
    // And no multi-word name remains that the token-based slash resolver
    // could never match from typed input.
    for (const name of names) {
      expect(name.startsWith("/")).toBe(true);
      expect(name.includes(" ")).toBe(false);
    }
  });

  it("the fallback action is honest for surfaces without live switching", async () => {
    const cmd = defaultCommands().find((c) => c.name === "/approval-mode")!;
    const output = await cmd.action("");
    expect(typeof output).toBe("string");
    expect(output).toContain("cannot change the approval mode");
    expect(output).toContain("--approval-mode");
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

describe("Palette: line-based picker (Issue #717)", () => {
  const commands: PaletteCommand[] = [
    { name: "/new", description: "Start a new conversation session", action: () => {} },
    { name: "/status", description: "Show current session and workspace info", action: () => {} },
    { name: "/goal", description: "Set, inspect, pause, resume, achieve, or clear the session goal", action: () => {} },
  ];

  it("renders one numbered line per command with its description", () => {
    const lines = formatPalettePickerLines(commands);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("1)");
    expect(lines[0]).toContain("/new");
    expect(lines[0]).toContain("Start a new conversation session");
    expect(lines[2]).toContain("3)");
    expect(lines[2]).toContain("/goal");
  });

  it("replaces the description with the unavailability reason when gated", () => {
    const busy = "a turn is in flight — available when it settles";
    const lines = formatPalettePickerLines(commands, {
      reasonFor: (c) => (c.name === "/goal" ? busy : null),
    });
    expect(lines[2]).toContain(busy);
    expect(lines[2]).not.toContain("Set, inspect, pause");
    expect(lines[1]).toContain("Show current session and workspace info");
  });

  it("parses empty input as cancel", () => {
    expect(parsePaletteSelection("", 3)).toEqual({ kind: "cancel" });
    expect(parsePaletteSelection("   ", 3)).toEqual({ kind: "cancel" });
  });

  it("parses a valid 1-based selection", () => {
    expect(parsePaletteSelection("1", 3)).toEqual({ kind: "select", index: 0 });
    expect(parsePaletteSelection(" 3 ", 3)).toEqual({ kind: "select", index: 2 });
  });

  it("rejects non-numeric input naming it", () => {
    const decision = parsePaletteSelection("/status", 3);
    expect(decision.kind).toBe("invalid");
    if (decision.kind === "invalid") {
      expect(decision.message).toContain('"/status"');
      expect(decision.message).toContain("1 and 3");
    }
  });

  it("rejects out-of-range numbers naming the bounds", () => {
    for (const answer of ["0", "4", "99"]) {
      const decision = parsePaletteSelection(answer, 3);
      expect(decision.kind).toBe("invalid");
      if (decision.kind === "invalid") {
        expect(decision.message).toContain("1 and 3");
      }
    }
  });
});
