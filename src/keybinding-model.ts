// Read-only keybinding model: detects conflicts, validates customization
// safety, and reports actionable resolution guidance.
//
// Keybinding entries map key sequences to command identifiers with optional
// when-clauses. Conflicting bindings are detected and reported as pairs.
// Destructive single-keystroke defaults are rejected. Custom bindings
// validate against the command registry. The model is read-only and never
// executes a command or modifies a keymap file.

export const KEYBINDING_MODEL_SCHEMA = "oh-my-cli.keybinding-model";
export const KEYBINDING_MODEL_VERSION = 1;

// --- keybinding entries -----------------------------------------------------

export interface KeyBinding {
  /** Key sequence (e.g. "ctrl+shift+e", "ctrl+d"). */
  key: string;
  /** Command identifier from the registry. */
  commandId: string;
  /** Optional when-clause for conditional activation. */
  when?: string;
  /** Whether this is a default or user-customized binding. */
  source: "default" | "custom";
}

// --- validation results -----------------------------------------------------

export type ValidationIssue =
  | { type: "conflict"; bindingA: KeyBinding; bindingB: KeyBinding; detail: string }
  | { type: "unsafe-default"; binding: KeyBinding; detail: string }
  | { type: "unknown-command"; binding: KeyBinding; detail: string };

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// --- conflict detection -----------------------------------------------------

// Detect conflicting bindings: same key sequence with overlapping
// when-clauses (or no when-clause, which means always active).
export function detectConflicts(bindings: KeyBinding[]): Array<{ a: KeyBinding; b: KeyBinding; detail: string }> {
  const conflicts: Array<{ a: KeyBinding; b: KeyBinding; detail: string }> = [];

  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i];
      const b = bindings[j];

      if (normalizeKey(a.key) !== normalizeKey(b.key)) continue;
      if (!whenClausesOverlap(a.when, b.when)) continue;

      conflicts.push({
        a,
        b,
        detail: `Key "${a.key}" is bound to both "${a.commandId}" and "${b.commandId}"${a.when || b.when ? " with overlapping conditions" : ""}`,
      });
    }
  }

  return conflicts;
}

// Normalize a key sequence for comparison: lowercase, sort modifiers.
function normalizeKey(key: string): string {
  const parts = key.toLowerCase().split("+").map((p) => p.trim());
  const modifiers = parts.filter((p) => ["ctrl", "shift", "alt", "meta", "cmd"].includes(p)).sort();
  const keys = parts.filter((p) => !["ctrl", "shift", "alt", "meta", "cmd"].includes(p));
  return [...modifiers, ...keys].join("+");
}

// Two when-clauses overlap if either is undefined (always active) or they
// are equal. Different non-empty when-clauses are considered non-overlapping.
function whenClausesOverlap(a?: string, b?: string): boolean {
  if (a === undefined || b === undefined) return true;
  return a === b;
}

// --- unsafe default detection -----------------------------------------------

// Destructive single-keystroke defaults are unsafe: a single character
// without modifiers can trigger accidental actions.
export function detectUnsafeDefaults(bindings: KeyBinding[]): Array<{ binding: KeyBinding; detail: string }> {
  const unsafe: Array<{ binding: KeyBinding; detail: string }> = [];

  for (const binding of bindings) {
    if (binding.source !== "default") continue;
    // Space-separated sequences (e.g. "g g") are multi-keystroke, not single.
    if (binding.key.includes(" ")) continue;
    const parts = binding.key.toLowerCase().split("+");
    const hasModifier = parts.some((p) => ["ctrl", "shift", "alt", "meta", "cmd"].includes(p));
    if (!hasModifier && parts.length === 1) {
      unsafe.push({
        binding,
        detail: `Default binding "${binding.key}" for "${binding.commandId}" is a destructive single keystroke without modifiers. Add a modifier (e.g. ctrl+${binding.key}).`,
      });
    }
  }

  return unsafe;
}

// --- command validation -----------------------------------------------------

// Validate that all bindings reference known command ids.
export function detectUnknownCommands(
  bindings: KeyBinding[],
  knownCommandIds: Set<string>,
): Array<{ binding: KeyBinding; detail: string }> {
  const unknown: Array<{ binding: KeyBinding; detail: string }> = [];

  for (const binding of bindings) {
    if (!knownCommandIds.has(binding.commandId)) {
      unknown.push({
        binding,
        detail: `Command "${binding.commandId}" is not registered in the command registry.`,
      });
    }
  }

  return unknown;
}

// --- full validation --------------------------------------------------------

// Run all validations and produce a combined result.
export function validateBindings(
  bindings: KeyBinding[],
  knownCommandIds: Set<string>,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const c of detectConflicts(bindings)) {
    issues.push({ type: "conflict", bindingA: c.a, bindingB: c.b, detail: c.detail });
  }

  for (const u of detectUnsafeDefaults(bindings)) {
    issues.push({ type: "unsafe-default", binding: u.binding, detail: u.detail });
  }

  for (const u of detectUnknownCommands(bindings, knownCommandIds)) {
    issues.push({ type: "unknown-command", binding: u.binding, detail: u.detail });
  }

  return { valid: issues.length === 0, issues };
}

// --- formatting -------------------------------------------------------------

// Format a validation result as a compact TUI view.
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push("Keybinding Validation");
  lines.push("═".repeat(50));

  if (result.valid) {
    lines.push("✓ No conflicts, unsafe defaults, or unknown commands.");
  } else {
    lines.push(`✗ ${result.issues.length} issue(s) found:`);
    for (const issue of result.issues) {
      switch (issue.type) {
        case "conflict":
          lines.push(`  ⚠ CONFLICT: ${issue.detail}`);
          break;
        case "unsafe-default":
          lines.push(`  ⚠ UNSAFE: ${issue.detail}`);
          break;
        case "unknown-command":
          lines.push(`  ⚠ UNKNOWN: ${issue.detail}`);
          break;
      }
    }
  }

  lines.push("");
  lines.push("Read-only: no commands executed, no keymap files modified.");

  return lines.join("\n");
}

// Format a list of bindings as a compact table.
export function formatBindings(bindings: KeyBinding[]): string {
  const lines: string[] = [];
  lines.push("Keybindings:");
  for (const b of bindings) {
    const when = b.when ? ` when:${b.when}` : "";
    lines.push(`  ${b.key} → ${b.commandId} [${b.source}]${when}`);
  }
  return lines.join("\n");
}
