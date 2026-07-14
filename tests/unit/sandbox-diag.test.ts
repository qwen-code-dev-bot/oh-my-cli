import { describe, it, expect } from "vitest";
import { collectSandboxDiagnostic, formatDiagnostic } from "../../src/sandbox-diag.js";

describe("Sandbox diagnostic: collectSandboxDiagnostic", () => {
  it("reports interactive mode with TTY", () => {
    const diag = collectSandboxDiagnostic("default", "/workspace", true);
    expect(diag.mode).toBe("interactive");
    expect(diag.ttyAvailable).toBe(true);
    expect(diag.approvalMode).toBe("default");
    expect(diag.workspaceConfined).toBe(true);
  });

  it("reports headless mode without TTY", () => {
    const diag = collectSandboxDiagnostic("default", "/workspace", false);
    expect(diag.mode).toBe("headless");
    expect(diag.ttyAvailable).toBe(false);
  });

  it("warns about default approval mode without TTY", () => {
    const diag = collectSandboxDiagnostic("default", "/workspace", false);
    expect(diag.warnings.length).toBeGreaterThan(0);
    expect(diag.warnings.some((w) => w.includes("denied"))).toBe(true);
  });

  it("warns about auto-edit mode without TTY for shell", () => {
    const diag = collectSandboxDiagnostic("auto-edit", "/workspace", false);
    expect(diag.warnings.some((w) => w.includes("shell"))).toBe(true);
  });

  it("warns about yolo mode", () => {
    const diag = collectSandboxDiagnostic("yolo", "/workspace", true);
    expect(diag.warnings.some((w) => w.includes("Yolo"))).toBe(true);
  });

  it("reports unrestricted workspace when null", () => {
    const diag = collectSandboxDiagnostic("default", null, true);
    expect(diag.workspaceConfined).toBe(false);
    expect(diag.warnings.some((w) => w.includes("unrestricted"))).toBe(true);
  });

  it("includes shell timeout and output cap values", () => {
    const diag = collectSandboxDiagnostic("default", "/workspace", true);
    expect(diag.shellTimeout.default).toBe(30);
    expect(diag.shellTimeout.max).toBe(120);
    expect(diag.shellOutputCap).toBe(1_048_576);
  });
});

describe("Sandbox diagnostic: formatDiagnostic", () => {
  it("formats diagnostic without secrets or sensitive paths", () => {
    const home = process.env.HOME ?? "/tmp";
    const testPath = `${home}/my-project`;
    const diag = collectSandboxDiagnostic("default", testPath, true);
    const formatted = formatDiagnostic(diag);
    expect(formatted).toContain("Sandbox Diagnostic");
    expect(formatted).toContain("interactive");
    expect(formatted).not.toContain(testPath);
    expect(formatted).toContain("~");
  });

  it("formats warnings when present", () => {
    const diag = collectSandboxDiagnostic("yolo", "/workspace", true);
    const formatted = formatDiagnostic(diag);
    expect(formatted).toContain("Warnings:");
    expect(formatted).toContain("Yolo");
  });

  it("shows no warnings when clean", () => {
    const diag = collectSandboxDiagnostic("default", "/workspace", true);
    const formatted = formatDiagnostic(diag);
    expect(formatted).toContain("No warnings.");
  });
});
