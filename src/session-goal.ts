import { redactSecrets } from "./permission-impact.js";
import type { SessionGoalCheckpoint } from "./session.js";
import { SessionStore } from "./session.js";

function safeObjective(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 499)}…`;
}

function formatGoal(checkpoint: SessionGoalCheckpoint): string {
  if (!checkpoint.goal) return `Goal: none (revision ${checkpoint.revision})`;
  return [
    `Goal: ${checkpoint.goal.status}`,
    `  objective: ${checkpoint.goal.objective}`,
    `  set: ${new Date(checkpoint.goal.createdAt).toISOString()}`,
    `  revision: ${checkpoint.revision}`,
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
    if (current.goal.status === "paused") return formatGoal(current);
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: { ...current.goal, status: "paused", updatedAt: now },
    };
    store.writeGoal(sessionId, next);
    return `Goal paused (revision ${next.revision}): ${next.goal?.objective}`;
  }

  if (input === "resume") {
    if (!current.goal) return "Goal: nothing to resume";
    if (current.goal.status === "active") return formatGoal(current);
    const next: SessionGoalCheckpoint = {
      revision: current.revision + 1,
      goal: { ...current.goal, status: "active", updatedAt: now },
    };
    store.writeGoal(sessionId, next);
    return `Goal resumed (revision ${next.revision}): ${next.goal?.objective}`;
  }

  if (input === "clear") {
    const next = { revision: current.revision + 1, goal: null };
    store.writeGoal(sessionId, next);
    return `Goal cleared (revision ${next.revision})`;
  }

  const objective = safeObjective(input);
  if (!objective) return "Usage: /goal <objective> | status | pause | resume | clear";
  const next: SessionGoalCheckpoint = {
    revision: current.revision + 1,
    goal: { objective, status: "active", createdAt: now, updatedAt: now },
  };
  store.writeGoal(sessionId, next);
  return `Goal active (revision ${next.revision}): ${objective}`;
}

export function isGoalRevisionCurrent(
  store: SessionStore,
  sessionId: string,
  revision: number,
): boolean {
  const checkpoint = store.readGoal(sessionId);
  return checkpoint.revision === revision && checkpoint.goal?.status === "active";
}
