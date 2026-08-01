// Read-only automation run history: tracks recurring mission schedules,
// run outcomes, and schedule state.
//
// Schedule entries expose identity, trigger type, enabled state, last/next
// run, and run history. Run entries expose outcome, duration, timestamp,
// and error summary. Consecutive failure tracking flags schedules that
// need attention. The view is read-only and never executes, triggers,
// enables, disables, or modifies schedules.

export const AUTOMATION_HISTORY_SCHEMA = "oh-my-cli.automation-history";
export const AUTOMATION_HISTORY_VERSION = 1;

// --- types ------------------------------------------------------------------

export type TriggerType = "interval" | "calendar" | "event" | "webhook";
export type RunOutcome = "success" | "failure" | "skipped" | "missed";
export type ScheduleState = "enabled" | "paused" | "disabled";

export interface RunEntry {
  /** Run identifier. */
  id: string;
  outcome: RunOutcome;
  /** Epoch ms of run start. */
  startedAt: number;
  /** Duration in ms. */
  durationMs: number;
  /** Error summary (for failures). */
  errorSummary?: string;
}

export interface ScheduleEntry {
  /** Stable schedule identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  triggerType: TriggerType;
  state: ScheduleState;
  /** Cron or interval expression. */
  expression: string;
  /** Epoch ms of last run (when known). */
  lastRunAt?: number;
  /** Epoch ms of next scheduled run (when known). */
  nextRunAt?: number;
  /** Run history (most recent first). */
  runs: RunEntry[];
  /** Consecutive failure count. */
  consecutiveFailures: number;
  /** Whether this schedule needs attention (3+ consecutive failures). */
  needsAttention: boolean;
}

// --- automation tracker -----------------------------------------------------

const ATTENTION_THRESHOLD = 3;
const MAX_RUNS = 50;

export class AutomationTracker {
  private readonly schedules = new Map<string, ScheduleEntry>();

  /** Register a schedule. */
  register(opts: {
    id: string;
    name: string;
    triggerType: TriggerType;
    expression: string;
    state?: ScheduleState;
  }): ScheduleEntry {
    const entry: ScheduleEntry = {
      id: opts.id,
      name: opts.name,
      triggerType: opts.triggerType,
      state: opts.state ?? "enabled",
      expression: opts.expression,
      runs: [],
      consecutiveFailures: 0,
      needsAttention: false,
    };
    this.schedules.set(entry.id, entry);
    return entry;
  }

  /** Record a run outcome for a schedule. */
  recordRun(scheduleId: string, run: RunEntry): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    schedule.runs.unshift(run);
    if (schedule.runs.length > MAX_RUNS) {
      schedule.runs.length = MAX_RUNS;
    }

    schedule.lastRunAt = run.startedAt;

    // Update consecutive failure count.
    if (run.outcome === "failure" || run.outcome === "missed") {
      schedule.consecutiveFailures++;
    } else if (run.outcome === "success") {
      schedule.consecutiveFailures = 0;
    }
    // "skipped" does not reset the counter.

    schedule.needsAttention = schedule.consecutiveFailures >= ATTENTION_THRESHOLD;
  }

  /** Set the next run time. */
  setNextRun(scheduleId: string, nextRunAt: number): void {
    const schedule = this.schedules.get(scheduleId);
    if (schedule) schedule.nextRunAt = nextRunAt;
  }

  get(id: string): ScheduleEntry | undefined {
    return this.schedules.get(id);
  }

  list(): ScheduleEntry[] {
    return [...this.schedules.values()];
  }

  /** Get schedules that need attention. */
  getNeedingAttention(): ScheduleEntry[] {
    return this.list().filter((s) => s.needsAttention);
  }

  /** Get enabled schedules. */
  getEnabled(): ScheduleEntry[] {
    return this.list().filter((s) => s.state === "enabled");
  }

  get size(): number {
    return this.schedules.size;
  }
}

// --- formatting -------------------------------------------------------------

export function formatScheduleEntry(schedule: ScheduleEntry): string {
  const lines: string[] = [];
  const icon = stateIcon(schedule.state);
  const attention = schedule.needsAttention ? " ⚠NEEDS ATTENTION" : "";
  lines.push(`${icon} ${schedule.name} [${schedule.triggerType}: ${schedule.expression}] ${schedule.state}${attention}`);

  if (schedule.lastRunAt) {
    lines.push(`  Last run: ${new Date(schedule.lastRunAt).toISOString()}`);
  }
  if (schedule.nextRunAt) {
    lines.push(`  Next run: ${new Date(schedule.nextRunAt).toISOString()}`);
  }
  if (schedule.consecutiveFailures > 0) {
    lines.push(`  Consecutive failures: ${schedule.consecutiveFailures}`);
  }

  // Show last 3 runs.
  for (const run of schedule.runs.slice(0, 3)) {
    const runIcon = outcomeIcon(run.outcome);
    const error = run.errorSummary ? ` — ${run.errorSummary}` : "";
    lines.push(`  ${runIcon} ${run.outcome} ${run.durationMs}ms${error}`);
  }
  if (schedule.runs.length > 3) {
    lines.push(`  … ${schedule.runs.length - 3} more runs`);
  }

  return lines.join("\n");
}

export function formatTrackerSummary(tracker: AutomationTracker): string {
  const lines: string[] = [];
  lines.push("Automation History");
  lines.push("═".repeat(50));
  lines.push(`Schedules: ${tracker.size}  Enabled: ${tracker.getEnabled().length}  Needs attention: ${tracker.getNeedingAttention().length}`);

  for (const schedule of tracker.list()) {
    lines.push("");
    lines.push(formatScheduleEntry(schedule));
  }

  lines.push("");
  lines.push("Read-only: no schedules executed, triggered, or modified.");

  return lines.join("\n");
}

function stateIcon(state: ScheduleState): string {
  switch (state) {
    case "enabled": return "●";
    case "paused": return "‖";
    case "disabled": return "○";
  }
}

function outcomeIcon(outcome: RunOutcome): string {
  switch (outcome) {
    case "success": return "✓";
    case "failure": return "✗";
    case "skipped": return "→";
    case "missed": return "⚠";
  }
}
