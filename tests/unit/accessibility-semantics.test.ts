import { describe, it, expect } from "vitest";
import {
  buildAccessibilityProfile,
  renderStatusIndicator,
  screenReaderLabel,
  renderProgress,
  formatAccessibilityProfile,
} from "../../src/accessibility-semantics.js";

// Pure-function coverage for accessibility semantics (Issue #387):
// color roles, reduced-color, reduced-motion, screen-reader labels,
// contrast, and read-only guarantee.

// --- color roles ------------------------------------------------------------

describe("color roles", () => {
  it("defines all standard color roles", () => {
    const profile = buildAccessibilityProfile();
    const roles = profile.colors.map((c) => c.role);

    expect(roles).toContain("status-running");
    expect(roles).toContain("status-success");
    expect(roles).toContain("status-failure");
    expect(roles).toContain("status-waiting");
    expect(roles).toContain("emphasis");
    expect(roles).toContain("warning");
    expect(roles).toContain("error");
    expect(roles).toContain("muted");
    expect(profile.colors).toHaveLength(8);
  });

  it("each role has full color, glyph, contrast, and screen-reader label", () => {
    const profile = buildAccessibilityProfile();
    for (const color of profile.colors) {
      expect(color.fullColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(color.reducedGlyph.length).toBeGreaterThan(0);
      expect(color.contrastRatio).toBeGreaterThanOrEqual(4.5);
      expect(color.screenReaderLabel.length).toBeGreaterThan(0);
    }
  });
});

// --- reduced color ----------------------------------------------------------

describe("reduced color", () => {
  it("uses glyphs in reduced-color mode", () => {
    const profile = buildAccessibilityProfile({ reducedColor: true });
    const indicator = renderStatusIndicator("status-success", profile);
    expect(indicator).toBe("✓");
  });

  it("defaults to full color mode", () => {
    const profile = buildAccessibilityProfile();
    expect(profile.reducedColor).toBe(false);
  });
});

// --- reduced motion ---------------------------------------------------------

describe("reduced motion", () => {
  it("disables animations in reduced-motion mode", () => {
    const profile = buildAccessibilityProfile({ reducedMotion: true });
    expect(profile.motion.animationsEnabled).toBe(false);
  });

  it("shows static progress in reduced-motion mode", () => {
    const profile = buildAccessibilityProfile({ reducedMotion: true });
    const progress = renderProgress(50, profile);
    expect(progress).toBe(profile.motion.staticProgress);
  });

  it("shows animated progress when motion is enabled", () => {
    const profile = buildAccessibilityProfile({ reducedMotion: false });
    const progress = renderProgress(50, profile);
    expect(progress).toContain("=");
    expect(progress).toContain(">");
  });
});

// --- screen-reader labels ---------------------------------------------------

describe("screen-reader labels", () => {
  it("generates labels for activity states", () => {
    const profile = buildAccessibilityProfile();
    expect(screenReaderLabel("status-running", "Building project", profile)).toBe("Running: Building project");
    expect(screenReaderLabel("status-success", "Tests passed", profile)).toBe("Succeeded: Tests passed");
    expect(screenReaderLabel("status-failure", "Deploy failed", profile)).toBe("Failed: Deploy failed");
    expect(screenReaderLabel("warning", "Disk space low", profile)).toBe("Warning: Disk space low");
  });
});

// --- contrast fixtures ------------------------------------------------------

describe("contrast", () => {
  it("all roles meet minimum contrast ratio", () => {
    const profile = buildAccessibilityProfile();
    for (const color of profile.colors) {
      expect(color.contrastRatio).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// --- status indicators ------------------------------------------------------

describe("status indicators", () => {
  it("renders correct glyphs for each role", () => {
    const profile = buildAccessibilityProfile();
    expect(renderStatusIndicator("status-running", profile)).toBe("▶");
    expect(renderStatusIndicator("status-success", profile)).toBe("✓");
    expect(renderStatusIndicator("status-failure", profile)).toBe("✗");
    expect(renderStatusIndicator("status-waiting", profile)).toBe("○");
    expect(renderStatusIndicator("warning", profile)).toBe("⚠");
    expect(renderStatusIndicator("error", profile)).toBe("⛔");
  });

  it("returns ? for unknown roles", () => {
    const profile = buildAccessibilityProfile();
    expect(renderStatusIndicator("nonexistent" as any, profile)).toBe("?");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAccessibilityProfile", () => {
  it("renders profile with color roles and motion", () => {
    const profile = buildAccessibilityProfile({ reducedColor: true, reducedMotion: true });
    const output = formatAccessibilityProfile(profile);

    expect(output).toContain("Accessibility Semantics");
    expect(output).toContain("Reduced color: YES");
    expect(output).toContain("Reduced motion: YES");
    expect(output).toContain("status-running");
    expect(output).toContain("animations disabled");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("profile building does not modify defaults", () => {
    const p1 = buildAccessibilityProfile();
    const p2 = buildAccessibilityProfile({ reducedColor: true });

    expect(p1.reducedColor).toBe(false);
    expect(p2.reducedColor).toBe(true);
  });
});
