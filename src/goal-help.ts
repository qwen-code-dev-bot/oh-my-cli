// Deterministic command help and completion for every Goal lifecycle action.
//
// Defines a GoalCommandMeta registry for all Goal lifecycle commands with
// name, syntax, description, required state, effects, and terminal-state
// awareness. formatGoalHelp renders deterministic help output.
// getGoalCompletions returns state-aware completion candidates.
// Help and completions are deterministic (same input → same output).

import type { GoalStatus } from "./goal-revision.js";
import { isTerminalState } from "./goal-revision.js";

export const GOAL_HELP_SCHEMA = "oh-my-cli.goal-help";
export const GOAL_HELP_VERSION = 1;

// --- command metadata -------------------------------------------------------

export interface GoalCommandMeta {
  /** Command name (e.g., "set", "pause"). */
  name: string;
  /** Usage syntax. */
  syntax: string;
  /** What the command does. */
  description: string;
  /** Required Goal state for this command to be valid (null = any state). */
  requiredState: GoalStatus | null;
  /** Whether this command is available when the Goal is in a terminal state. */
  availableInTerminal: boolean;
  /** What state the Goal transitions to after this command. */
  resultState: GoalStatus | null;
}

// --- command registry -------------------------------------------------------

export const GOAL_COMMANDS: readonly GoalCommandMeta[] = [
  {
    name: "set",
    syntax: "/goal <objective>",
    description: "Set a new Goal objective. Creates a new revision and preserves prior history.",
    requiredState: null,
    availableInTerminal: true,
    resultState: "active",
  },
  {
    name: "status",
    syntax: "/goal status",
    description: "Show the current Goal status, objective, title, revision, and transition info.",
    requiredState: null,
    availableInTerminal: true,
    resultState: null,
  },
  {
    name: "title",
    syntax: "/goal title <text>",
    description: "Set or update the concise Goal title (max 80 chars).",
    requiredState: null,
    availableInTerminal: false,
    resultState: null,
  },
  {
    name: "pause",
    syntax: "/goal pause",
    description: "Pause the active Goal. Records actor and reason.",
    requiredState: "active",
    availableInTerminal: false,
    resultState: "paused",
  },
  {
    name: "resume",
    syntax: "/goal resume",
    description: "Resume a paused Goal. Records actor and reason.",
    requiredState: "paused",
    availableInTerminal: false,
    resultState: "active",
  },
  {
    name: "achieve",
    syntax: "/goal achieve",
    description: "Mark the Goal as achieved (terminal). Records actor and reason.",
    requiredState: null,
    availableInTerminal: false,
    resultState: "achieved",
  },
  {
    name: "fail",
    syntax: "/goal fail",
    description: "Mark the Goal as failed (terminal). Records actor and reason.",
    requiredState: null,
    availableInTerminal: false,
    resultState: "failed",
  },
  {
    name: "cancel",
    syntax: "/goal cancel",
    description: "Cancel the Goal (terminal). Records actor and reason.",
    requiredState: null,
    availableInTerminal: false,
    resultState: "cancelled",
  },
  {
    name: "supersede",
    syntax: "/goal supersede",
    description: "Mark the Goal as superseded by a new Goal (terminal).",
    requiredState: null,
    availableInTerminal: false,
    resultState: "superseded",
  },
  {
    name: "clear",
    syntax: "/goal clear",
    description: "Clear the Goal entirely. Creates a new empty revision.",
    requiredState: null,
    availableInTerminal: true,
    resultState: null,
  },
];

// --- help formatting --------------------------------------------------------

// Render deterministic help output from the command registry.
export function formatGoalHelp(currentState?: GoalStatus): string {
  const lines: string[] = [];
  lines.push("Goal Commands");
  lines.push("═".repeat(50));

  for (const cmd of GOAL_COMMANDS) {
    const available = isCommandAvailable(cmd, currentState);
    const marker = available ? " " : "·";
    const stateNote = cmd.requiredState ? ` (requires ${cmd.requiredState})` : "";
    const terminalNote = !cmd.availableInTerminal ? " [not in terminal]" : "";
    lines.push(`${marker} ${cmd.syntax}`);
    lines.push(`    ${cmd.description}${stateNote}${terminalNote}`);
  }

  lines.push("");
  lines.push("· = not available in current state");

  return lines.join("\n");
}

// --- completions ------------------------------------------------------------

export interface GoalCompletion {
  /** The completion text. */
  text: string;
  /** The command metadata. */
  command: GoalCommandMeta;
  /** Whether this completion is available in the current state. */
  available: boolean;
}

// Check if a command is available given the current Goal state.
export function isCommandAvailable(cmd: GoalCommandMeta, currentState?: GoalStatus): boolean {
  // If no Goal exists, only set/status/clear are available.
  if (currentState === undefined) {
    return cmd.name === "set" || cmd.name === "status" || cmd.name === "clear";
  }

  // Terminal state: only commands marked availableInTerminal.
  if (isTerminalState(currentState)) {
    return cmd.availableInTerminal;
  }

  // Check required state.
  if (cmd.requiredState !== null && cmd.requiredState !== currentState) {
    return false;
  }

  return true;
}

// Get state-aware completion candidates.
export function getGoalCompletions(currentState?: GoalStatus): GoalCompletion[] {
  return GOAL_COMMANDS.map((cmd) => ({
    text: cmd.syntax,
    command: cmd,
    available: isCommandAvailable(cmd, currentState),
  }));
}

// Get only available completions.
export function getAvailableCompletions(currentState?: GoalStatus): GoalCompletion[] {
  return getGoalCompletions(currentState).filter((c) => c.available);
}
