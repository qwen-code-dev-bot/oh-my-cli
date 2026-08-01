// Read-only investigation lifecycle: tracks debug investigations through
// bounded phases with a hypothesis table and evidence receipts.
//
// Investigation entries expose stable identity, current phase, creation
// time, and phase history. Hypothesis entries show candidate description,
// evidence-for, evidence-against, and status. Phase transitions are ordered
// and bounded. The view is read-only and never executes commands, modifies
// files, or advances phases automatically.

export const DEBUG_LAB_SCHEMA = "oh-my-cli.debug-lab";
export const DEBUG_LAB_VERSION = 1;

// --- phases -----------------------------------------------------------------

export type InvestigationPhase =
  | "reproduce"
  | "minimize"
  | "hypothesize"
  | "instrument"
  | "fix"
  | "verify"
  | "close";

const PHASE_ORDER: InvestigationPhase[] = [
  "reproduce", "minimize", "hypothesize", "instrument", "fix", "verify", "close",
];

// Valid phase transitions: each phase can advance to the next, or skip
// forward (but never backward).
export function isValidTransition(from: InvestigationPhase, to: InvestigationPhase): boolean {
  const fromIdx = PHASE_ORDER.indexOf(from);
  const toIdx = PHASE_ORDER.indexOf(to);
  return toIdx > fromIdx;
}

// --- hypothesis entries -----------------------------------------------------

export type HypothesisStatus = "active" | "confirmed" | "rejected";

export interface HypothesisEntry {
  id: string;
  /** Candidate root-cause description. */
  description: string;
  status: HypothesisStatus;
  /** Evidence supporting this hypothesis. */
  evidenceFor: string[];
  /** Evidence against this hypothesis. */
  evidenceAgainst: string[];
}

// --- investigation entries --------------------------------------------------

export interface PhaseRecord {
  phase: InvestigationPhase;
  enteredAt: number;
}

export interface InvestigationEntry {
  /** Stable, unique identifier. */
  id: string;
  /** Bug report or issue reference. */
  title: string;
  currentPhase: InvestigationPhase;
  phaseHistory: PhaseRecord[];
  hypotheses: HypothesisEntry[];
  createdAt: number;
  /** Bounded receipt references (command output, logs, screenshots). */
  receiptRefs: string[];
}

// --- investigation tracker --------------------------------------------------

const MAX_RECEIPTS = 50;

export class InvestigationTracker {
  private readonly investigations = new Map<string, InvestigationEntry>();

  /** Start a new investigation in the reproduce phase. */
  start(opts: {
    id: string;
    title: string;
    createdAt: number;
  }): InvestigationEntry {
    const entry: InvestigationEntry = {
      id: opts.id,
      title: opts.title,
      currentPhase: "reproduce",
      phaseHistory: [{ phase: "reproduce", enteredAt: opts.createdAt }],
      hypotheses: [],
      createdAt: opts.createdAt,
      receiptRefs: [],
    };
    this.investigations.set(entry.id, entry);
    return entry;
  }

  /** Advance to a new phase. Rejects invalid transitions. */
  advancePhase(id: string, to: InvestigationPhase, at: number): { ok: boolean; reason?: string } {
    const inv = this.investigations.get(id);
    if (!inv) return { ok: false, reason: "Investigation not found" };

    if (!isValidTransition(inv.currentPhase, to)) {
      return {
        ok: false,
        reason: `Cannot transition from "${inv.currentPhase}" to "${to}". Phases must advance forward.`,
      };
    }

    inv.currentPhase = to;
    inv.phaseHistory.push({ phase: to, enteredAt: at });
    return { ok: true };
  }

  /** Add a hypothesis. */
  addHypothesis(id: string, hypothesis: HypothesisEntry): void {
    const inv = this.investigations.get(id);
    if (!inv) return;
    inv.hypotheses.push(hypothesis);
  }

  /** Update hypothesis status. */
  setHypothesisStatus(id: string, hypothesisId: string, status: HypothesisStatus): void {
    const inv = this.investigations.get(id);
    if (!inv) return;
    const hyp = inv.hypotheses.find((h) => h.id === hypothesisId);
    if (hyp) hyp.status = status;
  }

  /** Add evidence to a hypothesis. */
  addEvidence(id: string, hypothesisId: string, evidence: string, direction: "for" | "against"): void {
    const inv = this.investigations.get(id);
    if (!inv) return;
    const hyp = inv.hypotheses.find((h) => h.id === hypothesisId);
    if (!hyp) return;
    if (direction === "for") hyp.evidenceFor.push(evidence);
    else hyp.evidenceAgainst.push(evidence);
  }

  /** Add a receipt reference (bounded). */
  addReceipt(id: string, ref: string): void {
    const inv = this.investigations.get(id);
    if (!inv) return;
    if (inv.receiptRefs.length < MAX_RECEIPTS) {
      inv.receiptRefs.push(ref);
    }
  }

  get(id: string): InvestigationEntry | undefined {
    return this.investigations.get(id);
  }

  list(): InvestigationEntry[] {
    return [...this.investigations.values()];
  }

  get size(): number {
    return this.investigations.size;
  }
}

// --- formatting -------------------------------------------------------------

// Format an investigation as a compact TUI view.
export function formatInvestigation(inv: InvestigationEntry): string {
  const lines: string[] = [];
  lines.push(`Investigation: ${inv.title} [${inv.id}]`);
  lines.push(`Phase: ${inv.currentPhase}  Receipts: ${inv.receiptRefs.length}`);

  // Phase history.
  const phases = inv.phaseHistory.map((p) => p.phase).join(" → ");
  lines.push(`History: ${phases}`);

  // Hypotheses.
  if (inv.hypotheses.length > 0) {
    lines.push("");
    lines.push(`Hypotheses (${inv.hypotheses.length}):`);
    for (const h of inv.hypotheses) {
      const icon = hypothesisIcon(h.status);
      lines.push(`  ${icon} ${h.description} [${h.status}]`);
      if (h.evidenceFor.length > 0) lines.push(`    + ${h.evidenceFor.join("; ")}`);
      if (h.evidenceAgainst.length > 0) lines.push(`    - ${h.evidenceAgainst.join("; ")}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no commands executed, no files modified.");

  return lines.join("\n");
}

function hypothesisIcon(status: HypothesisStatus): string {
  switch (status) {
    case "active": return "◆";
    case "confirmed": return "✓";
    case "rejected": return "✗";
  }
}
