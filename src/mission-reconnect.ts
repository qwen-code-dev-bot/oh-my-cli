// Mission reconnect: reconstruct the mission lifecycle view from durable state.
// When a session disconnects and reconnects, the view is rebuilt by replaying the
// durable event log through the #313 lifecycle projection — never from cached or
// simulated state. This is the reconnect child of the mission-control roadmap
// (Issue #297); it relies on the #313 reducer being pure and deterministic and is
// what lets a reconnected surface show the mission exactly as durable events
// determine, without rewriting history.
//
// Three guarantees, all pinned by tests:
//   1. deterministic-replay     — the same durable log always reconstructs the
//                                 same model, so two reconnects agree.
//   2. no-history-rewrite       — the log is replayed exactly as given; reconnect
//                                 adds, removes, or reorders no event, and
//                                 splitting the log at any point then replaying
//                                 prefix-then-suffix equals a full replay.
//   3. incremental-continuation — a checkpoint model plus only the events after
//                                 the checkpoint reconstructs the same model as a
//                                 full replay, so reconnect need not replay
//                                 everything.
//
// Trust boundary: reconnect is a pure fold over the durable log; it executes
// nothing, invents no event, and carries no secrets.

import type { LifecycleModel, LifecycleEvent } from "./lifecycle-projection.js";
import { replayEvents, reduceEvent, LIFECYCLE_EVENT_TYPES } from "./lifecycle-projection.js";

export const MISSION_RECONNECT_SCHEMA = "oh-my-cli.mission-reconnect";
export const MISSION_RECONNECT_VERSION = 1;

// The reconnect guarantees this module provides.
export const RECONNECT_GUARANTEES = [
  "deterministic-replay",
  "no-history-rewrite",
  "incremental-continuation",
] as const;
export type ReconnectGuarantee = (typeof RECONNECT_GUARANTEES)[number];

// The result of reconstructing a mission view from a durable event log.
export interface ReconnectResult {
  schema: string;
  version: number;
  model: LifecycleModel;
  eventsReplayed: number;
}

// Reconstruct the mission lifecycle view from a durable event log by replaying it
// through the #313 projection. Deterministic and append-only: the log is replayed
// exactly as given (no event added, removed, or reordered).
export function reconnect(durableLog: readonly LifecycleEvent[]): ReconnectResult {
  const model = replayEvents(durableLog);
  return {
    schema: MISSION_RECONNECT_SCHEMA,
    version: MISSION_RECONNECT_VERSION,
    model,
    eventsReplayed: durableLog.length,
  };
}

// Continue a reconstructed mission from a checkpoint model by applying only the
// events that occurred after the checkpoint, without replaying the whole log.
// By the incremental-continuation guarantee, reconnectIncremental(replay(prefix),
// suffix) equals replay(prefix ++ suffix) (pinned by tests).
export function reconnectIncremental(
  checkpoint: LifecycleModel,
  laterEvents: readonly LifecycleEvent[],
): LifecycleModel {
  return laterEvents.reduce(reduceEvent, checkpoint);
}

// True when reconstructing from a split log (replay the prefix, then continue
// with the suffix) yields exactly the same model as a full replay of the whole
// log — the no-history-rewrite and incremental-continuation guarantees combined.
export function splitReconnectIsConsistent(
  durableLog: readonly LifecycleEvent[],
  splitAt: number,
): boolean {
  const index = Math.max(0, Math.min(splitAt, durableLog.length));
  const prefix = durableLog.slice(0, index);
  const suffix = durableLog.slice(index);
  const full = replayEvents(durableLog);
  const viaCheckpoint = reconnectIncremental(replayEvents(prefix), suffix);
  return JSON.stringify(viaCheckpoint) === JSON.stringify(full);
}

// The static reconnect contract exposed to users and surfaces: the guarantees
// provided and the durable event types replayed. Fixed metadata.
export interface ReconnectDescriptor {
  schema: string;
  version: number;
  guarantees: readonly ReconnectGuarantee[];
  replayedEventTypes: readonly string[];
}

// Build the static descriptor. Pure and side-effect-free.
export function collectReconnectDescriptor(): ReconnectDescriptor {
  return {
    schema: MISSION_RECONNECT_SCHEMA,
    version: MISSION_RECONNECT_VERSION,
    guarantees: [...RECONNECT_GUARANTEES],
    replayedEventTypes: [...LIFECYCLE_EVENT_TYPES],
  };
}

// A redacted, human-readable rendering of the static descriptor.
export function formatReconnectDescriptor(descriptor: ReconnectDescriptor): string {
  return [
    "Mission Reconnect Contract",
    "─".repeat(40),
    `Schema: ${descriptor.schema} v${descriptor.version}`,
    `Guarantees: ${descriptor.guarantees.join(" · ")}`,
    `Replayed event types: ${descriptor.replayedEventTypes.join(" · ")}`,
  ].join("\n");
}
