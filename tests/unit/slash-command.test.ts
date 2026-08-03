import { describe, expect, it } from "vitest";
import {
  FOUNDATIONAL_SLASH_COMMANDS,
  INTERACTIVE_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMANDS,
  RUNTIME_SLASH_COMMAND_DESCRIPTORS,
  STREAMING_SAFE_SLASH_COMMANDS,
  busySubmitDecision,
  formatRuntimeSlashCommand,
  formatSlashCommandHelp,
  isStreamingSafeSlashCommand,
  resolveSlashCommand,
} from "../../src/slash-command.js";

const commands = ["/help", "/clear", "/exit"] as const;

describe("resolveSlashCommand", () => {
  it("resolves an exact command after trimming whitespace", () => {
    expect(resolveSlashCommand("  /clear  ", commands)).toEqual({
      kind: "command",
      name: "/clear",
      args: "",
    });
  });

  it("normalizes foundational aliases", () => {
    expect(resolveSlashCommand("/?", commands)).toEqual({
      kind: "command",
      name: "/help",
      args: "",
    });
    expect(resolveSlashCommand("/quit", commands)).toEqual({
      kind: "command",
      name: "/exit",
      args: "",
    });
  });

  it("keeps unknown slash input local and actionable", () => {
    expect(resolveSlashCommand("/wat", commands)).toEqual({
      kind: "unknown",
      input: "/wat",
      message: "Unknown command /wat. Type / to browse commands.",
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

  it("returns command arguments without treating them as part of the name", () => {
    expect(resolveSlashCommand("/clear now please", commands)).toEqual({
      kind: "command",
      name: "/clear",
      args: "now please",
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
      "/capabilities",
      "/continuity",
    ]);
    expect(INTERACTIVE_SLASH_COMMANDS).toEqual([
      "/help",
      "/clear",
      "/exit",
      "/status",
      "/model",
      "/settings",
      "/tools",
      "/capabilities",
      "/continuity",
    ]);
    expect(RUNTIME_SLASH_COMMAND_DESCRIPTORS.map(({ name }) => name)).toEqual(
      RUNTIME_SLASH_COMMANDS,
    );
  });
});

// Issue #511: a bounded read-only allowlist may run while a turn is in flight.
const paletteNames = [
  ...INTERACTIVE_SLASH_COMMANDS,
  "/attach",
  "/ask",
  "/goal",
  "/stats",
];

describe("streaming-safe allowlist", () => {
  it("contains exactly the read-only runtime commands plus /help", () => {
    expect(STREAMING_SAFE_SLASH_COMMANDS).toEqual([
      "/status",
      "/model",
      "/settings",
      "/tools",
      "/capabilities",
      "/continuity",
      "/help",
    ]);
  });

  it("admits allowlisted commands and rejects mutating or queuing ones", () => {
    for (const name of STREAMING_SAFE_SLASH_COMMANDS) {
      expect(isStreamingSafeSlashCommand(name)).toBe(true);
    }
    for (const name of ["/clear", "/exit", "/attach", "/ask", "/goal", "/stats", "/new"]) {
      expect(isStreamingSafeSlashCommand(name)).toBe(false);
    }
  });
});

describe("busySubmitDecision", () => {
  function decide(text: string) {
    return busySubmitDecision(text, resolveSlashCommand(text, paletteNames));
  }

  it("runs allowlisted commands immediately, with arguments", () => {
    expect(decide("/status")).toEqual({ kind: "run-command", name: "/status", args: "" });
    expect(decide("  /model  ")).toEqual({ kind: "run-command", name: "/model", args: "" });
  });

  it("runs the /? alias as /help mid-stream", () => {
    expect(decide("/?")).toEqual({ kind: "run-command", name: "/help", args: "" });
  });

  it("rejects prompts without touching the turn", () => {
    expect(decide("explain this file")).toEqual({ kind: "rejected" });
    expect(decide("use /help in the docs")).toEqual({ kind: "rejected" });
  });

  it("runs an allowlisted command even when it carries extra words", () => {
    expect(decide("/status please")).toEqual({
      kind: "run-command",
      name: "/status",
      args: "please",
    });
  });

  it("rejects non-allowlisted commands, including /clear and /exit", () => {
    expect(decide("/clear")).toEqual({ kind: "rejected" });
    expect(decide("/exit")).toEqual({ kind: "rejected" });
    expect(decide("/quit")).toEqual({ kind: "rejected" });
    expect(decide("/goal status")).toEqual({ kind: "rejected" });
    expect(decide("/attach img.png")).toEqual({ kind: "rejected" });
    expect(decide("/wat")).toEqual({ kind: "rejected" });
  });

  it("ignores empty or whitespace-only input silently", () => {
    expect(decide("")).toEqual({ kind: "ignored" });
    expect(decide("   \n ")).toEqual({ kind: "ignored" });
  });
});
