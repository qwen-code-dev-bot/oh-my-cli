// Read-only approval inbox inspection: shows pending and decided approval
// requests with action context, risk, expiry, and decision trail.
//
// Approval entries expose id, action summary, risk level, requested-by,
// expiry, head SHA, decision state, decided-by, and decided-at. Expired
// approvals are flagged when current time exceeds expiry. Stale-head
// detection flags approvals where the head SHA has changed. The view is
// read-only and never grants approvals, executes actions, or modifies
// the inbox.

export const APPROVAL_INBOX_SCHEMA = "oh-my-cli.approval-inbox";
export const APPROVAL_INBOX_VERSION = 1;

// --- types ------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalEntry {
  /** Stable approval identifier. */
  id: string;
  /** Summary of the action requiring approval. */
  actionSummary: string;
  riskLevel: RiskLevel;
  /** Who requested the approval. */
  requestedBy: string;
  /** Epoch ms of the request. */
  requestedAt: number;
  /** Epoch ms when the approval expires. */
  expiresAt: number;
  /** Head SHA at the time of the request. */
  headSha: string;
  /** Current decision state. */
  state: ApprovalState;
  /** Who made the decision (when decided). */
  decidedBy?: string;
  /** Epoch ms of the decision (when decided). */
  decidedAt?: number;
  /** Whether the head SHA has changed since the request. */
  staleHead: boolean;
}

// --- approval inbox ---------------------------------------------------------

export class ApprovalInbox {
  private readonly entries: ApprovalEntry[] = [];

  /** Add an approval request. */
  request(opts: {
    id: string;
    actionSummary: string;
    riskLevel: RiskLevel;
    requestedBy: string;
    requestedAt: number;
    expiresAt: number;
    headSha: string;
  }): ApprovalEntry {
    const entry: ApprovalEntry = {
      ...opts,
      state: "pending",
      staleHead: false,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Record an approval decision (read-only model: records, does not execute). */
  decide(id: string, decision: "approved" | "rejected", decidedBy: string, decidedAt: number): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.state !== "pending") return;
    entry.state = decision;
    entry.decidedBy = decidedBy;
    entry.decidedAt = decidedAt;
  }

  /** Refresh expiry and staleness state. */
  refresh(now: number, currentHeadSha: string): void {
    for (const entry of this.entries) {
      if (entry.state === "pending" && now > entry.expiresAt) {
        entry.state = "expired";
      }
      entry.staleHead = entry.headSha !== currentHeadSha;
    }
  }

  get(id: string): ApprovalEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  list(): ApprovalEntry[] {
    return [...this.entries];
  }

  getPending(): ApprovalEntry[] {
    return this.entries.filter((e) => e.state === "pending");
  }

  getDecided(): ApprovalEntry[] {
    return this.entries.filter((e) => e.state === "approved" || e.state === "rejected");
  }

  getExpired(): ApprovalEntry[] {
    return this.entries.filter((e) => e.state === "expired");
  }

  getStaleHead(): ApprovalEntry[] {
    return this.entries.filter((e) => e.staleHead);
  }

  get size(): number {
    return this.entries.length;
  }
}

// --- inbox view -------------------------------------------------------------

export interface ApprovalInboxView {
  schema: typeof APPROVAL_INBOX_SCHEMA;
  v: typeof APPROVAL_INBOX_VERSION;
  entries: ApprovalEntry[];
  totalCount: number;
  pendingCount: number;
  decidedCount: number;
  expiredCount: number;
  staleHeadCount: number;
  hasStaleHead: boolean;
  snapshotAt: number;
}

export function assembleInboxView(inbox: ApprovalInbox): ApprovalInboxView {
  const entries = inbox.list();
  return {
    schema: APPROVAL_INBOX_SCHEMA,
    v: APPROVAL_INBOX_VERSION,
    entries,
    totalCount: entries.length,
    pendingCount: inbox.getPending().length,
    decidedCount: inbox.getDecided().length,
    expiredCount: inbox.getExpired().length,
    staleHeadCount: inbox.getStaleHead().length,
    hasStaleHead: inbox.getStaleHead().length > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

export function formatApprovalEntry(entry: ApprovalEntry): string {
  const icon = stateIcon(entry.state);
  const risk = riskIcon(entry.riskLevel);
  const stale = entry.staleHead ? " ⚠STALE HEAD" : "";
  const lines: string[] = [];
  lines.push(`${icon} ${entry.actionSummary} [${entry.riskLevel}]${stale}`);
  lines.push(`  Requested by ${entry.requestedBy}  Expires: ${new Date(entry.expiresAt).toISOString()}`);
  lines.push(`  Head: ${entry.headSha.slice(0, 12)}`);

  if (entry.state !== "pending") {
    lines.push(`  Decision: ${entry.state} by ${entry.decidedBy ?? "system"} at ${entry.decidedAt ? new Date(entry.decidedAt).toISOString() : "N/A"}`);
  }

  return lines.join("\n");
}

export function formatInboxSummary(inbox: ApprovalInbox): string {
  const lines: string[] = [];
  lines.push("Approval Inbox");
  lines.push("═".repeat(50));
  lines.push(`Total: ${inbox.size}  Pending: ${inbox.getPending().length}  Decided: ${inbox.getDecided().length}  Expired: ${inbox.getExpired().length}`);

  if (inbox.getStaleHead().length > 0) {
    lines.push("⚠ Stale-head approvals detected (head SHA changed)");
  }

  for (const entry of inbox.list()) {
    lines.push("");
    lines.push(formatApprovalEntry(entry));
  }

  lines.push("");
  lines.push("Read-only: no approvals granted, no actions executed.");

  return lines.join("\n");
}

function stateIcon(state: ApprovalState): string {
  switch (state) {
    case "pending": return "○";
    case "approved": return "✓";
    case "rejected": return "✗";
    case "expired": return "⏰";
  }
}

function riskIcon(risk: RiskLevel): string {
  switch (risk) {
    case "low": return "▽";
    case "medium": return "◆";
    case "high": return "▲";
    case "critical": return "⚠";
  }
}
