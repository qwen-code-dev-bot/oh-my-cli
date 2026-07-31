// Activity rendering: render the #306 presented activity event stream as
// progressive-disclosure cards for the mission-control TUI view (Issue #307, the
// TUI activity-rendering child of #291). Each card shows a status glyph, the
// event kind, its summary, elapsed time, and a liveness marker; expanding a card
// reveals its bounded detail. The rendering is a pure function of the presented
// events plus a small view state (which cards are expanded, follow-mode, and an
// unread count), so the same events and view state always render the same view,
// and expanding/collapsing never loses the underlying events.
//
// This module returns plain text lines (no ANSI); the TUI panel in tui-shell.ts
// applies color/style around them, exactly as the mission lifecycle (#314) and
// background-task panels style their bodies. Keeping rendering pure and
// style-free makes it unit-testable against fixture event streams and reusable by
// the Desktop canvas (#318). Reduced-color/no-color degrades to the glyphs and
// plain text without losing information.
//
// Trust boundary: the rendering reads only already-presented events (sanitized by
// the #306 mapper); it executes nothing and adds no untrusted content.

import type { PresentedEvent, EventStatus } from "./event-presentation.js";

// A stable glyph per activity status, so a card communicates status at a glance
// without relying on color alone.
const STATUS_GLYPHS: Record<EventStatus, string> = {
  pending: "○",
  active: "◆",
  completed: "✓",
  failed: "✕",
  waiting: "◇",
  cancelled: "⊘",
};

export function activityGlyph(status: EventStatus): string {
  return STATUS_GLYPHS[status] ?? "?";
}

// Compact human elapsed time: seconds under a minute, minutes under an hour,
// hours otherwise.
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

// A liveness marker: a filled dot while the event is live, blank otherwise.
export function livenessMarker(live: boolean): string {
  return live ? "●" : "·";
}

// Render one activity card. Collapsed shows a single summary line; expanded adds
// the bounded detail (with a truncation note when the #306 mapper bounded it).
export function renderActivityCard(event: PresentedEvent, expanded: boolean): string[] {
  const summary = event.summary || event.kind;
  const head = `${activityGlyph(event.status)} ${event.kind} · ${summary} · ${formatElapsed(
    event.elapsedMs,
  )} ${livenessMarker(event.live)} ${event.status}`;
  if (!expanded) return [head];
  const detail = event.detail === "" ? ["  (no detail)"] : event.detail.split("\n").map((l) => `  ${l}`);
  const truncated = event.detailTruncated ? ["  … (detail truncated)"] : [];
  return [head, ...detail, ...truncated];
}

// The activity view state: which card indices are expanded, whether follow-mode
// is on (auto-track the latest event), and how many events arrived since the view
// was last read. Immutable; transitions return new states.
export interface ActivityViewState {
  expanded: ReadonlySet<number>;
  followMode: boolean;
  unread: number;
}

export function initialActivityViewState(): ActivityViewState {
  return { expanded: new Set<number>(), followMode: true, unread: 0 };
}

// Toggle whether one card index is expanded.
export function toggleExpand(state: ActivityViewState, index: number): ActivityViewState {
  const expanded = new Set(state.expanded);
  if (expanded.has(index)) expanded.delete(index);
  else expanded.add(index);
  return { ...state, expanded };
}

// Expand every card (when count > 0 and not all already expanded) or collapse all
// otherwise — a simple toggle-all for the panel's expand/collapse gesture.
export function toggleExpandAll(state: ActivityViewState, count: number): ActivityViewState {
  const allExpanded = count > 0 && state.expanded.size >= count;
  const expanded = allExpanded ? new Set<number>() : new Set<number>(Array.from({ length: count }, (_, i) => i));
  return { ...state, expanded };
}

export function setFollowMode(state: ActivityViewState, on: boolean): ActivityViewState {
  return { ...state, followMode: on };
}

export function markRead(state: ActivityViewState): ActivityViewState {
  return { ...state, unread: 0 };
}

export function bumpUnread(state: ActivityViewState, n: number): ActivityViewState {
  return { ...state, unread: state.unread + Math.max(0, Math.floor(n)) };
}

// Render the whole activity stream as progressive-disclosure cards (in event
// order), expanding the cards whose indices are in the view state. Empty stream
// renders a single placeholder line.
export function renderActivityStream(
  events: readonly PresentedEvent[],
  state: ActivityViewState,
): string[] {
  if (events.length === 0) return ["(no activity)"];
  const lines: string[] = [];
  events.forEach((event, index) => {
    lines.push(...renderActivityCard(event, state.expanded.has(index)));
  });
  return lines;
}

// Render the full read-only activity view: a header (counts + follow-mode +
// unread), the card stream, and a hint line. Pure and deterministic.
export function formatActivityView(
  events: readonly PresentedEvent[],
  state: ActivityViewState,
): string[] {
  const active = events.filter((e) => e.live).length;
  const header =
    `Activity (read-only) · events ${events.length} · live ${active} · ` +
    `follow ${state.followMode ? "on" : "off"} · unread ${state.unread}`;
  return [header, "", ...renderActivityStream(events, state)];
}
