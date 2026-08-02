// Goal constraints: allows users to append constraints or clarifications
// to an active Goal without replacing the objective.
//
// Constraints are bounded (max 20 per Goal), redacted, and deterministic.
// They are preserved across revisions (carried forward). Read-only model
// layer (append-only in first slice).

import { redactSecrets } from "./permission-impact.js";

export const GOAL_CONSTRAINTS_SCHEMA = "oh-my-cli.goal-constraints";
export const GOAL_CONSTRAINTS_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface GoalConstraint {
  /** Constraint text (bounded, redacted). */
  text: string;
  /** Who added the constraint. */
  addedBy: string;
  /** When the constraint was added (epoch ms). */
  addedAt: number;
  /** Goal revision when the constraint was added. */
  revision: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_CONSTRAINTS = 20;
const MAX_CONSTRAINT_LENGTH = 300;

function safeConstraint(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_CONSTRAINT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_CONSTRAINT_LENGTH - 1)}…`;
}

// --- constraint tracker -----------------------------------------------------

export class GoalConstraintTracker {
  private readonly constraints: GoalConstraint[] = [];

  /** Append a constraint to the active Goal. */
  addConstraint(
    text: string,
    addedBy: string,
    revision: number,
    addedAt: number = Date.now(),
  ): GoalConstraint | null {
    if (this.constraints.length >= MAX_CONSTRAINTS) {
      return null; // At capacity.
    }

    const constraint: GoalConstraint = {
      text: safeConstraint(text),
      addedBy,
      addedAt,
      revision,
    };

    this.constraints.push(constraint);
    return { ...constraint };
  }

  /** Get all constraints. */
  getConstraints(): GoalConstraint[] {
    return this.constraints.map((c) => ({ ...c }));
  }

  /** Get constraints for a specific revision. */
  getConstraintsForRevision(revision: number): GoalConstraint[] {
    return this.constraints
      .filter((c) => c.revision === revision)
      .map((c) => ({ ...c }));
  }

  /** Number of constraints. */
  get size(): number {
    return this.constraints.length;
  }

  /** Whether the tracker is at capacity. */
  get isFull(): boolean {
    return this.constraints.length >= MAX_CONSTRAINTS;
  }
}

// --- formatting -------------------------------------------------------------

export function formatConstraints(tracker: GoalConstraintTracker): string {
  const constraints = tracker.getConstraints();
  const lines: string[] = [];

  lines.push(`Goal Constraints (${constraints.length}/${MAX_CONSTRAINTS})`);
  lines.push("─".repeat(40));

  for (const constraint of constraints) {
    lines.push(`  · ${constraint.text}`);
    lines.push(`    by ${constraint.addedBy} at rev ${constraint.revision}`);
  }

  if (tracker.isFull) {
    lines.push("  ⚠ At capacity (max 20 constraints)");
  }

  return lines.join("\n");
}
