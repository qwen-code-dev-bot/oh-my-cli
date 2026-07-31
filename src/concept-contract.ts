// Shared workbench concept contract: the single canonical source of truth for
// the concepts the TUI and Desktop surfaces present in common — conversation,
// tool activity, files, diffs, terminals, approvals, Goal, Workflow, and
// delivery state. Each concept carries a stable identifier, a display name, a
// canonical status enum, optional shortcut semantics, and a canonical failure
// semantic, so both surfaces speak the same vocabulary and a concept cannot be
// silently renamed, re-statused, or re-mapped on one surface without a failing
// contract test. This is the dependency-first foundation of the converged
// workbench roadmap (Issue #290); the TUI adoption child (#301), the Desktop
// contract-bound rendering child (#302), and the cross-surface continuation
// child (#303) all consume these definitions rather than redefining them.
//
// Alongside the definitions this module publishes a capability MATRIX: for every
// concept, whether each surface (tui, desktop) currently renders it through the
// shared contract, with an explicit, actionable gap message wherever it does not.
// The matrix makes parity gaps visible instead of silently omitted (Issue #290
// acceptance). It is a static declaration sourced from this module alone — there
// is no second source of truth to drift — and it never reads settings, probes,
// executes, or touches secrets, so it is always safe to collect and render.
//
// Trust boundary: the contract and matrix are fixed product metadata. They
// contain no user input, no settings values, and no secrets; rendering therefore
// needs no redaction beyond the standard secret guard applied to any text the
// product emits.

export const CONCEPT_CONTRACT_SCHEMA = "oh-my-cli.concept-contract";
export const CONCEPT_CONTRACT_VERSION = 1;

// The two product surfaces the contract governs, in presentation order: the
// terminal UI is the reference surface; the native Desktop workbench is the
// emerging surface whose parity gaps the matrix makes explicit.
export type SurfaceKind = "tui" | "desktop";
export const SURFACES: readonly SurfaceKind[] = ["tui", "desktop"];

// The stable identifiers for every shared concept. These are the canonical keys
// both surfaces must use; contract tests pin this exact set so a surface cannot
// drop or rename a concept without a failing check.
export type ConceptId =
  | "conversation"
  | "tool-activity"
  | "files"
  | "diffs"
  | "terminals"
  | "approvals"
  | "goal"
  | "workflow"
  | "delivery-state";

// One canonical concept definition. `shortcut` is present only where a concept
// has a canonical key semantic (for example approvals' y/n); concepts without a
// shortcut leave it undefined rather than inventing one.
export interface ConceptDefinition {
  id: ConceptId;
  name: string;
  statuses: readonly string[];
  shortcut?: string;
  failureSemantic: string;
}

// The canonical contract. Order here is the canonical presentation order used by
// the matrix and the renderers. Every entry is a fixed product fact; a surface
// adopts these definitions rather than declaring its own.
export const CONCEPT_CONTRACT: readonly ConceptDefinition[] = [
  {
    id: "conversation",
    name: "Conversation",
    statuses: ["active", "idle", "completed", "failed"],
    failureSemantic: "Surface the redacted provider error; never drop the turn silently.",
  },
  {
    id: "tool-activity",
    name: "Tool activity",
    statuses: ["pending", "running", "succeeded", "failed"],
    failureSemantic: "Isolate the failed tool, preserve its output, and continue the turn.",
  },
  {
    id: "files",
    name: "Files",
    statuses: ["clean", "modified", "staged", "conflicted"],
    failureSemantic: "Refuse the write, report the conflicting path, never overwrite uncommitted work.",
  },
  {
    id: "diffs",
    name: "Diffs",
    statuses: ["proposed", "applied", "rejected"],
    failureSemantic: "Reject the hunk, keep the base, and report the offset.",
  },
  {
    id: "terminals",
    name: "Terminals",
    statuses: ["running", "exited", "signaled"],
    failureSemantic: "Report the exit code, preserve the capture, never auto-restart.",
  },
  {
    id: "approvals",
    name: "Approvals",
    statuses: ["pending", "approved", "denied", "expired"],
    shortcut: "y/n",
    failureSemantic: "Fail closed: an unresolved approval denies the mutation.",
  },
  {
    id: "goal",
    name: "Goal",
    statuses: ["set", "active", "paused", "achieved", "incomplete"],
    failureSemantic: "Leave the goal incomplete and record the blocking revision.",
  },
  {
    id: "workflow",
    name: "Workflow",
    statuses: ["proposed", "running", "awaiting-gate", "completed", "failed"],
    failureSemantic: "Stop at the failed phase and preserve the run checkpoint.",
  },
  {
    id: "delivery-state",
    name: "Delivery state",
    statuses: ["clean", "ahead", "pushing", "merged", "quarantined"],
    failureSemantic: "Preserve the branch and evidence; never force or reset.",
  },
];

// Look up a canonical concept by id. Throws on an unknown id so a surface that
// references a concept the contract does not define fails loudly rather than
// silently rendering a divergent concept.
export function conceptById(id: ConceptId): ConceptDefinition {
  const found = CONCEPT_CONTRACT.find((concept) => concept.id === id);
  if (!found) {
    throw new Error(`Concept error: "${id}" is not a shared concept in the contract`);
  }
  return found;
}

// One surface's capability for one concept. `gap` is null when the surface
// renders the concept through the shared contract; otherwise it is an explicit,
// actionable message naming the gating work.
export interface SurfaceCapability {
  surface: SurfaceKind;
  supported: boolean;
  gap: string | null;
}

// A concept row in the capability matrix: the canonical definition plus the
// per-surface capability (always every surface, in SURFACES order).
export interface ConceptCapability {
  id: ConceptId;
  name: string;
  statuses: string[];
  shortcut: string | null;
  failureSemantic: string;
  surfaces: SurfaceCapability[];
}

// The redacted, serializable capability report: schema/version, the governed
// surfaces, and one row per concept (always every concept, in contract order).
export interface ConceptCapabilityReport {
  schema: string;
  version: number;
  surfaces: SurfaceKind[];
  concepts: ConceptCapability[];
}

// The static capability matrix, sourced from this module alone. The TUI is the
// reference surface and renders every shared concept through the contract; the
// Desktop workbench is gated and does not yet render these concepts through the
// shared contract, so each gap names the work that unblocks it. Keeping the
// matrix here (not in each surface) is what prevents silent divergence.
const DESKTOP_RENDERER_GAP =
  "Desktop workbench does not yet render this concept through the shared contract (see #302)";
const DESKTOP_SHELL_GAP =
  "Desktop secure session shell not yet available (gated by #106; see #302)";

const CAPABILITY_MATRIX: Record<ConceptId, Record<SurfaceKind, SurfaceCapability>> = {
  conversation: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  "tool-activity": {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  files: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  diffs: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  terminals: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_SHELL_GAP },
  },
  approvals: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  goal: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  workflow: {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
  "delivery-state": {
    tui: { surface: "tui", supported: true, gap: null },
    desktop: { surface: "desktop", supported: false, gap: DESKTOP_RENDERER_GAP },
  },
};

// Build the full capability report from the canonical contract and matrix. Pure
// and side-effect-free: it reads no settings and never throws for a supported
// concept. Every concept and every surface is always present, in canonical
// order, so consumers can rely on a stable shape.
export function collectConceptCapabilities(): ConceptCapabilityReport {
  const concepts = CONCEPT_CONTRACT.map((definition): ConceptCapability => {
    const matrix = CAPABILITY_MATRIX[definition.id];
    return {
      id: definition.id,
      name: definition.name,
      statuses: [...definition.statuses],
      shortcut: definition.shortcut ?? null,
      failureSemantic: definition.failureSemantic,
      surfaces: SURFACES.map((surface) => ({ ...matrix[surface] })),
    };
  });
  return {
    schema: CONCEPT_CONTRACT_SCHEMA,
    version: CONCEPT_CONTRACT_VERSION,
    surfaces: [...SURFACES],
    concepts,
  };
}

// Count the explicit parity gaps for one surface across the whole matrix. Useful
// for a concise summary line ("desktop: 9 gaps").
export function countSurfaceGaps(report: ConceptCapabilityReport, surface: SurfaceKind): number {
  return report.concepts.filter((concept) => {
    const capability = concept.surfaces.find((s) => s.surface === surface);
    return capability !== undefined && !capability.supported;
  }).length;
}

const SURFACE_LABELS: Record<SurfaceKind, string> = {
  tui: "TUI",
  desktop: "Desktop",
};

// Render one capability cell: "supported" or an explicit, actionable gap.
function renderCell(capability: SurfaceCapability): string {
  return capability.supported ? "supported" : `gap — ${capability.gap ?? "unsupported"}`;
}

// A redacted, human-readable capability matrix. Fixed product metadata only — no
// settings, no secrets.
export function formatConceptCapabilities(report: ConceptCapabilityReport): string {
  const lines: string[] = [
    "Shared Concept Capability Matrix",
    "─".repeat(40),
    `Schema:   ${report.schema} v${report.version}`,
    `Surfaces: ${report.surfaces.map((s) => SURFACE_LABELS[s]).join(" · ")}`,
  ];
  for (const concept of report.concepts) {
    lines.push("");
    lines.push(concept.name);
    lines.push(`  statuses: ${concept.statuses.join(" · ")}`);
    if (concept.shortcut !== null) {
      lines.push(`  shortcut: ${concept.shortcut}`);
    }
    lines.push(`  failure:  ${concept.failureSemantic}`);
    for (const capability of concept.surfaces) {
      const label = `${SURFACE_LABELS[capability.surface]}:`.padEnd(9, " ");
      lines.push(`  ${label}${renderCell(capability)}`);
    }
  }
  const gaps = report.surfaces.map(
    (surface) => `${SURFACE_LABELS[surface]}: ${countSurfaceGaps(report, surface)} gap(s)`,
  );
  lines.push("");
  lines.push(`Parity: ${gaps.join(" · ")}`);
  return lines.join("\n");
}

// A compact one-line-per-concept rendering for space-constrained surfaces (the
// TUI slash command). Marks each concept's per-surface support with a glyph and
// trails a parity summary.
export function formatConceptCapabilitiesCompact(report: ConceptCapabilityReport): string {
  const rows = report.concepts.map((concept) => {
    const marks = concept.surfaces
      .map((capability) => SURFACE_LABELS[capability.surface][0] + (capability.supported ? "✓" : "✗"))
      .join(" ");
    return `${concept.name}: ${marks}`;
  });
  const gaps = report.surfaces.map(
    (surface) => `${SURFACE_LABELS[surface]} ${countSurfaceGaps(report, surface)} gap(s)`,
  );
  return [`Concepts (${report.concepts.length})`, ...rows, `Parity: ${gaps.join(" · ")}`].join("\n");
}
