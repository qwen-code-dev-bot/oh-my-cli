// Session activity and efficiency, exposed as an inspectable, deterministic
// stats view (Issue #201).
//
// Users need to see where a session's time, context, model requests, and tool
// activity went without reading raw logs. This module derives that view from the
// canonical session record (the persisted messages) plus an OPTIONAL live-runtime
// enrichment captured during the current session. Nothing is fabricated: a value
// the provider or runtime never reported is reported as "unavailable"; an
// estimate (the chars/4 context size, the bundled-price cost) is labelled as an
// estimate; and tool names and paths are secret-safe before they reach output.
//
// The same engine backs the interactive `/stats` overlay and the headless
// `--session-stats` form, so a session's numbers read identically in both
// (parity). Aggregation is deterministic: counts come from the message log, so
// resuming a session recomputes the same totals without double-counting restored
// events; live-runtime counters are per current session and reset on resume
// rather than being re-counted from replayed history.

import { redactSecrets } from "./permission-impact.js";
import { formatCostUsd } from "./cost.js";
import type { SessionMessage } from "./session.js";

export const SESSION_STATS_SCHEMA = "oh-my-cli.stats";
export const SESSION_STATS_VERSION = 1;

// Rough context-size divisor (chars per token), matching session-summary.ts so
// the estimate is consistent wherever it is shown.
const CHARS_PER_TOKEN = 4;
// Bound the distinct tool names reported so a pathological or unknown tool
// cannot inflate the view into high-cardinality output; overflow rolls into a
// single "__other__" bucket (mirrors run-summary.ts).
const MAX_TOOL_NAMES = 16;
// A tool name longer than this is clipped so a malformed name cannot blow up a
// single row of the view.
const MAX_TOOL_NAME_CHARS = 60;

// Provenance of a single numeric field, so the view never conflates a
// measurement with an estimate or presents an unavailable field as a real value.
export type StatKind = "measured" | "estimate" | "unavailable";

export interface StatMetric {
  kind: StatKind;
  // Present for "measured" and "estimate"; null for "unavailable".
  value: number | null;
}

// A counted breakdown (tool calls / failures): a total plus a bounded byName
// map. `kind` is "measured" when the runtime/log supplied it, "unavailable"
// when the field could not be derived (e.g. failures on a headless read).
export interface StatCountMap {
  kind: StatKind;
  total: number;
  byName: Record<string, number>;
}

export interface SessionStats {
  schema: typeof SESSION_STATS_SCHEMA;
  v: typeof SESSION_STATS_VERSION;
  sessionId: string;
  // Redacted provenance so the view names the model and repository it belongs
  // to. null when unknown.
  provenance: {
    model: string | null;
    workspace: string | null;
  };
  // Deterministic from the canonical message log.
  activity: {
    messages: number;
    userTurns: number;
    assistantTurns: number;
  };
  context: {
    // Measured character count of the conversation.
    chars: number;
    // Context-size estimate (chars / 4); always labelled as an estimate so it
    // is never mistaken for an exact token count.
    tokens: StatMetric;
  };
  // Live model activity for the current session; every field is "unavailable"
  // headless or before any turn has reported (e.g. a freshly resumed session).
  model: {
    requests: StatMetric;
    retries: StatMetric;
    tokens: { prompt: StatMetric; completion: StatMetric; total: StatMetric };
    estimatedCostUsd: StatMetric;
    // Whether the cost used a known model price (true) or the conservative
    // fallback (false). Only meaningful when a cost is present.
    costKnown: boolean;
  };
  tools: {
    // Tool calls counted from the message log (deterministic, resume-safe).
    calls: StatCountMap;
    // Tool failures from the live runtime; "unavailable" headless/resumed.
    failures: StatCountMap;
  };
  timing: {
    // Wall-clock time spent in provider/tool activity this session.
    elapsedMs: StatMetric;
  };
}

// Live, per-session runtime enrichment. All fields are optional; whatever the
// current session has accumulated is layered over the deterministic log counts.
export interface SessionStatsRuntime {
  rounds?: number;
  retries?: number;
  elapsedMs?: number;
  tokens?: { prompt: number; completion: number; total: number } | null;
  estimatedCostUsd?: number | null;
  costKnown?: boolean;
  toolFailures?: Record<string, number>;
}

export interface BuildSessionStatsInput {
  sessionId: string;
  messages: SessionMessage[];
  model?: string | null;
  // An already-redacted workspace path (home collapsed to ~); the caller redacts
  // so this module never sees a raw host path.
  workspace?: string | null;
  runtime?: SessionStatsRuntime;
}

function measured(value: number): StatMetric {
  return { kind: "measured", value: Math.max(0, Math.floor(value)) };
}

function estimate(value: number): StatMetric {
  return { kind: "estimate", value: Math.max(0, Math.floor(value)) };
}

// Like estimate(), but preserves sub-unit magnitude: a USD cost is well below 1,
// so flooring it (as estimate() does for whole-count quantities) would zero it
// out and report a fabricated $0.000000.
function estimateFraction(value: number): StatMetric {
  return { kind: "estimate", value: Math.max(0, value) };
}

function unavailable(): StatMetric {
  return { kind: "unavailable", value: null };
}

// A tool name is a fixed identifier in practice, but a model could emit a
// secret-shaped name; redact it and bound its length so the view stays
// secret-safe and compact.
function safeToolName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const redacted = redactSecrets(raw).text.trim();
  const bounded =
    redacted.length > MAX_TOOL_NAME_CHARS
      ? redacted.slice(0, MAX_TOOL_NAME_CHARS - 1) + "…"
      : redacted;
  return bounded === "" ? "(unknown)" : bounded;
}

// Collapse a raw name→count map into a total plus a bounded, deterministic
// byName map. Names are sorted (count desc, then name) for stable output;
// overflow beyond MAX_TOOL_NAMES distinct names aggregates into "__other__".
function boundByName(raw: Record<string, number>): { total: number; byName: Record<string, number> } {
  let total = 0;
  const entries: Array<[string, number]> = [];
  for (const [name, count] of Object.entries(raw)) {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (n <= 0) continue;
    total += n;
    entries.push([name, n]);
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byName: Record<string, number> = {};
  let other = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i < MAX_TOOL_NAMES) byName[entries[i][0]] = entries[i][1];
    else other += entries[i][1];
  }
  if (other > 0) byName["__other__"] = other;
  return { total, byName };
}

// Build a deterministic stats view from the canonical message log, layered with
// optional live-runtime enrichment. Pure: identical inputs yield identical
// output, and message-derived counts never double-count restored events.
export function buildSessionStats(input: BuildSessionStatsInput): SessionStats {
  let userTurns = 0;
  let assistantTurns = 0;
  let chars = 0;
  const toolCallNames: Record<string, number> = {};
  for (const m of input.messages) {
    if (m.role === "user") userTurns++;
    else if (m.role === "assistant") assistantTurns++;
    if (typeof m.content === "string") chars += m.content.length;
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const name = safeToolName(call?.function?.name);
        toolCallNames[name] = (toolCallNames[name] ?? 0) + 1;
      }
    }
  }
  const calls = boundByName(toolCallNames);

  const rt = input.runtime;
  const hasTokens = Boolean(rt?.tokens && rt.tokens.total > 0);

  const modelTokens = {
    prompt: hasTokens ? measured(rt!.tokens!.prompt) : unavailable(),
    completion: hasTokens ? measured(rt!.tokens!.completion) : unavailable(),
    total: hasTokens ? measured(rt!.tokens!.total) : unavailable(),
  };

  const cost: StatMetric =
    rt && typeof rt.estimatedCostUsd === "number" && Number.isFinite(rt.estimatedCostUsd)
      ? estimateFraction(rt.estimatedCostUsd)
      : unavailable();

  const failuresBound = boundByName(rt?.toolFailures ?? {});
  const failures: StatCountMap = rt
    ? { kind: "measured", total: failuresBound.total, byName: failuresBound.byName }
    : { kind: "unavailable", total: 0, byName: {} };

  return {
    schema: SESSION_STATS_SCHEMA,
    v: SESSION_STATS_VERSION,
    sessionId: input.sessionId,
    provenance: {
      model: input.model ?? null,
      workspace: input.workspace ?? null,
    },
    activity: {
      messages: input.messages.length,
      userTurns,
      assistantTurns,
    },
    context: {
      chars,
      tokens: estimate(Math.ceil(chars / CHARS_PER_TOKEN)),
    },
    model: {
      requests: rt && rt.rounds != null ? measured(rt.rounds) : unavailable(),
      retries: rt && rt.retries != null ? measured(rt.retries) : unavailable(),
      tokens: modelTokens,
      estimatedCostUsd: cost,
      costKnown: rt?.costKnown ?? false,
    },
    tools: {
      calls: { kind: "measured", total: calls.total, byName: calls.byName },
      failures,
    },
    timing: {
      elapsedMs: rt && rt.elapsedMs != null ? measured(rt.elapsedMs) : unavailable(),
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// A minimal style contract so the renderer can colorize section headers and
// labels without importing the shell's palette (which would be a circular
// import). The shell's ShellStyle is structurally a superset, so it is passed
// directly; omitting the style yields plain ASCII (headless / no-color).
export interface StatsStyle {
  bold: string;
  dim: string;
  accent: string;
  accentSoft: string;
  success: string;
  reset: string;
}

const NO_STYLE: StatsStyle = {
  bold: "",
  dim: "",
  accent: "",
  accentSoft: "",
  success: "",
  reset: "",
};

function metricText(m: StatMetric, fmt: (n: number) => string = (n) => String(n)): string {
  if (m.kind === "unavailable" || m.value === null) return "n/a";
  const v = fmt(m.value);
  return m.kind === "estimate" ? `${v} (est.)` : v;
}

// A compact, deterministic breakdown suffix: " (read_file×3, grep×2)".
function breakdownSuffix(byName: Record<string, number>): string {
  const names = Object.keys(byName);
  if (names.length === 0) return "";
  return ` (${names.map((n) => `${n}×${byName[n]}`).join(", ")})`;
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// A deterministic, human-readable rendering of the stats view. Returns logical
// lines (no width clipping) so the headless form can pipe them and the TUI panel
// can clip each to its column budget. Every value states its provenance:
// measured values are bare, estimates are tagged "(est.)", and fields the
// runtime never reported read "n/a" — never a fabricated zero.
export function formatSessionStats(
  stats: SessionStats,
  opts: { style?: StatsStyle } = {},
): string[] {
  const s = opts.style ?? NO_STYLE;
  const out: string[] = [];
  const section = (label: string): void => {
    out.push(`${s.bold}${s.accent}${label}${s.reset}`);
  };
  const row = (label: string, value: string): void => {
    out.push(`  ${label.padEnd(16, " ")}${value}`);
  };

  const prov: string[] = [];
  if (stats.provenance.model) prov.push(`model ${stats.provenance.model}`);
  if (stats.provenance.workspace) prov.push(`repo ${stats.provenance.workspace}`);
  if (prov.length > 0) out.push(`${s.dim}${prov.join("  ·  ")}${s.reset}`);

  section("Session activity");
  row("messages", String(stats.activity.messages));
  row("your turns", String(stats.activity.userTurns));
  row("assistant turns", String(stats.activity.assistantTurns));

  section("Context");
  row("characters", stats.context.chars.toLocaleString("en-US"));
  row("context size", `${metricText(stats.context.tokens)} tokens`);

  section("Model activity (this session)");
  row("requests", metricText(stats.model.requests));
  row("retries", metricText(stats.model.retries));
  if (
    stats.model.tokens.total.kind === "unavailable" &&
    stats.model.tokens.prompt.kind === "unavailable"
  ) {
    row("tokens", "n/a");
  } else {
    row(
      "tokens",
      `prompt ${metricText(stats.model.tokens.prompt)} · ` +
        `completion ${metricText(stats.model.tokens.completion)} · ` +
        `total ${metricText(stats.model.tokens.total)}`,
    );
  }
  if (stats.model.estimatedCostUsd.kind === "unavailable") {
    row("est. cost", "n/a");
  } else {
    row(
      "est. cost",
      `${formatCostUsd(stats.model.estimatedCostUsd.value ?? 0)} (est., not billing)`,
    );
    row("cost basis", stats.model.costKnown ? "known model price" : "conservative fallback");
  }

  section("Tool outcomes");
  row("tool calls", `${stats.tools.calls.total}${breakdownSuffix(stats.tools.calls.byName)}`);
  if (stats.tools.failures.kind === "unavailable") {
    row("tool failures", "n/a");
  } else {
    row(
      "tool failures",
      `${stats.tools.failures.total}${breakdownSuffix(stats.tools.failures.byName)}`,
    );
  }

  section("Timing");
  row("active time", metricText(stats.timing.elapsedMs, formatElapsed));

  return out;
}
