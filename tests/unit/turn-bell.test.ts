import { describe, it, expect } from "vitest";
import { TURN_BELL_BYTE, shouldRingTurnBell, ringTurnBell } from "../../src/turn-bell.js";

describe("turn bell decision (Issue #783)", () => {
  it("rings only when the flag is set AND the turn completed normally", () => {
    expect(shouldRingTurnBell(true, true)).toBe(true);
    expect(shouldRingTurnBell(true, false)).toBe(false);
    expect(shouldRingTurnBell(false, true)).toBe(false);
    expect(shouldRingTurnBell(false, false)).toBe(false);
  });

  it("stays silent when the flag is absent (off by default)", () => {
    expect(shouldRingTurnBell(undefined, true)).toBe(false);
    expect(shouldRingTurnBell(undefined, false)).toBe(false);
  });
});

describe("turn bell emission (Issue #783)", () => {
  it("exposes the BEL control byte", () => {
    expect(TURN_BELL_BYTE).toBe("\x07");
    expect(TURN_BELL_BYTE.length).toBe(1);
  });

  it("writes exactly one BEL byte through the provided writer", () => {
    const chunks: string[] = [];
    ringTurnBell((chunk) => chunks.push(chunk));
    expect(chunks).toEqual(["\x07"]);
  });
});
