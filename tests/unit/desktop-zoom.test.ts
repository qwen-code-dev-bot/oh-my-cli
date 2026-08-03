import { describe, it, expect } from "vitest";
import {
  classifyZoomKey,
  stepZoomLevel,
  clampZoomLevel,
  zoomLevelForPercent,
  percentForLevel,
  ZOOM_LADDER,
  ZOOM_MIN_PERCENT,
  ZOOM_MAX_PERCENT,
  ZOOM_RESET_PERCENT,
} from "../../src/desktop/zoom.js";

type KeyInput = { key: string; code: string; control: boolean; meta: boolean };

function input(partial: Partial<KeyInput>): KeyInput {
  return { key: "", code: "", control: false, meta: false, ...partial };
}

describe("classifyZoomKey (Issue #523)", () => {
  it("zooms in on Ctrl/Cmd with either plus form, regardless of layout", () => {
    // The "=" key without Shift (US: produces "=").
    expect(classifyZoomKey(input({ key: "=", code: "Equal", control: true }))).toBe("zoom-in");
    // The shifted "+" (layouts where "+" needs Shift) — same physical key.
    expect(classifyZoomKey(input({ key: "+", code: "Equal", control: true }))).toBe("zoom-in");
    // The numpad add key.
    expect(classifyZoomKey(input({ key: "+", code: "NumpadAdd", control: true }))).toBe("zoom-in");
    // macOS Cmd.
    expect(classifyZoomKey(input({ key: "=", code: "Equal", meta: true }))).toBe("zoom-in");
  });

  it("zooms out on Ctrl/Cmd with either minus form, including the shifted underscore", () => {
    expect(classifyZoomKey(input({ key: "-", code: "Minus", control: true }))).toBe("zoom-out");
    // Shift held turns "-" into "_" on common layouts — must still zoom out
    // (the reported regression: SHIFT + CTRL + - did nothing).
    expect(classifyZoomKey(input({ key: "_", code: "Minus", control: true }))).toBe("zoom-out");
    expect(classifyZoomKey(input({ key: "-", code: "NumpadSubtract", control: true }))).toBe("zoom-out");
    expect(classifyZoomKey(input({ key: "-", code: "Minus", meta: true }))).toBe("zoom-out");
  });

  it("resets on Ctrl/Cmd + 0 (digit or numpad)", () => {
    expect(classifyZoomKey(input({ key: "0", code: "Digit0", control: true }))).toBe("zoom-reset");
    expect(classifyZoomKey(input({ key: "0", code: "Numpad0", control: true }))).toBe("zoom-reset");
    expect(classifyZoomKey(input({ key: "0", code: "Digit0", meta: true }))).toBe("zoom-reset");
  });

  it("ignores chords without Ctrl/Cmd and unrelated keys", () => {
    expect(classifyZoomKey(input({ key: "+", code: "Equal" }))).toBeNull();
    expect(classifyZoomKey(input({ key: "-", code: "Minus" }))).toBeNull();
    expect(classifyZoomKey(input({ key: "0", code: "Digit0" }))).toBeNull();
    expect(classifyZoomKey(input({ key: "k", code: "KeyK", control: true }))).toBeNull();
    expect(classifyZoomKey(input({ key: "n", code: "KeyN", control: true }))).toBeNull();
    expect(classifyZoomKey(input({ key: "Escape", code: "Escape", control: true }))).toBeNull();
  });
});

describe("zoom ladder (Issue #523)", () => {
  it("is bounded 50%–200% with 100% as a stop", () => {
    expect(ZOOM_LADDER[0]).toBe(ZOOM_MIN_PERCENT);
    expect(ZOOM_LADDER[ZOOM_LADDER.length - 1]).toBe(ZOOM_MAX_PERCENT);
    expect(ZOOM_LADDER).toContain(ZOOM_RESET_PERCENT);
  });

  it("maps levels to percents and back around 100%", () => {
    expect(zoomLevelForPercent(100)).toBe(0);
    expect(percentForLevel(0)).toBeCloseTo(100);
    expect(percentForLevel(zoomLevelForPercent(150))).toBeCloseTo(150);
  });

  it("steps up and down the ladder from 100%", () => {
    const zero = zoomLevelForPercent(100);
    const up = stepZoomLevel(zero, "zoom-in");
    expect(percentForLevel(up)).toBeCloseTo(110);
    const down = stepZoomLevel(zero, "zoom-out");
    expect(percentForLevel(down)).toBeCloseTo(90);
  });

  it("clamps at the ladder ends without error", () => {
    const max = zoomLevelForPercent(ZOOM_MAX_PERCENT);
    const beyond = stepZoomLevel(max, "zoom-in");
    expect(percentForLevel(beyond)).toBeCloseTo(ZOOM_MAX_PERCENT);

    const min = zoomLevelForPercent(ZOOM_MIN_PERCENT);
    const below = stepZoomLevel(min, "zoom-out");
    expect(percentForLevel(below)).toBeCloseTo(ZOOM_MIN_PERCENT);
  });

  it("resets to exactly 100% from any level", () => {
    for (const percent of [50, 90, 125, 200]) {
      const level = zoomLevelForPercent(percent);
      expect(stepZoomLevel(level, "zoom-reset")).toBe(0);
    }
  });

  it("snaps an off-ladder level to the nearest rung before stepping", () => {
    // A level at ~104% sits between the 100 and 110 rungs, closer to 100.
    const off = zoomLevelForPercent(104);
    expect(percentForLevel(stepZoomLevel(off, "zoom-in"))).toBeCloseTo(110);
    expect(percentForLevel(stepZoomLevel(off, "zoom-out"))).toBeCloseTo(90);
  });
});

describe("clampZoomLevel (Issue #532)", () => {
  it("keeps in-bounds levels unchanged", () => {
    expect(clampZoomLevel(0)).toBe(0);
    const mid = zoomLevelForPercent(125);
    expect(clampZoomLevel(mid)).toBeCloseTo(mid);
  });

  it("clamps out-of-range levels into the ladder bounds", () => {
    expect(percentForLevel(clampZoomLevel(zoomLevelForPercent(400)))).toBeCloseTo(
      ZOOM_MAX_PERCENT,
    );
    expect(percentForLevel(clampZoomLevel(zoomLevelForPercent(10)))).toBeCloseTo(
      ZOOM_MIN_PERCENT,
    );
  });

  it("reads non-finite input as the 100% level", () => {
    expect(clampZoomLevel(Number.NaN)).toBe(zoomLevelForPercent(ZOOM_RESET_PERCENT));
    expect(clampZoomLevel(Number.POSITIVE_INFINITY)).toBe(
      zoomLevelForPercent(ZOOM_RESET_PERCENT),
    );
    expect(clampZoomLevel(Number.NEGATIVE_INFINITY)).toBe(
      zoomLevelForPercent(ZOOM_RESET_PERCENT),
    );
  });
});
