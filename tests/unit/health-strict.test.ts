import { describe, it, expect } from "vitest";
import {
  healthReportStrictExit,
  SESSION_HEALTH_SCHEMA,
  SESSION_HEALTH_VERSION,
  type SessionHealthRecord,
} from "../../src/session-health.js";

function record(
  overrides: Partial<
    Pick<SessionHealthRecord, "sessionCount" | "counts" | "sessionsWithDamagedSidecars">
  > = {},
): SessionHealthRecord {
  return {
    schema: SESSION_HEALTH_SCHEMA,
    v: SESSION_HEALTH_VERSION,
    sessionCount: overrides.sessionCount ?? 0,
    counts: overrides.counts ?? { ok: 0, partial: 0, corrupt: 0 },
    sessionsWithDamagedSidecars: overrides.sessionsWithDamagedSidecars ?? 0,
    sessions: [],
  };
}

describe("healthReportStrictExit (Issue #678)", () => {
  it("maps a clean report to exit 0", () => {
    expect(
      healthReportStrictExit(
        record({ sessionCount: 2, counts: { ok: 2, partial: 0, corrupt: 0 } }),
      ),
    ).toBe(0);
  });

  it("maps corrupt transcripts present to exit 1", () => {
    expect(
      healthReportStrictExit(
        record({ sessionCount: 3, counts: { ok: 2, partial: 0, corrupt: 1 } }),
      ),
    ).toBe(1);
  });

  it("maps damaged sidecars present to exit 1", () => {
    expect(
      healthReportStrictExit(
        record({
          sessionCount: 2,
          counts: { ok: 2, partial: 0, corrupt: 0 },
          sessionsWithDamagedSidecars: 1,
        }),
      ),
    ).toBe(1);
  });

  it("maps both damage classes present to exit 1", () => {
    expect(
      healthReportStrictExit(
        record({
          sessionCount: 2,
          counts: { ok: 0, partial: 1, corrupt: 1 },
          sessionsWithDamagedSidecars: 1,
        }),
      ),
    ).toBe(1);
  });

  it("maps a partial-only report to exit 0", () => {
    expect(
      healthReportStrictExit(
        record({ sessionCount: 2, counts: { ok: 1, partial: 1, corrupt: 0 } }),
      ),
    ).toBe(0);
  });

  it("maps an empty report to exit 0", () => {
    expect(healthReportStrictExit(record())).toBe(0);
  });

  it("is a pure, stable mapping", () => {
    const damaged = record({
      sessionCount: 1,
      counts: { ok: 0, partial: 0, corrupt: 1 },
    });
    expect(healthReportStrictExit(damaged)).toBe(healthReportStrictExit(damaged));
    const clean = record({ sessionCount: 1, counts: { ok: 1, partial: 0, corrupt: 0 } });
    expect(healthReportStrictExit(clean)).toBe(healthReportStrictExit(clean));
  });
});
