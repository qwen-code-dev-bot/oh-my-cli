import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runWorkflow,
  redactPromptForDisplay,
  formatWorkflowStepLine,
  formatWorkflowRun,
} from "../../src/workflow-runner.js";
import type {
  StepExecutor,
  StepExecutionContext,
  WorkflowStepResult,
} from "../../src/workflow-runner.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-workflow-runner-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runWorkflow: sequential execution and safe failure defaults", () => {
  it("runs every step in declared order and reports completed", async () => {
    const settings = writeSettings({
      workflows: {
        contractVersion: 1,
        definitions: {
          wf: { steps: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
        },
      },
    });
    const seen: string[] = [];
    const executor: StepExecutor = async (ctx: StepExecutionContext) => {
      seen.push(ctx.prompt);
      return { ok: true, exitCode: 0 };
    };
    const report = await runWorkflow({
      name: "wf",
      settingsPath: settings,
      workspace: tmpDir(),
      env: {},
      executor,
    });
    expect(seen).toEqual(["one", "two", "three"]);
    expect(report.result).toBe("completed");
    expect(report.stepsRun).toBe(3);
    expect(report.stepsTotal).toBe(3);
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.steps.every((s) => typeof s.elapsedMs === "number")).toBe(true);
  });

  it("halts on the first failing step; remaining steps do not run", async () => {
    const settings = writeSettings({
      workflows: {
        contractVersion: 1,
        definitions: {
          wf: { steps: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }] },
        },
      },
    });
    const seen: string[] = [];
    const executor: StepExecutor = async (ctx: StepExecutionContext) => {
      seen.push(ctx.prompt);
      if (ctx.prompt === "two") {
        return { ok: false, exitCode: 1, reason: "provider_error" };
      }
      return { ok: true, exitCode: 0 };
    };
    const report = await runWorkflow({
      name: "wf",
      settingsPath: settings,
      workspace: tmpDir(),
      env: {},
      executor,
    });
    expect(seen).toEqual(["one", "two"]); // step three never ran
    expect(report.result).toBe("failed");
    expect(report.stepsRun).toBe(2);
    expect(report.stepsTotal).toBe(3);
    expect(report.steps[1].ok).toBe(false);
    expect(report.steps[1].reason).toBe("provider_error");
  });

  it("throws (before any step) on an unknown workflow name", async () => {
    const settings = writeSettings({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: "x" }] } } },
    });
    let called = false;
    const executor: StepExecutor = async () => {
      called = true;
      return { ok: true, exitCode: 0 };
    };
    await expect(
      runWorkflow({ name: "ghost", settingsPath: settings, workspace: tmpDir(), env: {}, executor }),
    ).rejects.toThrow(/workflow "ghost" is not defined/);
    expect(called).toBe(false);
  });

  it("redacts secrets and home paths in the reported step prompt", async () => {
    const home = tmpDir();
    const decoyPrompt = `read ${path.join(home, ".ssh", "id_rsa")} using sk-aaaaaaaaaaaaaaaaaaaa`;
    const settings = writeSettings({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: decoyPrompt }] } } },
    });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const report = await runWorkflow({
        name: "wf",
        settingsPath: settings,
        workspace: tmpDir(),
        env: {},
        executor: async () => ({ ok: true, exitCode: 0 }),
      });
      const json = JSON.stringify(report);
      expect(json).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
      expect(json).not.toContain(home);
      expect(report.steps[0].prompt).toContain("~");
      expect(report.steps[0].prompt).toContain("[REDACTED]");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it("invokes streaming callbacks per step", async () => {
    const settings = writeSettings({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: "a" }, { prompt: "b" }] } } },
    });
    const starts: number[] = [];
    const ends: number[] = [];
    await runWorkflow({
      name: "wf",
      settingsPath: settings,
      workspace: tmpDir(),
      env: {},
      executor: async () => ({ ok: true, exitCode: 0 }),
      onStepStart: (s: WorkflowStepResult) => starts.push(s.index),
      onStepEnd: (s: WorkflowStepResult) => ends.push(s.index),
    });
    expect(starts).toEqual([0, 1]);
    expect(ends).toEqual([0, 1]);
  });
});

describe("redactPromptForDisplay", () => {
  it("redacts a known token and collapses the home path", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const out = redactPromptForDisplay(`open ${path.join(home, "notes.txt")} with sk-aaaaaaaaaaaaaaaaaaaa`);
      expect(out).toContain("~");
      expect(out).not.toContain(home);
      expect(out).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
      expect(out).toContain("[REDACTED]");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it("flattens whitespace and truncates a long prompt with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = redactPromptForDisplay(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
    const multiline = redactPromptForDisplay("a\n\n  b   c");
    expect(multiline).toBe("a b c");
  });
});

describe("formatWorkflowStepLine and formatWorkflowRun", () => {
  const step: WorkflowStepResult = {
    index: 0,
    prompt: "list files",
    ok: true,
    exitCode: 0,
    elapsedMs: 12,
  };

  it("renders an ok step and a failed step with reason", () => {
    expect(formatWorkflowStepLine(step, 2)).toContain("Step 1/2");
    expect(formatWorkflowStepLine(step, 2)).toContain("ok");
    const failed: WorkflowStepResult = { ...step, ok: false, reason: "provider_error" };
    expect(formatWorkflowStepLine(failed, 2)).toContain("FAILED");
  });

  it("renders a full run report with a halt notice for skipped steps", () => {
    const out = formatWorkflowRun({
      schema: "oh-my-cli.workflow-contract",
      version: 1,
      contractVersion: 1,
      workflow: "wf",
      result: "failed",
      stepsTotal: 3,
      stepsRun: 1,
      steps: [{ index: 0, prompt: "one", ok: false, exitCode: 1, elapsedMs: 5, reason: "boom" }],
      elapsedMs: 5,
      settings: "~/.oh-my-cli/settings.json",
      workspace: "~/ws",
    });
    expect(out).toContain("Workflow:  wf");
    expect(out).toContain("reason: boom");
    expect(out).toContain("Steps 2-3: skipped (halted)");
    expect(out).toContain("Result:    failed (1/3 steps");
  });
});
