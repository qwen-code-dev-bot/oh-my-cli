import { describe, it, expect } from "vitest";
import {
  detectConflicts,
  detectUnsafeDefaults,
  detectUnknownCommands,
  validateBindings,
  formatValidationResult,
  formatBindings,
  type KeyBinding,
} from "../../src/keybinding-model.js";

// Pure-function coverage for the keybinding model (Issue #360): conflict
// detection, unsafe defaults, unknown commands, safe customization, and
// read-only guarantee.

function binding(key: string, commandId: string, overrides: Partial<KeyBinding> = {}): KeyBinding {
  return { key, commandId, source: "default", ...overrides };
}

const KNOWN_COMMANDS = new Set(["session.export", "diff.navigate", "model.select", "goal.inspect"]);

// --- conflict detection -----------------------------------------------------

describe("conflict detection", () => {
  it("detects same key bound to different commands", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+d", "session.export"),
    ];

    const conflicts = detectConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a.commandId).toBe("diff.navigate");
    expect(conflicts[0].b.commandId).toBe("session.export");
  });

  it("normalizes key order for comparison", () => {
    const bindings = [
      binding("ctrl+shift+e", "session.export"),
      binding("shift+ctrl+e", "model.select"),
    ];

    const conflicts = detectConflicts(bindings);
    expect(conflicts).toHaveLength(1);
  });

  it("does not flag different keys", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+e", "session.export"),
    ];

    expect(detectConflicts(bindings)).toHaveLength(0);
  });

  it("does not flag non-overlapping when-clauses", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate", { when: "inDiffView" }),
      binding("ctrl+d", "session.export", { when: "inSessionView" }),
    ];

    expect(detectConflicts(bindings)).toHaveLength(0);
  });

  it("flags overlapping when-clauses", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate", { when: "inDiffView" }),
      binding("ctrl+d", "session.export", { when: "inDiffView" }),
    ];

    expect(detectConflicts(bindings)).toHaveLength(1);
  });

  it("flags undefined when-clause as always overlapping", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+d", "session.export", { when: "inDiffView" }),
    ];

    expect(detectConflicts(bindings)).toHaveLength(1);
  });
});

// --- unsafe defaults --------------------------------------------------------

describe("unsafe defaults", () => {
  it("rejects single-keystroke defaults without modifiers", () => {
    const bindings = [binding("x", "session.export")];
    const unsafe = detectUnsafeDefaults(bindings);
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0].detail).toContain("single keystroke");
  });

  it("allows single-keystroke with modifier", () => {
    const bindings = [binding("ctrl+x", "session.export")];
    expect(detectUnsafeDefaults(bindings)).toHaveLength(0);
  });

  it("allows multi-key without modifier", () => {
    const bindings = [binding("g g", "diff.navigate")];
    // "g g" has a space, so split("+") gives ["g g"] which is one part.
    // This is a sequence, not a single keystroke.
    expect(detectUnsafeDefaults(bindings)).toHaveLength(0);
  });

  it("ignores custom bindings", () => {
    const bindings = [binding("x", "session.export", { source: "custom" })];
    expect(detectUnsafeDefaults(bindings)).toHaveLength(0);
  });
});

// --- unknown commands -------------------------------------------------------

describe("unknown commands", () => {
  it("detects unregistered command ids", () => {
    const bindings = [binding("ctrl+x", "nonexistent.command")];
    const unknown = detectUnknownCommands(bindings, KNOWN_COMMANDS);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].detail).toContain("not registered");
  });

  it("passes known command ids", () => {
    const bindings = [binding("ctrl+d", "diff.navigate")];
    expect(detectUnknownCommands(bindings, KNOWN_COMMANDS)).toHaveLength(0);
  });
});

// --- full validation --------------------------------------------------------

describe("validateBindings", () => {
  it("reports all issue types together", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+d", "session.export"), // conflict
      binding("x", "model.select"),          // unsafe default
      binding("ctrl+z", "unknown.cmd"),      // unknown command
    ];

    const result = validateBindings(bindings, KNOWN_COMMANDS);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "conflict")).toBe(true);
    expect(result.issues.some((i) => i.type === "unsafe-default")).toBe(true);
    expect(result.issues.some((i) => i.type === "unknown-command")).toBe(true);
  });

  it("reports valid for clean bindings", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+e", "session.export"),
      binding("ctrl+m", "model.select"),
    ];

    const result = validateBindings(bindings, KNOWN_COMMANDS);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// --- safe customization fixture ---------------------------------------------

describe("safe customization", () => {
  it("validates a safe custom binding without error", () => {
    const bindings = [
      binding("ctrl+shift+d", "diff.navigate", { source: "custom" }),
    ];

    const result = validateBindings(bindings, KNOWN_COMMANDS);
    expect(result.valid).toBe(true);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatValidationResult", () => {
  it("renders clean result", () => {
    const result = validateBindings([binding("ctrl+d", "diff.navigate")], KNOWN_COMMANDS);
    const output = formatValidationResult(result);
    expect(output).toContain("No conflicts");
    expect(output).toContain("Read-only");
  });

  it("renders issues", () => {
    const result = validateBindings([
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+d", "session.export"),
    ], KNOWN_COMMANDS);
    const output = formatValidationResult(result);
    expect(output).toContain("CONFLICT");
  });
});

describe("formatBindings", () => {
  it("renders binding table", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+e", "session.export", { source: "custom", when: "inSession" }),
    ];
    const output = formatBindings(bindings);
    expect(output).toContain("ctrl+d → diff.navigate [default]");
    expect(output).toContain("ctrl+e → session.export [custom] when:inSession");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("validation does not mutate bindings", () => {
    const bindings = [
      binding("ctrl+d", "diff.navigate"),
      binding("ctrl+d", "session.export"),
    ];
    const before = JSON.stringify(bindings);
    validateBindings(bindings, KNOWN_COMMANDS);
    expect(JSON.stringify(bindings)).toBe(before);
  });
});
