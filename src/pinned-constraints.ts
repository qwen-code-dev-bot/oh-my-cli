// Pinned constraints: critical user constraints that survive context
// compaction during long-running Goal execution.
//
// Extends the GoalConstraint model with a pinned flag. Pinned constraints
// are always included in the agent's context, preventing the agent from
// forgetting critical user requirements. Bounded (max 10), redacted,
// and deterministic.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const PINNED_CONSTRAINTS_SCHEMA = "oh-my-cli.pinned-constraints";
export const PINNED_CONSTRAINTS_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface PinnedConstraint {
  /** Constraint text (bounded, redacted). */
  text: string;
  /** Who added the constraint. */
  addedBy: string;
  /** When the constraint was added (epoch ms). */
  addedAt: number;
  /** Goal revision when the constraint was added. */
  revision: number;
  /** Whether the constraint is pinned (survives compaction). */
  pinned: boolean;
  /** When the constraint was pinned (epoch ms). */
  pinnedAt?: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_PINNED = 10;
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
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_CONSTRAINT_LENGTH - 1))}…`;
}

// --- pinned constraint tracker ----------------------------------------------

export class PinnedConstraintTracker {
  private readonly constraints: PinnedConstraint[] = [];

  /** Add a constraint (initially unpinned). */
  addConstraint(
    text: string,
    addedBy: string,
    revision: number,
    addedAt: number = Date.now(),
  ): PinnedConstraint {
    const constraint: PinnedConstraint = {
      text: safeConstraint(text),
      addedBy,
      addedAt,
      revision,
      pinned: false,
    };
    this.constraints.push(constraint);
    return { ...constraint };
  }

  /** Pin a constraint (mark as surviving compaction). */
  pinConstraint(index: number, pinnedAt: number = Date.now()): PinnedConstraint | null {
    if (index < 0 || index >= this.constraints.length) return null;

    const pinnedCount = this.constraints.filter((c) => c.pinned).length;
    if (pinnedCount >= MAX_PINNED) return null; // At capacity.

    const constraint = this.constraints[index];
    constraint.pinned = true;
    constraint.pinnedAt = pinnedAt;
    return { ...constraint };
  }

  /** Unpin a constraint. */
  unpinConstraint(index: number): PinnedConstraint | null {
    if (index < 0 || index >= this.constraints.length) return null;

    const constraint = this.constraints[index];
    constraint.pinned = false;
    constraint.pinnedAt = undefined;
    return { ...constraint };
  }

  /** Get all pinned constraints. */
  getPinnedConstraints(): PinnedConstraint[] {
    return this.constraints
      .filter((c) => c.pinned)
      .map((c) => ({ ...c }));
  }

  /** Get all constraints (pinned and unpinned). */
  getAllConstraints(): PinnedConstraint[] {
    return this.constraints.map((c) => ({ ...c }));
  }

  /** Number of pinned constraints. */
  get pinnedCount(): number {
    return this.constraints.filter((c) => c.pinned).length;
  }

  /** Total number of constraints. */
  get size(): number {
    return this.constraints.length;
  }

  /** Whether the pinned count is at capacity. */
  get isPinnedFull(): boolean {
    return this.pinnedCount >= MAX_PINNED;
  }
}

// --- formatting -------------------------------------------------------------

export function formatPinnedConstraints(tracker: PinnedConstraintTracker): string {
  const all = tracker.getAllConstraints();
  const pinned = tracker.getPinnedConstraints();
  const lines: string[] = [];

  lines.push(`Goal Constraints (${all.length} total, ${pinned.length} pinned/${MAX_PINNED} max)`);
  lines.push("─".repeat(40));

  for (const constraint of all) {
    const pin = constraint.pinned ? "📌" : "  ";
    lines.push(`${pin} ${constraint.text}`);
    lines.push(`    by ${constraint.addedBy} at rev ${constraint.revision}`);
  }

  if (tracker.isPinnedFull) {
    lines.push("  ⚠ Pinned at capacity (max 10)");
  }

  return lines.join("\n");
}
