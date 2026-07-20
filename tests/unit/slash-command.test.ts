import { describe, expect, it } from "vitest";
import {
  FOUNDATIONAL_SLASH_COMMANDS,
  INTERACTIVE_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMAND_DESCRIPTORS,
  formatRuntimeSlashCommand,
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

const runtime = {
  model: "qwen3.8-max",
  workspace: "/Users/tester/work/oh-my-cli",
  approvalMode: "default",
  sessionId: "session-42",
  settingsPath: "/Users/tester/.oh-my-cli/settings.json",
  tools: ["read", "list", "glob", "grep", "write", "edit", "shell"],
  home: "/Users/tester",
};

describe("formatRuntimeSlashCommand", () => {
  it("reports live session state without an endpoint or credential", () => {
    expect(formatRuntimeSlashCommand("/status", runtime)).toBe(
      "Status\n" +
        "  model: qwen3.8-max\n" +
        "  workspace: ~/work/oh-my-cli\n" +
        "  approval: default\n" +
        "  session: session-42",
    );
  });

  it("reports the active model and redacted settings path", () => {
    expect(formatRuntimeSlashCommand("/model", runtime)).toBe(
      "Model\n" +
        "  active: qwen3.8-max\n" +
        "  settings: ~/.oh-my-cli/settings.json",
    );
    expect(formatRuntimeSlashCommand("/settings", runtime)).toBe(
      "Settings: ~/.oh-my-cli/settings.json",
    );
  });

  it("does not collapse a sibling path that only shares the home prefix", () => {
    expect(
      formatRuntimeSlashCommand("/settings", {
        ...runtime,
        settingsPath: "/Users/tester-other/settings.json",
      }),
    ).toBe("Settings: /Users/tester-other/settings.json");
  });

  it("lists the actual available tools deterministically", () => {
    expect(formatRuntimeSlashCommand("/tools", runtime)).toBe(
      "Tools (7): read · list · glob · grep · write · edit · shell",
    );
  });

  it("bounds an unexpectedly large tool inventory", () => {
    const output = formatRuntimeSlashCommand("/tools", {
      ...runtime,
      tools: Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`),
    });
    expect(output).toContain("Tools (20): tool-1");
    expect(output).toContain("tool-16 · … +4 more");
    expect(output).not.toContain("tool-17");
  });

  it("redacts secret-shaped values and flattens control characters", () => {
    expect(
      formatRuntimeSlashCommand("/model", {
        ...runtime,
        model: "sk-1234567890abcdefghijkl\nspoof",
      }),
    ).toBe(
      "Model\n" +
        "  active: [REDACTED] spoof\n" +
        "  settings: ~/.oh-my-cli/settings.json",
    );
  });

  it("returns null for a non-runtime command", () => {
    expect(formatRuntimeSlashCommand("/clear", runtime)).toBeNull();
  });
});

describe("interactive slash command inventory", () => {
  it("keeps foundational commands first and exposes runtime inspection", () => {
    expect(RUNTIME_SLASH_COMMANDS).toEqual([
      "/status",
      "/model",
      "/settings",
      "/tools",
    ]);
    expect(INTERACTIVE_SLASH_COMMANDS).toEqual([
      "/help",
      "/clear",
      "/exit",
      "/status",
      "/model",
      "/settings",
      "/tools",
    ]);
    expect(RUNTIME_SLASH_COMMAND_DESCRIPTORS.map(({ name }) => name)).toEqual(
      RUNTIME_SLASH_COMMANDS,
    );
  });
});
