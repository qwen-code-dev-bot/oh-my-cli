import { redactSecrets } from "./permission-impact.js";

export type SlashCommandResolution =
  | { kind: "prompt" }
  | { kind: "command"; name: string; args: string }
  | { kind: "unknown"; input: string; message: string };

export const FOUNDATIONAL_SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/exit",
] as const;

export const RUNTIME_SLASH_COMMAND_DESCRIPTORS = [
  { name: "/status", description: "Show current session and workspace info" },
  { name: "/model", description: "Show the active model and configuration path" },
  { name: "/settings", description: "Show the redacted settings path" },
  { name: "/tools", description: "List available agent tools" },
] as const;

export const RUNTIME_SLASH_COMMANDS = RUNTIME_SLASH_COMMAND_DESCRIPTORS.map(
  ({ name }) => name,
);

export const INTERACTIVE_SLASH_COMMANDS = [
  ...FOUNDATIONAL_SLASH_COMMANDS,
  ...RUNTIME_SLASH_COMMANDS,
] as const;

export interface RuntimeSlashContext {
  model: string;
  workspace: string;
  approvalMode: string;
  sessionId: string;
  settingsPath: string;
  tools: readonly string[];
  home?: string;
}

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

  const separator = trimmed.search(/\s/);
  const token = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const name = ALIASES[token] ?? token;
  const args = separator === -1 ? "" : trimmed.slice(separator).trim();
  if (commandNames.includes(name)) return { kind: "command", name, args };

  return {
    kind: "unknown",
    input: trimmed,
    message: `Unknown command ${trimmed}. Type / to browse commands.`,
  };
}

export function formatSlashCommandHelp(
  commandNames: readonly string[],
): string {
  return `Commands: ${commandNames.join(" · ")}`;
}

function safeValue(value: string): string {
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(flattened).text;
  return redacted.length <= 160 ? redacted : `${redacted.slice(0, 159)}…`;
}

function displayPath(value: string, home?: string): string {
  const resolvedHome = home ?? process.env.HOME ?? process.env.USERPROFILE;
  const isHomePath = resolvedHome && (
    value === resolvedHome ||
    value.startsWith(`${resolvedHome}/`) ||
    value.startsWith(`${resolvedHome}\\`)
  );
  const collapsed = isHomePath
    ? `~${value.slice(resolvedHome.length)}`
    : value;
  return safeValue(collapsed);
}

export function formatRuntimeSlashCommand(
  name: string,
  context: RuntimeSlashContext,
): string | null {
  if (name === "/status") {
    return [
      "Status",
      `  model: ${safeValue(context.model)}`,
      `  workspace: ${displayPath(context.workspace, context.home)}`,
      `  approval: ${safeValue(context.approvalMode)}`,
      `  session: ${safeValue(context.sessionId)}`,
    ].join("\n");
  }
  if (name === "/model") {
    return [
      "Model",
      `  active: ${safeValue(context.model)}`,
      `  settings: ${displayPath(context.settingsPath, context.home)}`,
    ].join("\n");
  }
  if (name === "/settings") {
    return `Settings: ${displayPath(context.settingsPath, context.home)}`;
  }
  if (name === "/tools") {
    const visible = context.tools.slice(0, 16).map(safeValue);
    const overflow = context.tools.length - visible.length;
    const suffix = overflow > 0 ? ` · … +${overflow} more` : "";
    return `Tools (${context.tools.length}): ${visible.join(" · ")}${suffix}`;
  }
  return null;
}
