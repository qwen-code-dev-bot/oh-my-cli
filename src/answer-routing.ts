// Answer routing: routes user answers to the waiting Goal instead of
// creating an unrelated conversation turn.
//
// When a Goal is waiting for user input, the user's response is associated
// with the waiting Goal revision and attempt. Answer routes are bounded
// (max 50), redacted, and deterministic.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const ANSWER_ROUTING_SCHEMA = "oh-my-cli.answer-routing";
export const ANSWER_ROUTING_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface AnswerRoute {
  /** Route identifier. */
  id: string;
  /** The user's answer text (bounded, redacted). */
  answerText: string;
  /** Goal revision the answer is routed to. */
  goalRevision: number;
  /** Attempt the answer is routed to. */
  attempt: number;
  /** When the answer was received (epoch ms). */
  receivedAt: number;
  /** Whether the answer has been consumed by the Goal. */
  consumed: boolean;
  /** When the answer was consumed (epoch ms). */
  consumedAt?: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_ROUTES = 50;
const MAX_ANSWER_LENGTH = 500;

function safeAnswer(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_ANSWER_LENGTH
    ? redacted
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_ANSWER_LENGTH - 1))}…`;
}

// --- answer router ----------------------------------------------------------

export class AnswerRouter {
  private readonly routes: AnswerRoute[] = [];
  private nextId = 1;

  /** Route a user answer to a waiting Goal. */
  routeAnswer(
    answerText: string,
    goalRevision: number,
    attempt: number,
    receivedAt: number = Date.now(),
  ): AnswerRoute | null {
    if (this.routes.length >= MAX_ROUTES) {
      return null; // At capacity.
    }

    const route: AnswerRoute = {
      id: `answer-${this.nextId++}`,
      answerText: safeAnswer(answerText),
      goalRevision,
      attempt,
      receivedAt,
      consumed: false,
    };

    this.routes.push(route);
    return { ...route };
  }

  /** Get all pending (unconsumed) answer routes. */
  getPendingAnswerRoutes(): AnswerRoute[] {
    return this.routes
      .filter((r) => !r.consumed)
      .map((r) => ({ ...r }));
  }

  /** Get all answer routes for a specific revision. */
  getRoutesForRevision(goalRevision: number): AnswerRoute[] {
    return this.routes
      .filter((r) => r.goalRevision === goalRevision)
      .map((r) => ({ ...r }));
  }

  /** Consume an answer route (mark as consumed). */
  consumeAnswer(routeId: string, consumedAt: number = Date.now()): AnswerRoute | null {
    const route = this.routes.find((r) => r.id === routeId);
    if (!route || route.consumed) return null;

    route.consumed = true;
    route.consumedAt = consumedAt;
    return { ...route };
  }

  /** Number of routes. */
  get size(): number {
    return this.routes.length;
  }

  /** Number of pending routes. */
  get pendingCount(): number {
    return this.routes.filter((r) => !r.consumed).length;
  }
}

// --- formatting -------------------------------------------------------------

export function formatAnswerRouter(router: AnswerRouter): string {
  const pending = router.getPendingAnswerRoutes();
  const lines: string[] = [];

  lines.push("Answer Routes");
  lines.push("═".repeat(50));
  lines.push(`Total: ${router.size}  Pending: ${router.pendingCount}`);
  lines.push("");

  for (const route of pending) {
    lines.push(`  ○ ${route.id} → rev ${route.goalRevision}, attempt ${route.attempt}`);
    lines.push(`    "${route.answerText}"`);
  }

  if (pending.length === 0) {
    lines.push("  No pending answers.");
  }

  lines.push("");
  lines.push("Read-only: no conversation turns managed.");

  return lines.join("\n");
}
