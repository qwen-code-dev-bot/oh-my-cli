// Progress loop detector: detects repeated no-progress loops and provides
// actionable warnings.
//
// Tracks step advancement and detects when the same step is attempted
// repeatedly without advancing. Triggers a warning after a configurable
// threshold. Read-only detection, deterministic.

export const PROGRESS_LOOP_SCHEMA = "oh-my-cli.progress-loop-detector";
export const PROGRESS_LOOP_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface NoProgressWarning {
  schema: typeof PROGRESS_LOOP_SCHEMA;
  v: typeof PROGRESS_LOOP_VERSION;
  /** Whether a no-progress loop is detected. */
  loopDetected: boolean;
  /** The step that is stuck. */
  stuckStep: string;
  /** Number of consecutive attempts on the stuck step. */
  attemptCount: number;
  /** The detection threshold. */
  threshold: number;
  /** Actionable warning message. */
  message: string;
}

// --- default threshold ------------------------------------------------------

const DEFAULT_THRESHOLD = 3;

// --- progress tracker -------------------------------------------------------

export class ProgressTracker {
  private currentStep: string | null = null;
  private consecutiveAttempts = 0;
  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /** Record an attempt on a step. Returns a warning if a loop is detected. */
  recordAttempt(step: string): NoProgressWarning {
    if (step === this.currentStep) {
      this.consecutiveAttempts++;
    } else {
      this.currentStep = step;
      this.consecutiveAttempts = 1;
    }

    const loopDetected = this.consecutiveAttempts >= this.threshold;

    return {
      schema: PROGRESS_LOOP_SCHEMA,
      v: PROGRESS_LOOP_VERSION,
      loopDetected,
      stuckStep: step,
      attemptCount: this.consecutiveAttempts,
      threshold: this.threshold,
      message: loopDetected
        ? `No progress detected: step "${step}" has been attempted ${this.consecutiveAttempts} times without advancing. Consider: retry with a different approach, skip this step, or cancel the Goal.`
        : `Step "${step}" attempt ${this.consecutiveAttempts}/${this.threshold}.`,
    };
  }

  /** Record advancement to a new step (resets the attempt counter). */
  advanceTo(step: string): void {
    this.currentStep = step;
    this.consecutiveAttempts = 0;
  }

  /** Get the current attempt count for the current step. */
  get attemptCount(): number {
    return this.consecutiveAttempts;
  }

  /** Get the current step. */
  get currentStepName(): string | null {
    return this.currentStep;
  }
}

// --- formatting -------------------------------------------------------------

export function formatNoProgressWarning(warning: NoProgressWarning): string {
  const icon = warning.loopDetected ? "⚠" : "○";
  const status = warning.loopDetected ? "LOOP DETECTED" : "IN PROGRESS";

  const lines: string[] = [];
  lines.push(`Progress: ${icon} ${status}`);
  lines.push(`Step: ${warning.stuckStep}`);
  lines.push(`Attempts: ${warning.attemptCount}/${warning.threshold}`);
  lines.push(`Message: ${warning.message}`);

  return lines.join("\n");
}
