export interface SandboxDiagnostic {
  mode: "interactive" | "non-interactive" | "headless";
  approvalMode: string;
  workspaceConfined: boolean;
  workspaceRoot: string | null;
  shellTimeout: { default: number; max: number };
  shellOutputCap: number;
  ttyAvailable: boolean;
  warnings: string[];
}

export function collectSandboxDiagnostic(
  approvalMode: string,
  workspaceRoot: string | null,
  isTTY: boolean,
): SandboxDiagnostic {
  const warnings: string[] = [];
  const mode = isTTY ? "interactive" : "headless";

  if (!isTTY && approvalMode === "default") {
    warnings.push("Default approval mode without TTY: all mutating tools will be denied.");
  }
  if (!isTTY && approvalMode === "auto-edit") {
    warnings.push("Auto-edit mode without TTY: shell commands will be denied.");
  }
  if (approvalMode === "yolo") {
    warnings.push("Yolo mode: all tools auto-approved. Use only in trusted environments.");
  }
  if (!workspaceRoot) {
    warnings.push("No workspace root configured. File operations are unrestricted.");
  }

  return {
    mode,
    approvalMode,
    workspaceConfined: workspaceRoot !== null,
    workspaceRoot: workspaceRoot ? redactPath(workspaceRoot) : null,
    shellTimeout: { default: 30, max: 120 },
    shellOutputCap: 1_048_576,
    ttyAvailable: isTTY,
    warnings,
  };
}

export function formatDiagnostic(diag: SandboxDiagnostic): string {
  const lines: string[] = [];
  lines.push(`Sandbox Diagnostic`);
  lines.push(`${"─".repeat(40)}`);
  lines.push(`Mode:             ${diag.mode}`);
  lines.push(`Approval:         ${diag.approvalMode}`);
  lines.push(`TTY:              ${diag.ttyAvailable ? "yes" : "no"}`);
  lines.push(`Workspace:        ${diag.workspaceConfined ? "confined" : "unrestricted"}`);
  if (diag.workspaceRoot) {
    lines.push(`  Root:           ${diag.workspaceRoot}`);
  }
  lines.push(`Shell timeout:    ${diag.shellTimeout.default}s (max ${diag.shellTimeout.max}s)`);
  lines.push(`Shell output cap: ${(diag.shellOutputCap / 1_048_576).toFixed(1)} MiB`);
  lines.push("");

  if (diag.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of diag.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  } else {
    lines.push(`No warnings.`);
  }

  return lines.join("\n");
}

function redactPath(p: string): string {
  // Replace home directory components with ~ to avoid leaking host paths
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
