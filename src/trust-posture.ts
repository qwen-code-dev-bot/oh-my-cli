// Trust posture: one read-only, redacted view of the effective safety posture
// for a workspace, composing the trust and extension primitives the secure-
// extensibility roadmap (Issue #34) already delivered — folder trust and sandbox
// isolation (folder-trust.ts), approval modes (approval.ts), the sandbox
// diagnostic (sandbox-diag.ts), and extension discovery (extension-discovery.ts,
// Issue #122). Before running unattended or delegating mutating work, an operator
// (or a machine consumer) can ask a single question — "is this run confined the
// way I expect, and what will it be allowed to do?" — instead of running
// --trust-info, --sandbox-info, and --discover-extensions separately and stitching
// the answers by hand.
//
// Trust boundary: this is a read-only composition. It never mutates the trust
// store or settings, never changes confinement, and never widens the boundary —
// it only reports it. The approval mode stays subordinate to folder trust, so a
// posture never implies yolo can mutate an untrusted workspace. No secret value,
// argument value, sensitive URL part, or unredacted host path is printed; the
// home path is collapsed to ~. Because the command is an audit (not a gate), an
// invalid extension contract is surfaced as a visible redacted warning rather
// than thrown — the runtime contract resolvers still fail closed on their own.

import { resolveFolderTrust } from "./folder-trust.js";
import type { TrustState, SandboxAvailability } from "./folder-trust.js";
import { collectSandboxDiagnostic } from "./sandbox-diag.js";
import { needsApproval } from "./approval.js";
import type { ApprovalMode, ToolCategory } from "./approval.js";
import { collectExtensionDiscovery } from "./extension-discovery.js";
import type { McpLifecycleState } from "./mcp-contract.js";
import type { ToolReadinessState } from "./tool-contract.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";

export const TRUST_POSTURE_SCHEMA = "oh-my-cli.trust-posture";
export const TRUST_POSTURE_VERSION = 1;

// A fixed, non-secret description of what each approval mode auto-approves. The
// approval mode is subordinate to folder trust: these describe prompt behavior
// only after the trust gate permits mutation.
const APPROVAL_PERMITS: Record<ApprovalMode, string> = {
  default: "Reads auto-run; file and shell mutations require approval.",
  "auto-edit": "Reads and file edits auto-run; shell mutations require approval.",
  yolo: "All tools auto-approved (unsafe — use only in trusted environments).",
};

// The tool categories auto-approved (no prompt) under a mode, derived from the
// live approval policy so the posture never drifts from what the runtime enforces.
function approvalAutoApproves(mode: ApprovalMode): ToolCategory[] {
  const all: ToolCategory[] = ["read", "mutate-file", "mutate-shell"];
  return all.filter((category) => !needsApproval(mode, category));
}

export interface ApprovalPosture {
  mode: ApprovalMode;
  permits: string;
  autoApproves: ToolCategory[];
}

// A compact per-surface extension readiness summary: declared or not, which entry
// a consumer would select, and (for MCP and tool) the lifecycle/readiness state.
export interface PostureExtensionSurface {
  kind: "provider" | "mcp" | "tool";
  present: boolean;
  selectedId: string | null;
  state: McpLifecycleState | ToolReadinessState | null;
}

export interface TrustPostureReport {
  schema: string;
  version: number;
  workspace: string;
  folderTrust: {
    state: TrustState;
    mutatingAllowed: boolean;
    sandbox: SandboxAvailability;
    enforcing: boolean;
    reason: string;
  };
  sandbox: {
    mode: string;
    workspaceConfined: boolean;
    ttyAvailable: boolean;
    warnings: string[];
  };
  approval: ApprovalPosture;
  extensions: {
    settingsFound: boolean;
    surfaces: PostureExtensionSurface[];
    // Set when the settings file exists but an extension contract is invalid;
    // the audit surfaces the problem instead of failing (it is not a gate).
    error?: string;
  };
}

export interface CollectTrustPostureOptions {
  workspacePath: string;
  approvalMode?: ApprovalMode;
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  /** `--trust`: trust this workspace for this run only (not persisted). */
  trustThisRun?: boolean;
  /** Whether folder-trust enforcement is active (--enforce-folder-trust / env). */
  enforcing?: boolean;
  isTTY?: boolean;
  /** Probe the MCP selected entry's lifecycle (false reports it as declared). */
  probe?: boolean;
}

// Compose the effective trust posture for a workspace in one read-only call.
// Never throws on an invalid extension contract: the discovery error is captured
// as a redacted warning so the audit always produces a report.
export function collectTrustPosture(opts: CollectTrustPostureOptions): TrustPostureReport {
  const env = opts.env ?? process.env;
  const approvalMode = opts.approvalMode ?? "default";
  const isTTY = opts.isTTY ?? false;
  const probe = opts.probe ?? true;
  const enforcing = opts.enforcing ?? false;

  const trust = resolveFolderTrust({
    workspacePath: opts.workspacePath,
    env,
    trustThisRun: opts.trustThisRun,
  });
  const diag = collectSandboxDiagnostic(approvalMode, opts.workspacePath, isTTY);

  let extensions: TrustPostureReport["extensions"];
  try {
    const discovery = collectExtensionDiscovery({ settingsPath: opts.settingsPath, probe });
    extensions = {
      settingsFound: discovery.settingsFound,
      // The posture view composes every extension surface discovery reports —
      // provider, MCP, and tool (#139) — so the audit reflects the full set of
      // declared contracts an unattended run could select.
      surfaces: discovery.surfaces.map((surface) => ({
        kind: surface.kind,
        present: surface.present,
        selectedId: surface.selectedId ?? null,
        state: surface.state ?? null,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    extensions = {
      settingsFound: true,
      surfaces: [],
      error: redactSecrets(message).text,
    };
  }

  return {
    schema: TRUST_POSTURE_SCHEMA,
    version: TRUST_POSTURE_VERSION,
    workspace: redactHomePath(opts.workspacePath),
    folderTrust: {
      state: trust.decision.state,
      mutatingAllowed: trust.decision.mutatingAllowed,
      sandbox: trust.sandbox,
      enforcing,
      reason: trust.decision.reason,
    },
    sandbox: {
      mode: diag.mode,
      workspaceConfined: diag.workspaceConfined,
      ttyAvailable: diag.ttyAvailable,
      warnings: diag.warnings,
    },
    approval: {
      mode: approvalMode,
      permits: APPROVAL_PERMITS[approvalMode],
      autoApproves: approvalAutoApproves(approvalMode),
    },
    extensions,
  };
}

// A redacted, human-readable posture summary. The mutation line makes the
// trust/approval relationship explicit: the approval mode only matters once the
// folder-trust gate permits mutation.
export function formatTrustPosture(report: TrustPostureReport): string {
  const lines: string[] = [
    "Trust Posture",
    "─".repeat(40),
    `Workspace:   ${report.workspace}`,
    `Schema:      ${report.schema} v${report.version}`,
    "",
    "Folder trust",
    `  State:     ${report.folderTrust.state}`,
    `  Sandbox:   ${report.folderTrust.sandbox}`,
    `  Enforcing: ${report.folderTrust.enforcing ? "yes" : "no (advisory)"}`,
    `  Mutation:  ${mutationLine(report.folderTrust)}`,
    `  Reason:    ${report.folderTrust.reason}`,
    "",
    "Approval",
    `  Mode:      ${report.approval.mode}`,
    `  Permits:   ${report.approval.permits}`,
    `  Auto-runs: ${report.approval.autoApproves.join(", ") || "(none)"}`,
    "",
    "Sandbox confinement",
    `  Mode:      ${report.sandbox.mode}`,
    `  Workspace: ${report.sandbox.workspaceConfined ? "confined" : "unrestricted"}`,
    `  TTY:       ${report.sandbox.ttyAvailable ? "yes" : "no"}`,
  ];
  if (report.sandbox.warnings.length > 0) {
    for (const warning of report.sandbox.warnings) lines.push(`  ⚠ ${warning}`);
  } else {
    lines.push("  No warnings.");
  }
  lines.push("");
  lines.push("Extension readiness");
  if (report.extensions.error) {
    lines.push(`  Invalid:   ${report.extensions.error}`);
  } else {
    if (!report.extensions.settingsFound) {
      lines.push("  Settings:  (not found)");
    }
    for (const surface of report.extensions.surfaces) {
      const label =
        surface.kind === "provider" ? "Provider" : surface.kind === "mcp" ? "MCP" : "Tool";
      if (!surface.present) {
        lines.push(`  ${label}:   not declared`);
      } else if (surface.kind === "mcp" || surface.kind === "tool") {
        lines.push(`  ${label}:   ${surface.selectedId ?? "(ambiguous)"} — ${surface.state}`);
      } else {
        lines.push(`  ${label}:   ${surface.selectedId ?? "(ambiguous)"}`);
      }
    }
  }
  return lines.join("\n");
}

function mutationLine(folderTrust: TrustPostureReport["folderTrust"]): string {
  if (folderTrust.mutatingAllowed) return "permitted (approval mode still applies)";
  if (folderTrust.enforcing) return "DENIED (fail closed)";
  return "would be denied if enforcement were on";
}
