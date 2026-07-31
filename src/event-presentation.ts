// Shared event presentation model: the single canonical way both surfaces
// present the activity of an agent turn — assistant text, tool calls, subagents,
// approvals, warnings, diffs, and results. It defines canonical event KINDS and
// STATUS values (every status maps to a real runtime condition; there is no
// presentation-only status), and a pure mapper that turns a runtime event into a
// redacted, escape-neutralized, detail-bounded presentation a surface can render
// safely. This is the dependency-first foundation of the unified activity roadmap
// (Issue #291); the TUI activity cards (#307), failure presentation (#308),
// Desktop timeline (#309), and cross-surface parity proof (#310) all consume this
// model rather than re-parsing raw output.
//
// Trust boundary: tool and model output is untrusted and may contain secrets or
// terminal control sequences. The mapper redacts secrets and neutralizes unsafe
// escape sequences BEFORE any surface renders the result, and bounds raw detail
// so a pathological output cannot flood the screen. The model exposes no private
// chain-of-thought and never fabricates a status an event does not actually have.

import { redactSecrets } from "./permission-impact.js";

export const EVENT_PRESENTATION_SCHEMA = "oh-my-cli.event-presentation";
export const EVENT_PRESENTATION_VERSION = 1;

// The canonical activity event kinds, in presentation order. A surface renders
// these exact kinds; contract tests pin the set so a kind cannot be added,
// renamed, or dropped without a failing check.
export const EVENT_KINDS = [
  "assistant-text",
  "tool-call",
  "subagent",
  "approval",
  "warning",
  "diff",
  "result",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// The canonical activity status values. Each maps to a real runtime condition
// (see EVENT_STATUS_RUNTIME_MAPPING); there is deliberately no presentation-only
// status a surface could invent.
export const EVENT_STATUSES = [
  "pending",
  "active",
  "completed",
  "failed",
  "waiting",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// Maps every canonical status to the real runtime condition it represents. The
// completeness of this mapping (every status has a non-empty runtime meaning) is
// what guarantees there is no presentation-only status.
export const EVENT_STATUS_RUNTIME_MAPPING: Record<EventStatus, string> = {
  pending: "event queued by the runtime, not yet started",
  active: "event streaming or executing now",
  completed: "event finished successfully",
  failed: "event errored",
  waiting: "event blocked on an approval, network, rate-limit, or CI queue",
  cancelled: "event interrupted by the user",
};

// Maximum characters of raw detail carried into a presented event before it is
// bounded. Keeps a pathological tool output from flooding the surface; the
// truncation is reported, never silent.
export const DETAIL_BOUND = 4000;

// A runtime event as produced by the agent loop. `summary` and `detail` are raw
// and untrusted; the mapper redacts and neutralizes them.
export interface RuntimeEvent {
  kind: EventKind;
  status: EventStatus;
  summary?: string;
  detail?: string;
  elapsedMs?: number;
  live?: boolean;
}

// A safe, renderable event: secrets redacted, escape sequences neutralized, and
// raw detail bounded. `detailTruncated` reports whether bounding occurred.
export interface PresentedEvent {
  kind: EventKind;
  status: EventStatus;
  summary: string;
  detail: string;
  detailTruncated: boolean;
  elapsedMs: number;
  live: boolean;
}

// Neutralize unsafe terminal escape sequences and invisible characters while
// preserving legitimate whitespace (tab, newline, carriage return). Strips ANSI
// CSI sequences, other C0/C1 control characters, DEL, and zero-width /
// bidi-override characters so untrusted output cannot hijack the terminal.
export function neutralizeEscapes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

// Redact secrets then neutralize escapes in one pass, returning safe text.
function sanitize(text: string): string {
  return neutralizeEscapes(redactSecrets(text).text);
}

// True when the value is a canonical event kind.
export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

// True when the value is a canonical event status.
export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === "string" && (EVENT_STATUSES as readonly string[]).includes(value);
}

// Map a runtime event to its safe presentation. Throws on an unknown kind or
// status so a surface can never render a presentation-only value the contract
// does not define. Secrets are redacted, escape sequences neutralized, and raw
// detail bounded (with the truncation reported).
export function presentEvent(event: RuntimeEvent): PresentedEvent {
  if (!isEventKind(event.kind)) {
    throw new Error(`Event error: "${String(event.kind)}" is not a canonical event kind`);
  }
  if (!isEventStatus(event.status)) {
    throw new Error(`Event error: "${String(event.status)}" is not a canonical event status`);
  }
  const summary = sanitize(event.summary ?? "");
  const rawDetail = sanitize(event.detail ?? "");
  const detailTruncated = rawDetail.length > DETAIL_BOUND;
  const detail = detailTruncated ? `${rawDetail.slice(0, DETAIL_BOUND)}…` : rawDetail;
  const elapsedMs =
    typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)
      ? Math.max(0, Math.floor(event.elapsedMs))
      : 0;
  return {
    kind: event.kind,
    status: event.status,
    summary,
    detail,
    detailTruncated,
    elapsedMs,
    live: event.live === true,
  };
}

// The canonical model descriptor exposed to users and surfaces: the event kinds,
// the status values, and the runtime condition each status represents.
export interface ActivityModel {
  schema: string;
  version: number;
  kinds: EventKind[];
  statuses: EventStatus[];
  runtimeMapping: Record<EventStatus, string>;
  detailBound: number;
}

// Build the canonical model descriptor. Pure and side-effect-free.
export function collectActivityModel(): ActivityModel {
  return {
    schema: EVENT_PRESENTATION_SCHEMA,
    version: EVENT_PRESENTATION_VERSION,
    kinds: [...EVENT_KINDS],
    statuses: [...EVENT_STATUSES],
    runtimeMapping: { ...EVENT_STATUS_RUNTIME_MAPPING },
    detailBound: DETAIL_BOUND,
  };
}

// A redacted, human-readable rendering of the canonical model.
export function formatActivityModel(model: ActivityModel): string {
  const lines: string[] = [
    "Activity Event Presentation Model",
    "─".repeat(40),
    `Schema: ${model.schema} v${model.version}`,
    `Detail bound: ${model.detailBound} chars`,
    "",
    "Event kinds:",
    ...model.kinds.map((kind) => `  ${kind}`),
    "",
    "Statuses (status -> real runtime condition):",
    ...model.statuses.map((status) => `  ${status}: ${model.runtimeMapping[status]}`),
  ];
  return lines.join("\n");
}
