// Layout-independent Desktop zoom (Issue #523, community report #521).
//
// Zoom previously relied entirely on Electron/Chromium defaults, whose
// accelerators are layout- and Shift-state-dependent: producing "+" requires
// Shift on common layouts, and holding Shift turns "-" into "_", so zoom-in
// needed Shift while zoom-out broke with Shift held. This module makes zoom a
// product behavior: a pure classifier decides the zoom intent from a key input
// regardless of Shift state or layout (character forms and physical codes),
// and a bounded ladder maps intent to Chromium zoom levels between 50% and
// 200% with 100% as the reset.

export type ZoomDecision = "zoom-in" | "zoom-out" | "zoom-reset";

// The subset of Electron's before-input-event input this module needs. Note
// the modifier field names follow Electron's `Input` shape (`control`/`meta`),
// not the DOM's `ctrlKey`/`metaKey`.
export interface ZoomKeyInput {
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
}

export const ZOOM_MIN_PERCENT = 50;
export const ZOOM_MAX_PERCENT = 200;
export const ZOOM_RESET_PERCENT = 100;

// Deterministic zoom stops between the bounds. Steps are denser around 100%
// where fine control matters most.
export const ZOOM_LADDER: readonly number[] = [
  50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200,
];

// Chromium zoom levels are multiplicative (factor 1.2 per level, 0 = 100%).
export function zoomLevelForPercent(percent: number): number {
  return Math.log(percent / 100) / Math.log(1.2);
}

export function percentForLevel(level: number): number {
  return 100 * Math.pow(1.2, level);
}

// The ladder stop nearest to a current zoom level (ties round toward 100% by
// construction of the ladder). Pure and deterministic.
function nearestRungIndex(level: number): number {
  const pct = percentForLevel(level);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ZOOM_LADDER.length; i++) {
    const distance = Math.abs(ZOOM_LADDER[i] - pct);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

// One zoom step from the current level in the given direction, clamped to the
// ladder bounds: stepping past the ends stays on the end stop, and reset
// returns the 100% level. Pure and deterministic.
export function stepZoomLevel(currentLevel: number, decision: ZoomDecision): number {
  if (decision === "zoom-reset") {
    return zoomLevelForPercent(ZOOM_RESET_PERCENT);
  }
  const index = nearestRungIndex(currentLevel);
  const next =
    decision === "zoom-in"
      ? Math.min(index + 1, ZOOM_LADDER.length - 1)
      : Math.max(index - 1, 0);
  return zoomLevelForPercent(ZOOM_LADDER[next]);
}

// Classify a key input into a zoom decision. Requires Ctrl (or Cmd on macOS)
// and matches both the character the layout produced and the physical key, so
// the result does not depend on Shift state or layout: "=" and "+" both zoom
// in, "-" and "_" both zoom out, and numpad add/subtract work too. Anything
// else is not a zoom chord.
export function classifyZoomKey(input: ZoomKeyInput): ZoomDecision | null {
  if (!input.control && !input.meta) return null;
  const key = input.key;
  const code = input.code;
  if (key === "+" || key === "=" || code === "NumpadAdd" || code === "Equal") {
    return "zoom-in";
  }
  if (key === "-" || key === "_" || code === "NumpadSubtract" || code === "Minus") {
    return "zoom-out";
  }
  if (key === "0" || code === "Numpad0" || code === "Digit0") {
    return "zoom-reset";
  }
  return null;
}
