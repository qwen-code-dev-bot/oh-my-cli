// Durable per-session goal (Issue #189).
//
// A session carries at most one active objective the user pins with `/goal`.
// It is persisted as a sidecar next to the session checkpoint so it is restored
// on `--resume` and is never visible to other sessions. Every mutation bumps a
// monotonic token; in-flight progress that captured an earlier token can be
// rejected as stale so a paused or cleared goal is never silently reactivated
// by a result that was already on its way when the user changed their mind.
//
// Objectives are user-authored free text, so every value that reaches the
// terminal passes through the same secret-redaction and spoofing-neutralization
// boundary as the rest of the shell.

import fs from "node:fs";
import path from "node:path";
import { redactSecrets, neutralizeSpoofing } from "./permission-impact.js";

export type GoalStatus = "active" | "paused";

export interface GoalState {
  objective: string;
  status: GoalStatus;
  /** ISO 8601 — when the current objective was first set. */
  setAt: string;
  /** ISO 8601 — when the goal last changed state (set/pause/resume). */
  updatedAt: string;
  /** Monotonic counter bumped on every mutation; used to detect stale progress. */
  token: number;
}

export type GoalCommand =
  | { kind: "set"; objective: string }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "help" };

// A bare subcommand keyword (and nothing else) dispatches to that control verb;
// any additional text means the whole line is the objective. This keeps the
// reserved words from swallowing a legitimate objective like "status page".
export function parseGoalCommand(input: string): GoalCommand {
  const trimmed = input.trim();
  switch (trimmed.toLowerCase()) {
    case "":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "clear":
      return { kind: "clear" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "set", objective: trimmed };
  }
}

function isValidGoal(v: Partial<GoalState> | null | undefined): v is GoalState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.objective === "string" &&
    (v.status === "active" || v.status === "paused") &&
    typeof v.setAt === "string" &&
    typeof v.updatedAt === "string" &&
    typeof v.token === "number"
  );
}

export class GoalStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = path.join(
      baseDir ?? path.join(process.env.HOME ?? "/root", ".oh-my-cli", "sessions"),
    );
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // Distinct `.goal.json` extension keeps the sidecar out of SessionStore.listIds
  // (which matches *.jsonl) while living in the same directory as the session.
  filePath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.goal.json`);
  }

  private tempPath(sessionId: string): string {
    return this.filePath(sessionId) + ".tmp";
  }

  get(sessionId: string): GoalState | null {
    const fp = this.filePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8")) as Partial<GoalState>;
      return isValidGoal(parsed) ? parsed : null;
    } catch {
      // A half-written or corrupt sidecar is treated as "no goal" rather than
      // crashing the command; the next set/pause/resume overwrites it cleanly.
      return null;
    }
  }

  // Atomically replace the sidecar via a sibling temp + rename, mirroring the
  // session checkpoint write so a crash never leaves a half-written goal.
  private write(sessionId: string, goal: GoalState): GoalState {
    const fp = this.filePath(sessionId);
    const tmp = this.tempPath(sessionId);
    fs.writeFileSync(tmp, JSON.stringify(goal) + "\n", "utf-8");
    fs.renameSync(tmp, fp);
    return goal;
  }

  // Set or replace the goal. Replacing bumps the token so any progress captured
  // against the previous objective is invalidated. The result is always active.
  set(sessionId: string, objective: string, now: Date = new Date()): GoalState {
    const existing = this.get(sessionId);
    const iso = now.toISOString();
    return this.write(sessionId, {
      objective,
      status: "active",
      setAt: iso,
      updatedAt: iso,
      token: (existing?.token ?? 0) + 1,
    });
  }

  // Pause the goal. Idempotent: pausing an already-paused goal is a no-op that
  // does not bump the token. The first pause bumps it, invalidating in-flight
  // progress so an older result cannot complete the now-paused goal.
  pause(sessionId: string, now: Date = new Date()): GoalState | null {
    const existing = this.get(sessionId);
    if (!existing) return null;
    if (existing.status === "paused") return existing;
    return this.write(sessionId, {
      ...existing,
      status: "paused",
      updatedAt: now.toISOString(),
      token: existing.token + 1,
    });
  }

  // Resume a paused goal. Idempotent: resuming an already-active goal is a no-op.
  resume(sessionId: string, now: Date = new Date()): GoalState | null {
    const existing = this.get(sessionId);
    if (!existing) return null;
    if (existing.status === "active") return existing;
    return this.write(sessionId, {
      ...existing,
      status: "active",
      updatedAt: now.toISOString(),
      token: existing.token + 1,
    });
  }

  // Remove the goal entirely. Deleting the sidecar means get() returns null, the
  // strongest invalidation: any captured token is now stale.
  clear(sessionId: string): void {
    fs.rmSync(this.filePath(sessionId), { force: true });
    fs.rmSync(this.tempPath(sessionId), { force: true });
  }

  // Stale-progress guard. A caller that captured `capturedToken` before doing
  // work toward the goal calls this afterward; it reports stale when the goal
  // has since been cleared, replaced, paused, or resumed (token advanced).
  isStale(sessionId: string, capturedToken: number): boolean {
    const current = this.get(sessionId);
    if (!current) return true;
    return current.token !== capturedToken;
  }
}

// Render an objective for the terminal: strip secret-like values, then replace
// spoofing Unicode with visible markers so a displayed goal cannot differ from
// what was set.
export function describeObjective(objective: string): string {
  return neutralizeSpoofing(redactSecrets(objective).text).text;
}

export const GOAL_USAGE = [
  "Goal commands:",
  "  /goal <objective>   set or replace this session's goal",
  "  /goal status        show the current goal and its state",
  "  /goal pause         pause the goal (invalidates in-flight progress)",
  "  /goal resume        resume a paused goal",
  "  /goal clear         remove the goal (invalidates in-flight progress)",
].join("\n");

export function formatGoalStatus(goal: GoalState | null): string {
  if (!goal) {
    return "No active goal. Set one with: /goal <objective>";
  }
  const lines = [
    `Goal [${goal.status}]: ${describeObjective(goal.objective)}`,
    `  set:     ${goal.setAt}`,
    `  updated: ${goal.updatedAt}`,
  ];
  if (goal.status === "paused") {
    lines.push("  paused — /goal resume to reactivate");
  }
  return lines.join("\n");
}

export interface GoalResult {
  feedback: string;
  goal: GoalState | null;
}

// Apply a parsed goal command to the store and produce the user-facing feedback
// line. Pure with respect to the terminal: callers render `feedback` however
// they display notices. `now` is injectable for deterministic tests.
export function runGoalCommand(
  store: GoalStore,
  sessionId: string,
  cmd: GoalCommand,
  now: Date = new Date(),
): GoalResult {
  switch (cmd.kind) {
    case "help":
      return { feedback: GOAL_USAGE, goal: store.get(sessionId) };
    case "status":
      return { feedback: formatGoalStatus(store.get(sessionId)), goal: store.get(sessionId) };
    case "set": {
      const goal = store.set(sessionId, cmd.objective, now);
      return { feedback: `Goal set: ${describeObjective(goal.objective)}`, goal };
    }
    case "pause": {
      if (!store.get(sessionId)) {
        return { feedback: "No goal to pause. Set one with: /goal <objective>", goal: null };
      }
      const goal = store.pause(sessionId, now)!;
      return { feedback: `Goal paused: ${describeObjective(goal.objective)}`, goal };
    }
    case "resume": {
      if (!store.get(sessionId)) {
        return { feedback: "No goal to resume. Set one with: /goal <objective>", goal: null };
      }
      const goal = store.resume(sessionId, now)!;
      return { feedback: `Goal resumed: ${describeObjective(goal.objective)}`, goal };
    }
    case "clear": {
      const had = store.get(sessionId) !== null;
      store.clear(sessionId);
      return {
        feedback: had
          ? "Goal cleared. In-flight progress will not reactivate it."
          : "No active goal to clear.",
        goal: null,
      };
    }
  }
}
