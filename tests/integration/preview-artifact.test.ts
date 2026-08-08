import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.on("error", reject);
  });
}

describe("Integration: --preview-artifact surface (Issue #799)", () => {
  let workspaceDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-preview-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-preview-sess-"));
    baseEnv = { HOME: sessionDir };
    fs.writeFileSync(
      path.join(workspaceDir, "artifact.html"),
      "<!doctype html><html><body><h1>Artifact</h1><script>alert(1)</script></body></html>",
    );
    fs.writeFileSync(path.join(workspaceDir, "notes.txt"), "not html");
  });

  afterAll(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  const listWorkspace = () =>
    fs.readdirSync(workspaceDir, { recursive: true, withFileTypes: true })
      .map((e) => e.name)
      .sort()
      .join("\n");

  it("renders the safe preview for a trusted workspace (text, exit 0)", async () => {
    const before = listWorkspace();
    const r = await runCli(
      ["--preview-artifact", "artifact.html", "--trust", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Artifact Preview");
    expect(r.stdout).not.toContain("REFUSED");
    expect(r.stdout).toContain("artifact.html");
    // The fail-closed policy is reported verbatim.
    expect(r.stdout).toContain("Scripts:     disabled");
    expect(r.stdout).toContain("Blocked content (1):");
    expect(r.stdout).toContain("[script-tag]");
    // Strictly read-only: the workspace is untouched.
    expect(listWorkspace()).toBe(before);
  });

  it("emits the machine-readable record with --output json", async () => {
    const r = await runCli(
      ["--preview-artifact", "artifact.html", "--trust", "--output", "json", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const rec = JSON.parse(r.stdout);
    expect(rec.schema).toBe("oh-my-cli.artifact-preview");
    expect(rec.renderStatus).toBe("ok");
    expect(rec.policy.scripts).toBe("disabled");
    expect(rec.policy.network).toBe("disabled");
    expect(rec.blocked.some((b: { reason: string }) => b.reason === "script-tag")).toBe(true);
    expect(rec.identity.path).toBe("artifact.html");
    expect(rec.hasBlockedContent).toBe(true);
    expect(rec.sanitizedLines.join("\n")).toContain("BLOCKED: script");
  });

  it("fails closed (exit 1) for an untrusted workspace", async () => {
    const before = listWorkspace();
    const r = await runCli(
      ["--preview-artifact", "artifact.html", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Artifact Preview — REFUSED");
    expect(r.stdout).toContain("untrusted");
    expect(listWorkspace()).toBe(before);
  });

  it("fails closed (exit 1) for a non-HTML artifact", async () => {
    const r = await runCli(
      ["--preview-artifact", "notes.txt", "--trust", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("is not HTML");
  });

  it("fails closed (exit 1) for a workspace-escape path", async () => {
    const r = await runCli(
      ["--preview-artifact", "../escape.html", "--trust", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Reason:  outside-workspace");
    expect(r.stdout).toContain("workspace-relative path");
  });

  it("fails closed (exit 2) on an empty path before any engine work", async () => {
    const r = await runCli(
      ["--preview-artifact", "   ", "--trust", "--workspace", workspaceDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("non-empty path");
  });
});
