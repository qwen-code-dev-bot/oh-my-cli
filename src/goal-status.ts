// Headless read-only Goal inspection (Issue #578, roadmap #270 section 10's
// inspection leg; revision history added by Issue #580). A session's durable
// Goal — objective, status, revision, timestamps, and the append-only
// transition history — was only reachable through the TUI `/goal` command;
// this surface renders the exact checkpoint state, redacted, for automation
// and cross-session auditing. Strictly read-only: it reads the goal sidecar
// and nothing else, writes nothing, and grants no control authority (machine
// create/pause/resume/cancel remain later #270 children). A corrupt or absent
// sidecar behaves exactly as store.readGoal does today — the honest no-goal
// state — and corrupt bytes are preserved, never overwritten.

import { redactSecrets } from "./permission-impact.js";
import type { SessionStore, GoalHistoryEntry } from "./session.js";
import { goalHistoryForDisplay, formatGoalHistoryLines, GOAL_HISTORY_RENDER_LIMIT } from "./session-goal.js";
import { formatSessionAge } from "./session-summary.js";

export const GOAL_STATUS_SCHEMA = "oh-my-cli.goal-status" as const;
export const GOAL_STATUS_VERSION = 1 as const;

export interface GoalHistoryView {
  revision: number;
  kind: GoalHistoryEntry["kind"];
  /** Redacted objective at this transition, or null for clear. */
  objective: string | null;
  status: GoalHistoryEntry["status"];
  at: string;
}

export interface GoalStatusView {
  status: "active" | "paused" | "achieved";
  /** Optional concise title (Issue #586), redacted. */
  title?: string;
  /** Redacted objective text. */
  objective: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface GoalStatusRecord {
  schema: typeof GOAL_STATUS_SCHEMA;
  v: typeof GOAL_STATUS_VERSION;
  sessionId: string;
  hasGoal: boolean;
  goal: GoalStatusView | null;
  /** Bounded transition history, newest first. */
  history: GoalHistoryView[];
  /** Count of history entries elided by the rendering bound. */
  elidedHistory: number;
}

function historyView(entries: readonly GoalHistoryEntry[]): {
  history: GoalHistoryView[];
  elided: number;
} {
  const newestFirst = [...entries].reverse();
  const shown = newestFirst.slice(0, GOAL_HISTORY_RENDER_LIMIT);
  return {
    history: shown.map((entry) => ({
      revision: entry.revision,
      kind: entry.kind,
      // Defense in depth: objectives are sanitized at write time; re-redact
      // at render so hand-edited sidecars never leak a secret.
      objective: entry.objective === null ? null : redactSecrets(entry.objective).text,
      status: entry.status,
      at: new Date(entry.at).toISOString(),
    })),
    elided: Math.max(0, newestFirst.length - GOAL_HISTORY_RENDER_LIMIT),
  };
}

export function buildGoalStatusRecord(store: SessionStore, sessionId: string): GoalStatusRecord {
  const checkpoint = store.readGoal(sessionId);
  const { history, elided } = historyView(goalHistoryForDisplay(checkpoint));
  if (!checkpoint.goal) {
    return {
      schema: GOAL_STATUS_SCHEMA,
      v: GOAL_STATUS_VERSION,
      sessionId,
      hasGoal: false,
      goal: null,
      history,
      elidedHistory: elided,
    };
  }
  const goal = checkpoint.goal;
  return {
    schema: GOAL_STATUS_SCHEMA,
    v: GOAL_STATUS_VERSION,
    sessionId,
    hasGoal: true,
    goal: {
      status: goal.status,
      // Title is sanitized at write time (safeTitle); re-redact at render
      // like the objective (Issue #586).
      ...(goal.title !== undefined ? { title: redactSecrets(goal.title).text } : {}),
      // Defense in depth: objectives are sanitized at write time (safeObjective);
      // re-redact at render so a hand-edited sidecar never leaks a secret.
      objective: redactSecrets(goal.objective).text,
      createdAt: new Date(goal.createdAt).toISOString(),
      updatedAt: new Date(goal.updatedAt).toISOString(),
      revision: checkpoint.revision,
    },
    history,
    elidedHistory: elided,
  };
}

export function formatGoalStatus(record: GoalStatusRecord): string[] {
  const lines: string[] = [];
  lines.push(`Goal status — session ${record.sessionId.slice(0, 8)}`);
  lines.push("─".repeat(40));
  lines.push("");
  if (!record.goal) {
    lines.push("No goal recorded for this session.");
  } else {
    const g = record.goal;
    lines.push(`status:    ${g.status}`);
    if (g.title !== undefined) lines.push(`title:     ${g.title}`);
    lines.push(`objective: ${g.objective}`);
    lines.push(`set:       ${g.createdAt}`);
    lines.push(`updated:   ${g.updatedAt}`);
    lines.push(`revision:  ${g.revision}`);
  }
  if (record.history.length > 0) {
    const historyEntries: GoalHistoryEntry[] = record.history.map((h) => ({
      revision: h.revision,
      kind: h.kind,
      objective: h.objective,
      status: h.status,
      at: Date.parse(h.at),
    }));
    lines.push(...formatGoalHistoryLines(historyEntries, record.goal?.revision ?? -1));
    if (record.elidedHistory > 0) {
      lines.push(`+${record.elidedHistory} earlier transition(s) not shown`);
    }
  }
  return lines;
}

/**
 * Immediate Goal status summary for session resume (Issue #584). Returns one
 * bounded line when the session carries a durable goal, or null when it does
 * not (absence is silent, not an error). Derived read-only via readGoal, so a
 * corrupt sidecar behaves exactly as readGoal does today (null, bytes
 * preserved); the summary never mutates goal state. The objective is
 * re-redacted at render time and bounded by the write-time safeObjective cap.
 */
export function resumeGoalSummaryLine(
  store: SessionStore,
  sessionId: string,
  now: number = Date.now(),
): string | null {
  const checkpoint = store.readGoal(sessionId);
  if (!checkpoint.goal) return null;
  const goal = checkpoint.goal;
  const objective = redactSecrets(goal.objective).text;
  const age = formatSessionAge(Math.max(0, now - goal.updatedAt));
  // Title-first when present (Issue #586) so compact surfaces scan easily;
  // re-redact at render in case the sidecar was hand-edited.
  const label =
    goal.title !== undefined ? `${goal.status} (${redactSecrets(goal.title).text})` : goal.status;
  return `Goal: ${label} · ${objective} · rev ${checkpoint.revision} · updated ${age}`;
}
