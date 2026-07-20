import { describe, expect, it } from "vitest";
import {
  FOUNDATIONAL_SLASH_COMMANDS,
  formatSlashCommandHelp,
  resolveSlashCommand,
} from "../../src/slash-command.js";

const commands = ["/help", "/clear", "/exit"] as const;

describe("resolveSlashCommand", () => {
  it("resolves an exact command after trimming whitespace", () => {
    expect(resolveSlashCommand("  /clear  ", commands)).toEqual({
      kind: "command",
      name: "/clear",
    });
  });

  it("normalizes foundational aliases", () => {
    expect(resolveSlashCommand("/?", commands)).toEqual({
      kind: "command",
      name: "/help",
    });
    expect(resolveSlashCommand("/quit", commands)).toEqual({
      kind: "command",
      name: "/exit",
    });
  });

  it("keeps unknown slash input local and actionable", () => {
    expect(resolveSlashCommand("/wat", commands)).toEqual({
      kind: "unknown",
      input: "/wat",
      message: "Unknown command /wat. Use /help or Ctrl+K to browse commands.",
    });
  });

  it("does not classify ordinary prompts as commands", () => {
    expect(resolveSlashCommand("explain src/foo/bar.ts", commands)).toEqual({
      kind: "prompt",
    });
    expect(resolveSlashCommand("use /help in the docs", commands)).toEqual({
      kind: "prompt",
    });
  });

  it("requires an exact command instead of accepting arguments implicitly", () => {
    expect(resolveSlashCommand("/clear now", commands)).toMatchObject({
      kind: "unknown",
      input: "/clear now",
    });
  });

  it("renders deterministic local help for the foundational commands", () => {
    expect(formatSlashCommandHelp(FOUNDATIONAL_SLASH_COMMANDS)).toBe(
      "Commands: /help · /clear · /exit",
    );
  });
});
