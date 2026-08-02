// Goal surface redaction sweep: one contract that strips secrets from the
// four Goal text surfaces — summaries, persisted events, exports, and
// diagnostics — and reports where secrets were stripped.
//
// Goal-related text leaves the terminal through several surfaces. Each used
// to redact ad hoc (or not at all), so a secret-shaped value could leak
// through whichever surface skipped the shared redactor. This sweep applies
// the shared redactor to every surface and reports per-surface counts. The
// sweep is pure and read-only: it introduces no new redaction rules and
// mutates no persisted state. Reports name surfaces and counts only — never
// secret material.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_REDACTION_SCHEMA = "oh-my-cli.goal-redaction";
export const GOAL_REDACTION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type GoalSurface = "summary" | "events" | "export" | "diagnostics";

/** Fixed rendering/iteration order for deterministic output. */
export const GOAL_SURFACE_ORDER: GoalSurface[] = [
  "summary",
  "events",
  "export",
  "diagnostics",
];

export interface GoalSurfaceTexts {
  /** Goal completion/work summary text. */
  summary: string;
  /** Persisted lifecycle and execution event texts. */
  events: string[];
  /** Exported session/Goal text. */
  exportText: string;
  /** Diagnostic lines. */
  diagnostics: string[];
}

export interface GoalRedactionResult {
  schema: typeof GOAL_REDACTION_SCHEMA;
  v: typeof GOAL_REDACTION_VERSION;
  /** Redacted copies, identical in shape to the input. */
  redacted: GoalSurfaceTexts;
  /** How many secrets were stripped per surface. */
  stripped: Record<GoalSurface, number>;
  /** Aggregate count across all surfaces. */
  totalStripped: number;
  /** Whether at least one secret was stripped. */
  hadSecrets: boolean;
}

// --- sweep --------------------------------------------------------------------

// Apply the shared redactor to every Goal surface. Returns redacted copies of
// identical shape plus per-surface stripped counts. Never mutates the input.
export function redactGoalSurfaces(texts: GoalSurfaceTexts): GoalRedactionResult {
  const summary = redactSecrets(texts.summary);
  const events = texts.events.map((event) => redactSecrets(event));
  const exportText = redactSecrets(texts.exportText);
  const diagnostics = texts.diagnostics.map((line) => redactSecrets(line));

  const stripped: Record<GoalSurface, number> = {
    summary: summary.count,
    events: events.reduce((total, result) => total + result.count, 0),
    export: exportText.count,
    diagnostics: diagnostics.reduce((total, result) => total + result.count, 0),
  };
  const totalStripped = GOAL_SURFACE_ORDER.reduce(
    (total, surface) => total + stripped[surface],
    0,
  );

  return {
    schema: GOAL_REDACTION_SCHEMA,
    v: GOAL_REDACTION_VERSION,
    redacted: {
      summary: summary.text,
      events: events.map((result) => result.text),
      exportText: exportText.text,
      diagnostics: diagnostics.map((result) => result.text),
    },
    stripped,
    totalStripped,
    hadSecrets: totalStripped > 0,
  };
}

// --- reporting ----------------------------------------------------------------

// Render a deterministic per-surface redaction report. Names surfaces and
// counts only; never includes secret material.
export function formatRedactionReport(result: GoalRedactionResult): string {
  const lines: string[] = [];
  lines.push(`Goal surface redaction (${result.schema} v${result.v})`);
  for (const surface of GOAL_SURFACE_ORDER) {
    const count = result.stripped[surface];
    lines.push(`  ${surface}: ${count} ${count === 1 ? "secret" : "secrets"} stripped`);
  }
  lines.push(`Total: ${result.totalStripped} ${result.totalStripped === 1 ? "secret" : "secrets"} stripped`);
  lines.push(`Result: ${result.hadSecrets ? "SECRETS STRIPPED" : "NO SECRETS FOUND"}`);
  return lines.join("\n");
}
