// Goal revision history: preserves prior Goal revisions when an active
// Goal is edited, and provides inspection of the revision trail.
//
// Each revision entry preserves the objective, revision number, status,
// and timestamps. The active revision is clearly identified. Objectives
// are bounded and redacted. The model complements the existing
// session-goal.ts without changing its JSON contract.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_REVISION_SCHEMA = "oh-my-cli.goal-revision";
export const GOAL_REVISION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type GoalStatus = "active" | "paused" | "achieved";

export interface GoalRevisionEntry {
  /** Monotonic revision number. */
  revision: number;
  /** Optional concise title (max 80 chars, bounded and redacted). */
  title?: string;
  /** The objective text (bounded and redacted). */
  objective: string;
  status: GoalStatus;
  /** Epoch ms when this revision was created. */
  createdAt: number;
  /** Epoch ms when this revision was last updated. */
  updatedAt: number;
  /** Whether this is the currently active revision. */
  isActive: boolean;
}

// --- objective safety -------------------------------------------------------

const MAX_OBJECTIVE_LENGTH = 500;

export function safeObjective(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_OBJECTIVE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_OBJECTIVE_LENGTH - 1)}…`;
}

// --- title safety -----------------------------------------------------------

const MAX_TITLE_LENGTH = 80;

// Sanitize and bound a Goal title (max 80 chars, redacted).
export function safeTitle(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_TITLE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

// Auto-derive a concise title from the objective (first 80 chars).
export function deriveTitle(objective: string): string {
  return safeTitle(objective);
}

// --- revision history -------------------------------------------------------

const MAX_REVISIONS = 50;

export class GoalRevisionHistory {
  private readonly revisions: GoalRevisionEntry[] = [];
  private currentRevision = 0;

  /** Set a new objective, creating a new revision and preserving prior ones.
   *  An optional title can be provided; otherwise it is auto-derived from
   *  the first 80 characters of the objective. */
  setObjective(objective: string, now: number = Date.now(), title?: string): GoalRevisionEntry {
    // Deactivate the current active revision.
    for (const rev of this.revisions) {
      rev.isActive = false;
    }

    this.currentRevision++;
    const safe = safeObjective(objective);
    const safeTitleValue = title !== undefined ? safeTitle(title) : deriveTitle(safe);
    const entry: GoalRevisionEntry = {
      revision: this.currentRevision,
      title: safeTitleValue,
      objective: safe,
      status: "active",
      createdAt: now,
      updatedAt: now,
      isActive: true,
    };

    this.revisions.push(entry);
    if (this.revisions.length > MAX_REVISIONS) {
      this.revisions.shift();
    }

    return entry;
  }

  /** Set or update the title of the active revision. */
  setTitle(title: string, now: number = Date.now()): GoalRevisionEntry | null {
    const active = this.getActive();
    if (!active) return null;

    active.title = safeTitle(title);
    active.updatedAt = now;
    return active;
  }

  /** Update the status of the active revision (pause/resume/achieve). */
  updateStatus(status: GoalStatus, now: number = Date.now()): GoalRevisionEntry | null {
    const active = this.getActive();
    if (!active) return null;

    active.status = status;
    active.updatedAt = now;
    return active;
  }

  /** Get the active revision. */
  getActive(): GoalRevisionEntry | null {
    return this.revisions.find((r) => r.isActive) ?? null;
  }

  /** Get a specific revision by number. */
  getRevision(revision: number): GoalRevisionEntry | null {
    return this.revisions.find((r) => r.revision === revision) ?? null;
  }

  /** Get all revisions in order. */
  list(): GoalRevisionEntry[] {
    return [...this.revisions];
  }

  /** Get the current revision number. */
  get revision(): number {
    return this.currentRevision;
  }

  get size(): number {
    return this.revisions.length;
  }
}

// --- formatting -------------------------------------------------------------

// Format the active Goal status (compatible with existing formatGoal).
export function formatGoalStatus(history: GoalRevisionHistory): string {
  const active = history.getActive();
  if (!active) return `Goal: none (revision ${history.revision})`;

  const lines = [
    `Goal: ${active.status}`,
  ];
  if (active.title) {
    lines.push(`  title: ${active.title}`);
  }
  lines.push(
    `  objective: ${active.objective}`,
    `  set: ${new Date(active.createdAt).toISOString()}`,
    `  updated: ${new Date(active.updatedAt).toISOString()}`,
    `  revision: ${active.revision}`,
    `  history: ${history.size} revision(s)`,
  );
  return lines.join("\n");
}

// Format the full revision history with the active revision identified.
export function formatRevisionHistory(history: GoalRevisionHistory): string {
  const lines: string[] = [];
  lines.push("Goal Revision History");
  lines.push("═".repeat(50));
  lines.push(`Revisions: ${history.size}  Current: ${history.revision}`);

  for (const rev of history.list()) {
    const icon = rev.isActive ? "●" : "○";
    const statusGlyph = statusGlyphFor(rev.status);
    const titlePart = rev.title ? `${rev.title} — ` : "";
    lines.push(`${icon} rev ${rev.revision} [${rev.status}] ${statusGlyph} ${titlePart}${rev.objective}`);
    lines.push(`  set: ${new Date(rev.createdAt).toISOString()}  updated: ${new Date(rev.updatedAt).toISOString()}`);
  }

  lines.push("");
  lines.push("Read-only: no Goal state modified.");

  return lines.join("\n");
}

function statusGlyphFor(status: GoalStatus): string {
  switch (status) {
    case "active": return "▶";
    case "paused": return "‖";
    case "achieved": return "✓";
  }
}
