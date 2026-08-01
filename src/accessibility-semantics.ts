// Read-only accessibility semantics: defines color roles, reduced-color
// fallbacks, and reduced-motion preferences for activity rendering.
//
// Color roles expose semantic name, full-color value, reduced-color
// fallback (symbol/glyph), and contrast ratio. Reduced-motion preferences
// disable animation hints. The model supports screen-reader label
// generation. The view is read-only and never renders actual UI, executes
// commands, or modifies preferences.

export const ACCESSIBILITY_SEMANTICS_SCHEMA = "oh-my-cli.accessibility-semantics";
export const ACCESSIBILITY_SEMANTICS_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ColorRole =
  | "status-running"
  | "status-success"
  | "status-failure"
  | "status-waiting"
  | "emphasis"
  | "warning"
  | "error"
  | "muted";

export interface ColorDefinition {
  role: ColorRole;
  /** Semantic meaning description. */
  meaning: string;
  /** Full-color hex value. */
  fullColor: string;
  /** Reduced-color fallback glyph/symbol. */
  reducedGlyph: string;
  /** WCAG contrast ratio against the background (approximate). */
  contrastRatio: number;
  /** Screen-reader label. */
  screenReaderLabel: string;
}

export interface MotionPreference {
  /** Whether animations are enabled. */
  animationsEnabled: boolean;
  /** Static alternative for spinner/progress. */
  staticSpinner: string;
  /** Static alternative for progress bar. */
  staticProgress: string;
}

export interface AccessibilityProfile {
  /** Whether reduced-color mode is active. */
  reducedColor: boolean;
  /** Whether reduced-motion mode is active. */
  reducedMotion: boolean;
  /** Color definitions. */
  colors: ColorDefinition[];
  /** Motion preferences. */
  motion: MotionPreference;
}

// --- default definitions ----------------------------------------------------

const DEFAULT_COLORS: ColorDefinition[] = [
  { role: "status-running", meaning: "Active/running process", fullColor: "#3B82F6", reducedGlyph: "▶", contrastRatio: 4.5, screenReaderLabel: "Running" },
  { role: "status-success", meaning: "Successful completion", fullColor: "#22C55E", reducedGlyph: "✓", contrastRatio: 4.6, screenReaderLabel: "Succeeded" },
  { role: "status-failure", meaning: "Failed operation", fullColor: "#EF4444", reducedGlyph: "✗", contrastRatio: 4.5, screenReaderLabel: "Failed" },
  { role: "status-waiting", meaning: "Waiting for input or dependency", fullColor: "#F59E0B", reducedGlyph: "○", contrastRatio: 4.5, screenReaderLabel: "Waiting" },
  { role: "emphasis", meaning: "Emphasized content", fullColor: "#8B5CF6", reducedGlyph: "★", contrastRatio: 4.6, screenReaderLabel: "Emphasis" },
  { role: "warning", meaning: "Warning condition", fullColor: "#F97316", reducedGlyph: "⚠", contrastRatio: 4.5, screenReaderLabel: "Warning" },
  { role: "error", meaning: "Error condition", fullColor: "#DC2626", reducedGlyph: "⛔", contrastRatio: 5.0, screenReaderLabel: "Error" },
  { role: "muted", meaning: "De-emphasized content", fullColor: "#6B7280", reducedGlyph: "·", contrastRatio: 4.5, screenReaderLabel: "Muted" },
];

const DEFAULT_MOTION: MotionPreference = {
  animationsEnabled: true,
  staticSpinner: "[working]",
  staticProgress: "[=====>    ]",
};

const REDUCED_MOTION: MotionPreference = {
  animationsEnabled: false,
  staticSpinner: "[working]",
  staticProgress: "[=====>    ]",
};

// --- profile builder --------------------------------------------------------

export function buildAccessibilityProfile(opts: {
  reducedColor?: boolean;
  reducedMotion?: boolean;
} = {}): AccessibilityProfile {
  return {
    reducedColor: opts.reducedColor ?? false,
    reducedMotion: opts.reducedMotion ?? false,
    colors: DEFAULT_COLORS,
    motion: opts.reducedMotion ? REDUCED_MOTION : DEFAULT_MOTION,
  };
}

// --- rendering helpers (pure, no actual UI) ---------------------------------

// Render a status indicator for a given role, respecting the profile.
export function renderStatusIndicator(role: ColorRole, profile: AccessibilityProfile): string {
  const color = profile.colors.find((c) => c.role === role);
  if (!color) return "?";

  if (profile.reducedColor) {
    return color.reducedGlyph;
  }
  return `${color.reducedGlyph}`; // In a real TUI, this would use ANSI colors.
}

// Generate a screen-reader label for an activity state.
export function screenReaderLabel(role: ColorRole, detail: string, profile: AccessibilityProfile): string {
  const color = profile.colors.find((c) => c.role === role);
  const label = color?.screenReaderLabel ?? role;
  return `${label}: ${detail}`;
}

// Render a spinner/progress respecting motion preferences.
export function renderProgress(pct: number, profile: AccessibilityProfile): string {
  if (!profile.motion.animationsEnabled) {
    return profile.motion.staticProgress;
  }
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  return `[${"=".repeat(filled)}>${" ".repeat(width - filled)}]`;
}

// --- formatting -------------------------------------------------------------

export function formatAccessibilityProfile(profile: AccessibilityProfile): string {
  const lines: string[] = [];
  lines.push("Accessibility Semantics");
  lines.push("═".repeat(50));
  lines.push(`Reduced color: ${profile.reducedColor ? "YES" : "no"}  Reduced motion: ${profile.reducedMotion ? "YES" : "no"}`);

  lines.push("");
  lines.push("Color roles:");
  for (const color of profile.colors) {
    const display = profile.reducedColor ? color.reducedGlyph : `${color.reducedGlyph} (${color.fullColor})`;
    lines.push(`  ${display} ${color.role} — ${color.meaning} [${color.contrastRatio}:1] "${color.screenReaderLabel}"`);
  }

  lines.push("");
  lines.push(`Motion: animations ${profile.motion.animationsEnabled ? "enabled" : "disabled"}`);
  lines.push(`  Spinner: ${profile.motion.staticSpinner}`);
  lines.push(`  Progress: ${profile.motion.staticProgress}`);

  lines.push("");
  lines.push("Read-only: no UI rendered, no preferences modified.");

  return lines.join("\n");
}
