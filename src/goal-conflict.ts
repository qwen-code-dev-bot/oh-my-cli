// Goal workspace conflict controls: at most one Goal may hold the mutation
// lock for a workspace at a time.
//
// With multiple Goals per session, two Goals can target the same workspace at
// once. Without conflict controls, one Goal's file changes can be clobbered
// by the other and neither Goal's evidence stays attributable. This model
// governs workspace mutation with explicit locks: a second Goal's attempt is
// refused with an actionable reason naming the holder, the holder can
// release, and the lock state renders deterministically. The model is pure:
// every operation returns new state, never mutates its inputs, and never
// touches persistence.

export const GOAL_CONFLICT_SCHEMA = "oh-my-cli.goal-conflict";
export const GOAL_CONFLICT_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface WorkspaceMutationLock {
  /** Opaque workspace identifier. */
  workspaceId: string;
  /** The Goal holding the mutation lock. */
  goalId: string;
  /** When the lock was acquired (epoch ms). */
  acquiredAt: number;
}

export interface GoalConflictState {
  locks: WorkspaceMutationLock[];
}

export type MutationLockResult =
  | { ok: true; state: GoalConflictState }
  | { ok: false; state: GoalConflictState; reason: string };

export interface GoalConflictLockView {
  workspaceId: string;
  goalId: string;
  /** How long the lock has been held, in milliseconds. */
  heldMs: number;
}

export interface GoalConflictView {
  schema: typeof GOAL_CONFLICT_SCHEMA;
  v: typeof GOAL_CONFLICT_VERSION;
  lockCount: number;
  locks: GoalConflictLockView[];
}

// --- lock operations ----------------------------------------------------------

/** An empty lock state. */
export function emptyGoalConflictState(): GoalConflictState {
  return { locks: [] };
}

/** The Goal holding the mutation lock for a workspace, or null when free. */
export function lockHolder(state: GoalConflictState, workspaceId: string): string | null {
  const lock = state.locks.find((l) => l.workspaceId === workspaceId);
  return lock ? lock.goalId : null;
}

// Acquire the mutation lock for a workspace. Grants the lock when the
// workspace is free; re-entrant for the Goal that already holds it (the
// original acquisition time is preserved); refused when another Goal holds
// the lock, with an actionable reason naming the holder. Returns new state on
// success or an actionable refusal; never mutates the input.
export function acquireMutationLock(
  state: GoalConflictState,
  workspaceId: string,
  goalId: string,
  acquiredAt: number,
): MutationLockResult {
  const existing = state.locks.find((l) => l.workspaceId === workspaceId);
  if (existing && existing.goalId === goalId) {
    return { ok: true, state: { locks: [...state.locks] } };
  }
  if (existing) {
    return {
      ok: false,
      state,
      reason: `workspace is already locked by Goal ${existing.goalId}; wait for it to release or choose another workspace`,
    };
  }
  return {
    ok: true,
    state: { locks: [...state.locks, { workspaceId, goalId, acquiredAt }] },
  };
}

// Release the mutation lock for a workspace. Only the holder may release; a
// non-holder or an unlocked workspace is refused with an actionable reason.
// Returns new state on success or an actionable refusal; never mutates input.
export function releaseMutationLock(
  state: GoalConflictState,
  workspaceId: string,
  goalId: string,
): MutationLockResult {
  const existing = state.locks.find((l) => l.workspaceId === workspaceId);
  if (!existing) {
    return { ok: false, state, reason: "the workspace is not locked" };
  }
  if (existing.goalId !== goalId) {
    return {
      ok: false,
      state,
      reason: `only the holding Goal (${existing.goalId}) can release this lock`,
    };
  }
  return {
    ok: true,
    state: { locks: state.locks.filter((l) => l.workspaceId !== workspaceId) },
  };
}

// --- view and formatting --------------------------------------------------------

function formatHeld(ms: number): string {
  // Issue #810: clamp negative elapsed ms (clock skew) to 0, matching activity-render.
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

// Project the lock state at a given time. Held duration is computed from the
// supplied now and clamped at zero. Never mutates the input.
export function assembleGoalConflictView(
  state: GoalConflictState,
  now: number,
): GoalConflictView {
  const locks = state.locks.map((lock) => ({
    workspaceId: lock.workspaceId,
    goalId: lock.goalId,
    heldMs: Math.max(0, now - lock.acquiredAt),
  }));
  return {
    schema: GOAL_CONFLICT_SCHEMA,
    v: GOAL_CONFLICT_VERSION,
    lockCount: locks.length,
    locks,
  };
}

export function formatGoalConflictView(view: GoalConflictView): string {
  const lines: string[] = [];
  lines.push(`Goal workspace locks (${view.schema} v${view.v})`);
  lines.push(`Locked workspaces: ${view.lockCount}`);
  if (view.lockCount === 0) {
    lines.push("  (no locked workspaces)");
  } else {
    view.locks.forEach((lock, index) => {
      lines.push(
        `  ${index + 1}. workspace ${lock.workspaceId} held by Goal ${lock.goalId} (held ${formatHeld(lock.heldMs)})`,
      );
    });
  }
  return lines.join("\n");
}
