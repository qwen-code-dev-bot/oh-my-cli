export type SlashCommandResolution =
  | { kind: "prompt" }
  | { kind: "command"; name: string }
  | { kind: "unknown"; input: string; message: string };

export const FOUNDATIONAL_SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/exit",
] as const;

const ALIASES: Readonly<Record<string, string>> = {
  "/?": "/help",
  "/quit": "/exit",
};

export function resolveSlashCommand(
  input: string,
  commandNames: readonly string[],
): SlashCommandResolution {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt" };

  const name = ALIASES[trimmed] ?? trimmed;
  if (commandNames.includes(name)) return { kind: "command", name };

  return {
    kind: "unknown",
    input: trimmed,
    message: `Unknown command ${trimmed}. Use /help or Ctrl+K to browse commands.`,
  };
}

export function formatSlashCommandHelp(
  commandNames: readonly string[],
): string {
  return `Commands: ${commandNames.join(" · ")}`;
}
