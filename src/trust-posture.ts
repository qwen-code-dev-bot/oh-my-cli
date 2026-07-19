// Trust posture: one read-only, redacted view of the effective safety posture
// for a workspace, composing the trust and extension primitives the secure-
// extensibility roadmap (Issue #34) already delivered — folder trust and sandbox
// isolation (folder-trust.ts), approval modes (approval.ts), the sandbox
// diagnostic (sandbox-diag.ts), extension discovery (extension-discovery.ts,
// Issue #122), and the extension-compatibility verdict (extension-compat.ts,
// Issue #155). Before running unattended or delegating mutating work, an operator
// (or a machine consumer) can ask a single question — "is this run confined the
// way I expect, and what will it be allowed to do?" — instead of running
// --trust-info, --sandbox-info, --discover-extensions, and --extension-compat
// separately and stitching the answers by hand.
//
// The extension section therefore reports BOTH readiness (is each surface
// declared and ready?) and version compatibility (is each surface's declared
// contract version supported by THIS build?) in one redacted view. The
// compatibility verdict is additive and sourced from extension-compat.ts, so an
// unsupported version is surfaced as a per-surface `incompatible` verdict up
// front instead of a fail-closed error mid-run — without a second query.
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
import { collectExtensionCompat } from "./extension-compat.js";
import type { CompatSurface } from "./extension-compat.js";
import type { McpLifecycleState } from "./mcp-contract.js";
import type { ToolReadinessState } from "./tool-contract.js";
import type { WorkflowReadinessState } from "./workflow-contract.js";
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
// a consumer would select, and (for MCP, tool, and workflow) the
// lifecycle/readiness state. A workflow carries no selectedId (it is chosen by
// explicit name at run time), so its selection is always null and only its
// contract-level readiness state is reported.
export interface PostureExtensionSurface {
  kind: "provider" | "mcp" | "tool" | "workflow";
  present: boolean;
  selectedId: string | null;
  state: McpLifecycleState | ToolReadinessState | WorkflowReadinessState | null;
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
    // Per-surface contract-version compatibility verdicts (compatible /
    // incompatible / absent), composed from the extension-compatibility surface
    // (extension-compat.ts, Issue #155) so the supported-version matrix has a
    // single source of truth and cannot drift from #155 or the parsers. This is
    // additive to the readiness `surfaces` above and keyed by the same `kind`:
    // an unsupported version is reported here as an `incompatible` verdict even
    // when readiness resolution fails closed. Empty only when the settings root
    // is malformed (the captured `error` explains why).
    compat: CompatSurface[];
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
      // provider, MCP, tool (#139), and workflow (#153) — so the audit reflects
      // the full set of declared contracts an unattended run could select.
      surfaces: discovery.surfaces.map((surface) => ({
        kind: surface.kind,
        present: surface.present,
        selectedId: surface.selectedId ?? null,
        state: surface.state ?? null,
      })),
      // Discovery succeeded ⇒ the settings root is a valid object, so the
      // compatibility verdict (which reads only each section's contractVersion)
      // cannot throw here. Compose it so the posture reports version
      // compatibility alongside readiness, sourced from extension-compat.ts.
      compat: collectExtensionCompat({ settingsPath: opts.settingsPath }).surfaces,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Readiness resolution failed closed (an unsupported version, a raw
    // credential field, or a malformed section). The version-compatibility
    // verdict is independent of readiness: when the settings root is still
    // readable, compose it so an unsupported version is reported as a
    // per-surface `incompatible` verdict rather than only a readiness error. A
    // malformed root makes the compat read fail too, so the verdict list stays
    // empty and the captured error explains why.
    let compat: CompatSurface[] = [];
    try {
      compat = collectExtensionCompat({ settingsPath: opts.settingsPath }).surfaces;
    } catch {
      // malformed settings root: the readiness error above already explains it
    }
    extensions = {
      settingsFound: true,
      surfaces: [],
      compat,
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
    const labels: Record<PostureExtensionSurface["kind"], string> = {
      provider: "Provider",
      mcp: "MCP",
      tool: "Tool",
      workflow: "Workflow",
    };
    for (const surface of report.extensions.surfaces) {
      const label = labels[surface.kind];
      if (!surface.present) {
        lines.push(`  ${label}:   not declared`);
      } else if (surface.kind === "mcp" || surface.kind === "tool") {
        lines.push(`  ${label}:   ${surface.selectedId ?? "(ambiguous)"} — ${surface.state}`);
      } else if (surface.kind === "workflow") {
        // A workflow has no default and no implicit selection; report only its
        // contract-level readiness (it is chosen by explicit name at run time).
        lines.push(`  ${label}:   ${surface.state}`);
      } else {
        lines.push(`  ${label}:   ${surface.selectedId ?? "(ambiguous)"}`);
      }
    }
  }
  // Version-compatibility verdicts (composed from extension-compat.ts): for each
  // surface, the supported range, the declared version, and whether THIS build
  // supports it. Additive to readiness, so an unsupported version is visible as
  // an `incompatible` verdict even when readiness resolution failed closed above.
  lines.push("");
  lines.push("Extension compatibility");
  if (report.extensions.compat.length === 0) {
    lines.push("  (not available — settings root could not be read)");
  } else {
    const compatLabels: Record<CompatSurface["kind"], string> = {
      provider: "Provider",
      mcp: "MCP",
      tool: "Tool",
      workflow: "Workflow",
    };
    for (const surface of report.extensions.compat) {
      const label = compatLabels[surface.kind];
      if (surface.verdict === "absent") {
        lines.push(`  ${label}:   absent`);
      } else {
        lines.push(
          `  ${label}:   ${surface.verdict} (declared ${
            surface.declaredVersion !== null ? surface.declaredVersion : "(invalid)"
          }, supported ${formatCompatRange(surface.supportedVersions)})`,
        );
      }
    }
  }
  return lines.join("\n");
}

// Render a supported-version range compactly for the posture's compatibility
// section: a single version as itself ("1"), a contiguous span as "min–max", a
// non-contiguous set as a comma list. Display only — the range itself is sourced
// from extension-compat.ts.
function formatCompatRange(versions: readonly number[]): string {
  if (versions.length === 0) return "(none)";
  const sorted = [...versions].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) return `${min}`;
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  return contiguous ? `${min}–${max}` : sorted.join(", ");
}

function mutationLine(folderTrust: TrustPostureReport["folderTrust"]): string {
  if (folderTrust.mutatingAllowed) return "permitted (approval mode still applies)";
  if (folderTrust.enforcing) return "DENIED (fail closed)";
  return "would be denied if enforcement were on";
}
