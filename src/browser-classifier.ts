// Read-only browser action classifier: categorizes navigation actions by
// mutation risk and determines approval requirements.
//
// Action entries expose type, target URL, risk level, approval-required
// flag, and evidence binding. Risk classification is deterministic. The
// view is read-only and never executes browser actions, bypasses
// authentication, or modifies page state.

export const BROWSER_CLASSIFIER_SCHEMA = "oh-my-cli.browser-classifier";
export const BROWSER_CLASSIFIER_VERSION = 1;

// --- types ------------------------------------------------------------------

export type BrowserActionType =
  | "navigate"
  | "dom-inspect"
  | "screenshot"
  | "text-extract"
  | "click"
  | "form-submit"
  | "download"
  | "upload"
  | "authenticate";

export type MutationRisk = "read-only" | "low" | "medium" | "high" | "critical";

export interface EvidenceBinding {
  /** Target URL. */
  url: string;
  /** Epoch ms of the action. */
  timestamp: number;
  /** Task revision (head SHA) at the time of the action. */
  taskRevision: string;
}

export interface ClassifiedAction {
  /** Action identifier. */
  id: string;
  actionType: BrowserActionType;
  /** Target URL or selector. */
  target: string;
  riskLevel: MutationRisk;
  /** Whether explicit approval is required before execution. */
  approvalRequired: boolean;
  /** Evidence binding. */
  evidence: EvidenceBinding;
}

// --- risk classification ----------------------------------------------------

const RISK_MAP: Record<BrowserActionType, MutationRisk> = {
  "navigate": "read-only",
  "dom-inspect": "read-only",
  "screenshot": "read-only",
  "text-extract": "read-only",
  "click": "low",
  "form-submit": "medium",
  "download": "high",
  "upload": "high",
  "authenticate": "critical",
};

// Approval is required for medium, high, and critical risk actions.
const APPROVAL_REQUIRED: Set<MutationRisk> = new Set(["medium", "high", "critical"]);

export function classifyRisk(actionType: BrowserActionType): MutationRisk {
  return RISK_MAP[actionType];
}

export function requiresApproval(riskLevel: MutationRisk): boolean {
  return APPROVAL_REQUIRED.has(riskLevel);
}

// --- action classifier ------------------------------------------------------

export class BrowserActionClassifier {
  private readonly actions: ClassifiedAction[] = [];

  /** Classify and record a browser action. */
  classify(opts: {
    id: string;
    actionType: BrowserActionType;
    target: string;
    url: string;
    timestamp: number;
    taskRevision: string;
  }): ClassifiedAction {
    const riskLevel = classifyRisk(opts.actionType);
    const entry: ClassifiedAction = {
      id: opts.id,
      actionType: opts.actionType,
      target: opts.target,
      riskLevel,
      approvalRequired: requiresApproval(riskLevel),
      evidence: {
        url: opts.url,
        timestamp: opts.timestamp,
        taskRevision: opts.taskRevision,
      },
    };
    this.actions.push(entry);
    return entry;
  }

  list(): ClassifiedAction[] {
    return [...this.actions];
  }

  /** Get actions that require approval. */
  getRequiringApproval(): ClassifiedAction[] {
    return this.actions.filter((a) => a.approvalRequired);
  }

  /** Get read-only actions (no approval needed). */
  getReadOnly(): ClassifiedAction[] {
    return this.actions.filter((a) => a.riskLevel === "read-only");
  }

  /** Get actions by risk level. */
  getByRisk(risk: MutationRisk): ClassifiedAction[] {
    return this.actions.filter((a) => a.riskLevel === risk);
  }

  get size(): number {
    return this.actions.length;
  }
}

// --- formatting -------------------------------------------------------------

export function formatClassifiedAction(action: ClassifiedAction): string {
  const icon = riskIcon(action.riskLevel);
  const approval = action.approvalRequired ? " [APPROVAL REQUIRED]" : " [no approval]";
  const lines: string[] = [];
  lines.push(`${icon} ${action.actionType} → ${action.target} [${action.riskLevel}]${approval}`);
  lines.push(`  URL: ${action.evidence.url}`);
  lines.push(`  Rev: ${action.evidence.taskRevision.slice(0, 12)}`);
  return lines.join("\n");
}

export function formatClassifierSummary(classifier: BrowserActionClassifier): string {
  const lines: string[] = [];
  lines.push("Browser Action Classification");
  lines.push("═".repeat(50));
  lines.push(`Actions: ${classifier.size}  Read-only: ${classifier.getReadOnly().length}  Approval required: ${classifier.getRequiringApproval().length}`);

  for (const action of classifier.list()) {
    lines.push("");
    lines.push(formatClassifiedAction(action));
  }

  lines.push("");
  lines.push("Read-only: no browser actions executed, no pages modified.");

  return lines.join("\n");
}

function riskIcon(risk: MutationRisk): string {
  switch (risk) {
    case "read-only": return "○";
    case "low": return "▽";
    case "medium": return "◆";
    case "high": return "▲";
    case "critical": return "⚠";
  }
}
