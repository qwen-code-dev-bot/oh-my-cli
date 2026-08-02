import { describe, it, expect } from "vitest";
import {
  GOAL_COMMANDS,
  formatGoalHelp,
  getGoalCompletions,
  getAvailableCompletions,
  isCommandAvailable,
} from "../../src/goal-help.js";

// Pure-function coverage for Goal help/completion (Issue #403): command
// registry, help rendering, completion candidates, terminal-state
// filtering, and determinism.

// --- command registry -------------------------------------------------------

describe("command registry", () => {
  it("has all lifecycle commands", () => {
    const names = GOAL_COMMANDS.map((c) => c.name);
    expect(names).toContain("set");
    expect(names).toContain("status");
    expect(names).toContain("title");
    expect(names).toContain("pause");
    expect(names).toContain("resume");
    expect(names).toContain("achieve");
    expect(names).toContain("fail");
    expect(names).toContain("cancel");
    expect(names).toContain("supersede");
    expect(names).toContain("clear");
    expect(GOAL_COMMANDS.length).toBe(10);
  });

  it("every command has syntax and description", () => {
    for (const cmd of GOAL_COMMANDS) {
      expect(cmd.syntax.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });
});

// --- help formatting --------------------------------------------------------

describe("formatGoalHelp", () => {
  it("renders all commands", () => {
    const output = formatGoalHelp();
    expect(output).toContain("Goal Commands");
    expect(output).toContain("/goal <objective>");
    expect(output).toContain("/goal status");
    expect(output).toContain("/goal pause");
    expect(output).toContain("/goal achieve");
  });

  it("is deterministic", () => {
    const a = formatGoalHelp("active");
    const b = formatGoalHelp("active");
    expect(a).toBe(b);
  });

  it("marks unavailable commands", () => {
    const output = formatGoalHelp("achieved");
    // pause requires active, should be marked unavailable.
    expect(output).toContain("·");
  });
});

// --- command availability ---------------------------------------------------

describe("isCommandAvailable", () => {
  it("allows set/status/clear when no Goal exists", () => {
    const set = GOAL_COMMANDS.find((c) => c.name === "set")!;
    const status = GOAL_COMMANDS.find((c) => c.name === "status")!;
    const clear = GOAL_COMMANDS.find((c) => c.name === "clear")!;
    const pause = GOAL_COMMANDS.find((c) => c.name === "pause")!;

    expect(isCommandAvailable(set, undefined)).toBe(true);
    expect(isCommandAvailable(status, undefined)).toBe(true);
    expect(isCommandAvailable(clear, undefined)).toBe(true);
    expect(isCommandAvailable(pause, undefined)).toBe(false);
  });

  it("allows pause only when active", () => {
    const pause = GOAL_COMMANDS.find((c) => c.name === "pause")!;
    expect(isCommandAvailable(pause, "active")).toBe(true);
    expect(isCommandAvailable(pause, "paused")).toBe(false);
  });

  it("allows resume only when paused", () => {
    const resume = GOAL_COMMANDS.find((c) => c.name === "resume")!;
    expect(isCommandAvailable(resume, "paused")).toBe(true);
    expect(isCommandAvailable(resume, "active")).toBe(false);
  });

  it("excludes non-terminal commands in terminal state", () => {
    const pause = GOAL_COMMANDS.find((c) => c.name === "pause")!;
    const achieve = GOAL_COMMANDS.find((c) => c.name === "achieve")!;
    const set = GOAL_COMMANDS.find((c) => c.name === "set")!;

    expect(isCommandAvailable(pause, "achieved")).toBe(false);
    expect(isCommandAvailable(achieve, "achieved")).toBe(false);
    expect(isCommandAvailable(set, "achieved")).toBe(true); // set is availableInTerminal
  });
});

// --- completions ------------------------------------------------------------

describe("getGoalCompletions", () => {
  it("returns all commands with availability", () => {
    const completions = getGoalCompletions("active");
    expect(completions.length).toBe(10);
    expect(completions.every((c) => typeof c.available === "boolean")).toBe(true);
  });

  it("is deterministic", () => {
    const a = getGoalCompletions("active");
    const b = getGoalCompletions("active");
    expect(a.map((c) => c.text)).toEqual(b.map((c) => c.text));
    expect(a.map((c) => c.available)).toEqual(b.map((c) => c.available));
  });
});

describe("getAvailableCompletions", () => {
  it("filters to available commands for active state", () => {
    const available = getAvailableCompletions("active");
    const names = available.map((c) => c.command.name);
    expect(names).toContain("set");
    expect(names).toContain("status");
    expect(names).toContain("pause");
    expect(names).toContain("achieve");
    expect(names).not.toContain("resume"); // requires paused
  });

  it("filters to available commands for terminal state", () => {
    const available = getAvailableCompletions("failed");
    const names = available.map((c) => c.command.name);
    expect(names).toContain("set");
    expect(names).toContain("status");
    expect(names).toContain("clear");
    expect(names).not.toContain("pause");
    expect(names).not.toContain("achieve");
  });

  it("filters to available commands for no Goal", () => {
    const available = getAvailableCompletions(undefined);
    const names = available.map((c) => c.command.name);
    expect(names).toContain("set");
    expect(names).toContain("status");
    expect(names).toContain("clear");
    expect(names).not.toContain("pause");
  });
});
