import { redactSecrets } from "./permission-impact.js";
import type { SessionGoalCheckpoint, GoalHistoryEntry } from "./session.js";
import { SessionStore } from "./session.js";

const GOAL_CONTROL_COMMANDS = new Set([
  "",
  "status",
  "pause",
  "resume",
  "achieve",
  "clear",
]);

/** Rendering bound for the compact revision history (Issue #580). */
export const GOAL_HISTORY_RENDER_LIMIT = 10;

function safeObjective(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 499)}…`;
}

/**
 * Append-only history access for display (Issue #580). Real transitions always
 * append entries; a sidecar written before history tracking has no history
 * field, so a single `legacy` entry is synthesized for display from the
 * current goal — never written back unless a real transition occurs.
 */
export function goalHistoryForDisplay(checkpoint: SessionGoalCheckpoint): GoalHistoryEntry[] {
  if (checkpoint.history !== undefined) return checkpoint.history;
  if (!checkpoint.goal) return [];
  return [
    {
      revision: checkpoint.revision,
      kind: "legacy",
      objective: checkpoint.goal.objective,
      status: checkpoint.goal.status,
      at: checkpoint.goal.updatedAt,
    },
  ];
}

function appendTransition(
  current: SessionGoalCheckpoint,
  entry: GoalHistoryEntry,
): GoalHistoryEntry[] {
  // Prior entries are spread, never mutated (immutability). A legacy sidecar
  // contributes its synthesized entry exactly when this real transition occurs.
  return [...goalHistoryForDisplay(current), entry];
}

/**
 * Render compact newest-first history lines (Issue #580), bounded to
 * GOAL_HISTORY_RENDER_LIMIT with an elision count. Shared by `/goal status`
 * and the headless `--goal-status` surface. `currentRevision` marks the
 * active revision (a synthesized `legacy` entry is never marked current).
 */
export function formatGoalHistoryLines(
  history: readonly GoalHistoryEntry[],
  currentRevision: number,
): string[] {
  if (history.length === 0) return [];
  const lines = ["  history (newest first):"];
  const shown = [...history].reverse().slice(0, GOAL_HISTORY_RENDER_LIMIT);
  for (const entry of shown) {
    const objective = entry.objective === null ? "(cleared)" : entry.objective;
    const current =
      entry.revision === currentRevision && entry.kind !== "legacy" ? " (current)" : "";
    lines.push(
      `    rev ${entry.revision} · ${entry.kind} · ${objective} · ${new Date(entry.at).toISOString()}${current}`,
    );
  }
  const elided = history.length - shown.length;
  if (elided > 0) {
    lines.push(`    +${elided} earlier transition(s) not shown`);
  }
  return lines;
}

function formatGoal(checkpoint: SessionGoalCheckpoint): string {
  const historyLines = formatGoalHistoryLines(goalHistoryForDisplay(checkpoint), checkpoint.revision);
  if (!checkpoint.goal) {
    return [`Goal: none (revision ${checkpoint.revision})`, ...historyLines].join("\n");
  }
  return [
    `Goal: ${checkpoint.goal.status}`,
    `  objective: ${checkpoint.goal.objective}`,
    `  set: ${new Date(checkpoint.goal.createdAt).toISOString()}`,
    `  revision: ${checkpoint.revision}`,
    ...historyLines,
  ].join("\n");
}

export function runGoalCommand(
  store: SessionStore,
  sessionId: string,
  args: string,
  now: number = Date.now(),
): string {
  const input = args.trim();
  const current = store.readGoal(sessionId);
  if (!input || input === "status") return formatGoal(current);

  if (input === "pause") {
    if (!current.goal) return "Goal: nothing to pause";
    if (current.goal.status === "achieved") return formatGoal(current);
    if (current.goal.status === "paused") return formatGoal(current);
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: { ...current.goal, status: "paused", updatedAt: now },
      history: appendTransition(current, {
        revision: current.revision + 1,
        kind: "pause",
        objective: current.goal.objective,
        status: "paused",
        at: now,
      }),
    };
    store.writeGoal(sessionId, next);
    return `Goal paused (revision ${next.revision}): ${next.goal?.objective}`;
  }

  if (input === "resume") {
    if (!current.goal) return "Goal: nothing to resume";
    if (current.goal.status === "achieved") return formatGoal(current);
    if (current.goal.status === "active") return formatGoal(current);
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: { ...current.goal, status: "active", updatedAt: now },
      history: appendTransition(current, {
        revision: current.revision + 1,
        kind: "resume",
        objective: current.goal.objective,
        status: "active",
        at: now,
      }),
    };
    store.writeGoal(sessionId, next);
    return `Goal resumed (revision ${next.revision}): ${next.goal?.objective}`;
  }

  if (input === "clear") {
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: null,
      history: appendTransition(current, {
        revision: current.revision + 1,
        kind: "clear",
        objective: null,
        status: null,
        at: now,
      }),
    };
    store.writeGoal(sessionId, next);
    return `Goal cleared (revision ${next.revision})`;
  }

  if (input === "achieve") {
    if (!current.goal) return "Goal: nothing to achieve";
    if (current.goal.status === "achieved") return formatGoal(current);
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: { ...current.goal, status: "achieved", updatedAt: now },
      history: appendTransition(current, {
        revision: current.revision + 1,
        kind: "achieve",
        objective: current.goal.objective,
        status: "achieved",
        at: now,
      }),
    };
    store.writeGoal(sessionId, next);
    return `Goal achieved (revision ${next.revision}): ${next.goal?.objective}`;
  }

  const objective = safeObjective(input);
  if (!objective) {
    return "Usage: /goal <objective> | status | pause | resume | achieve | clear";
  }
  const next: SessionGoalCheckpoint = {
    revision: current.revision + 1,
    goal: { objective, status: "active", createdAt: now, updatedAt: now },
    history: appendTransition(current, {
      revision: current.revision + 1,
      kind: "set",
      objective,
      status: "active",
      at: now,
    }),
  };
  store.writeGoal(sessionId, next);
  return `Goal set (revision ${next.revision}): ${objective}`;
}

export function isGoalRevisionCurrent(
  store: SessionStore,
  sessionId: string,
  revision: number,
): boolean {
  const checkpoint = store.readGoal(sessionId);
  return checkpoint.revision === revision && checkpoint.goal?.status === "active";
}

export function goalExecutionRequest(
  args: string,
  checkpoint: SessionGoalCheckpoint,
): { prompt: string; revision: number } | null {
  if (GOAL_CONTROL_COMMANDS.has(args.trim())) return null;
  if (checkpoint.goal?.status !== "active") return null;
  return {
    prompt: checkpoint.goal.objective,
    revision: checkpoint.revision,
  };
}

export function settleGoalExecution(
  store: SessionStore,
  sessionId: string,
  revision: number,
  succeeded: boolean,
  now: number = Date.now(),
): string | null {
  if (!succeeded) return null;
  if (!isGoalRevisionCurrent(store, sessionId, revision)) return null;
  return runGoalCommand(store, sessionId, "achieve", now);
}
