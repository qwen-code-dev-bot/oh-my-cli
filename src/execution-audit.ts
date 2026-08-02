// Execution event audit trail: records the exact Goal revision and attempt
// that produced each execution event.
//
// Every execution event is tagged with the Goal revision number and attempt
// number that produced it, creating a complete audit trail from Goal
// definition to execution outcome. Events are bounded (max 200), redacted,
// and deterministic.

import { redactSecrets } from "./permission-impact.js";

export const EXECUTION_AUDIT_SCHEMA = "oh-my-cli.execution-audit";
export const EXECUTION_AUDIT_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ExecutionEventType =
  | "tool-call"
  | "completion"
  | "error"
  | "plan-step"
  | "approval"
  | "retry"
  | "status-change";

export interface ExecutionEvent {
  /** Event type. */
  type: ExecutionEventType;
  /** Goal revision number that produced this event. */
  goalRevision: number;
  /** Attempt number within the revision. */
  attempt: number;
  /** When the event occurred (epoch ms). */
  timestamp: number;
  /** Bounded, redacted event description. */
  description: string;
}

// --- bounds -----------------------------------------------------------------

const MAX_EVENTS = 200;
const MAX_DESCRIPTION_LENGTH = 300;

// --- description safety -----------------------------------------------------

function safeDescription(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_DESCRIPTION_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

// --- audit trail ------------------------------------------------------------

export class ExecutionAuditTrail {
  private readonly events: ExecutionEvent[] = [];

  /** Record an execution event tagged with the current revision and attempt. */
  recordEvent(
    type: ExecutionEventType,
    goalRevision: number,
    attempt: number,
    description: string,
    timestamp: number = Date.now(),
  ): ExecutionEvent {
    const event: ExecutionEvent = {
      type,
      goalRevision,
      attempt,
      timestamp,
      description: safeDescription(description),
    };

    this.events.push(event);

    // Evict oldest if over limit.
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }

    return { ...event };
  }

  /** Get all events for a specific Goal revision. */
  getEventsForRevision(goalRevision: number): ExecutionEvent[] {
    return this.events
      .filter((e) => e.goalRevision === goalRevision)
      .map((e) => ({ ...e }));
  }

  /** Get all events for a specific attempt within a revision. */
  getEventsForAttempt(goalRevision: number, attempt: number): ExecutionEvent[] {
    return this.events
      .filter((e) => e.goalRevision === goalRevision && e.attempt === attempt)
      .map((e) => ({ ...e }));
  }

  /** Get all events of a specific type. */
  getEventsByType(type: ExecutionEventType): ExecutionEvent[] {
    return this.events
      .filter((e) => e.type === type)
      .map((e) => ({ ...e }));
  }

  /** Get all events. */
  getAllEvents(): ExecutionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Number of recorded events. */
  get size(): number {
    return this.events.length;
  }
}

// --- formatting -------------------------------------------------------------

export function formatAuditTrail(trail: ExecutionAuditTrail): string {
  const events = trail.getAllEvents();
  const lines: string[] = [];

  lines.push("Execution Audit Trail");
  lines.push("═".repeat(50));
  lines.push(`Events: ${events.length}`);
  lines.push("");

  for (const event of events.slice(-20)) { // Show last 20.
    const icon = eventIcon(event.type);
    lines.push(`${icon} [rev ${event.goalRevision}, attempt ${event.attempt}] ${event.type}: ${event.description}`);
  }

  if (events.length > 20) {
    lines.push(`… ${events.length - 20} earlier events`);
  }

  lines.push("");
  lines.push("Read-only: no execution performed.");

  return lines.join("\n");
}

function eventIcon(type: ExecutionEventType): string {
  switch (type) {
    case "tool-call": return "🔧";
    case "completion": return "✓";
    case "error": return "✗";
    case "plan-step": return "▸";
    case "approval": return "🔒";
    case "retry": return "↻";
    case "status-change": return "△";
  }
}
