import { describe, it, expect } from "vitest";
import {
  staleSessionsStrictExit,
  STALE_SESSIONS_SCHEMA,
  STALE_SESSIONS_VERSION,
  type StaleSessionsRecord,
  type StaleSessionCandidate,
} from "../../src/stale-sessions.js";

function candidate(): StaleSessionCandidate {
  return {
    sessionId: "stale-src",
    shortId: "stale",
    name: null,
    ageMs: 40 * 24 * 60 * 60 * 1000,
    ageLabel: "40d",
    messages: 3,
    notes: 0,
  };
}

function record(
  overrides: Partial<
    Pick<
      StaleSessionsRecord,
      "totalSessions" | "candidates" | "protectedPinned" | "protectedArchived"
    >
  > = {},
): StaleSessionsRecord {
  return {
    schema: STALE_SESSIONS_SCHEMA,
    v: STALE_SESSIONS_VERSION,
    thresholdDays: 30,
    totalSessions: overrides.totalSessions ?? 0,
    candidates: overrides.candidates ?? [],
    protectedPinned: overrides.protectedPinned ?? 0,
    protectedArchived: overrides.protectedArchived ?? 0,
  };
}

describe("staleSessionsStrictExit (Issue #680)", () => {
  it("maps archive candidates present to exit 1", () => {
    expect(
      staleSessionsStrictExit(record({ totalSessions: 2, candidates: [candidate()] })),
    ).toBe(1);
  });

  it("maps a record with no candidates to exit 0", () => {
    expect(staleSessionsStrictExit(record({ totalSessions: 2 }))).toBe(0);
  });

  it("maps a protected-only record (pinned/archived) to exit 0", () => {
    expect(
      staleSessionsStrictExit(
        record({ totalSessions: 2, protectedPinned: 1, protectedArchived: 1 }),
      ),
    ).toBe(0);
  });

  it("maps an empty record to exit 0", () => {
    expect(staleSessionsStrictExit(record())).toBe(0);
  });

  it("is a pure, stable mapping", () => {
    const failing = record({ totalSessions: 1, candidates: [candidate()] });
    expect(staleSessionsStrictExit(failing)).toBe(staleSessionsStrictExit(failing));
    const clean = record({ totalSessions: 1 });
    expect(staleSessionsStrictExit(clean)).toBe(staleSessionsStrictExit(clean));
  });
});
