import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runWorkflow,
  redactPromptForDisplay,
  formatWorkflowStepLine,
  formatWorkflowRun,
  formatWorkflowStepState,
  formatWorkflowRunHeader,
  formatWorkflowConsoleStepLine,
  formatWorkflowSkippedLine,
  formatWorkflowOutcome,
  WORKFLOW_STEP_STATES,
} from "../../src/workflow-runner.js";
import type {
  StepExecutor,
  StepExecutionContext,
  WorkflowStepResult,
  WorkflowStepState,
  WorkflowRunReport,
} from "../../src/workflow-runner.js";
import { createColorPalette } from "../../src/color.js";

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

describe("execution console formatting (#262)", () => {
  it("renders a stable glyph + ASCII label for every step state", () => {
    const states: WorkflowStepState[] = ["queued", "running", "completed", "failed", "skipped"];
    for (const state of states) {
      const rendered = formatWorkflowStepState(state);
      expect(rendered).toBe(`${WORKFLOW_STEP_STATES[state].glyph} ${WORKFLOW_STEP_STATES[state].label}`);
      expect(rendered).toContain(state); // ASCII label always present (understandable without color)
    }
    // Distinct glyphs per state.
    const glyphs = states.map((s) => WORKFLOW_STEP_STATES[s].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("renders the run header with the workflow identity and declared step count", () => {
    expect(formatWorkflowRunHeader("deploy", 3)).toBe('Workflow "deploy" — 3 steps');
    expect(formatWorkflowRunHeader("solo", 1)).toBe('Workflow "solo" — 1 step');
  });

  it("renders console step lines with state, position, and elapsed only when finished", () => {
    const step = { index: 0, prompt: "list files", elapsedMs: 12 };
    const running = formatWorkflowConsoleStepLine("running", step, 2);
    expect(running).toContain("● running");
    expect(running).toContain("Step 1/2");
    expect(running).toContain("list files");
    expect(running).not.toContain("ms"); // running is not finished: no elapsed

    const completed = formatWorkflowConsoleStepLine("completed", step, 2);
    expect(completed).toContain("✓ completed");
    expect(completed).toContain("(12ms)");

    const failed = formatWorkflowConsoleStepLine("failed", { ...step, index: 1 }, 2);
    expect(failed).toContain("✗ failed");
    expect(failed).toContain("Step 2/2");
    expect(failed).toContain("(12ms)");
  });

  it("emits no ANSI escapes without color and adds emphasis with color", () => {
    const step = { index: 0, prompt: "x", elapsedMs: 1 };
    const noColor = createColorPalette(false);
    const plain = formatWorkflowConsoleStepLine("failed", step, 1, noColor);
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("✗ failed");

    const color = createColorPalette(true);
    const bold = formatWorkflowConsoleStepLine("failed", step, 1, color);
    expect(bold).toContain("\x1b[1m"); // bold emphasis for failed
    expect(bold).toContain("\x1b[0m"); // reset
    const dimmed = formatWorkflowConsoleStepLine("skipped", step, 1, color);
    expect(dimmed).toContain("\x1b[2m"); // dim emphasis for skipped
  });

  it("renders the skipped line and the terminal outcome with exact counts", () => {
    const skipped = formatWorkflowSkippedLine(2, 3);
    expect(skipped).toContain("- skipped");
    expect(skipped).toContain("Steps 2-3 (halted)");

    const report: WorkflowRunReport = {
      schema: "oh-my-cli.workflow-contract",
      version: 1,
      contractVersion: 1,
      workflow: "wf",
      result: "failed",
      stepsTotal: 3,
      stepsRun: 1,
      steps: [],
      elapsedMs: 42,
      settings: "~/.oh-my-cli/settings.json",
      workspace: "~/ws",
    };
    expect(formatWorkflowOutcome(report)).toBe("Result: failed (1/3 steps, 42ms)");
  });

  it("fires onRunStart after resolution and before the first step", async () => {
    const settings = writeSettings({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: "a" }, { prompt: "b" }] } } },
    });
    const events: string[] = [];
    await runWorkflow({
      name: "wf",
      settingsPath: settings,
      workspace: tmpDir(),
      env: {},
      executor: async (ctx) => {
        events.push(`step:${ctx.prompt}`);
        return { ok: true, exitCode: 0 };
      },
      onRunStart: (workflow, stepsTotal) => events.push(`run:${workflow}:${stepsTotal}`),
    });
    // Run header fires once, before any step.
    expect(events[0]).toBe("run:wf:2");
    expect(events.slice(1)).toEqual(["step:a", "step:b"]);
  });

  it("does not fire onRunStart when resolution fails", async () => {
    const settings = writeSettings({
      workflows: { contractVersion: 1, definitions: { wf: { steps: [{ prompt: "x" }] } } },
    });
    let started = false;
    await expect(
      runWorkflow({
        name: "ghost",
        settingsPath: settings,
        workspace: tmpDir(),
        env: {},
        executor: async () => ({ ok: true, exitCode: 0 }),
        onRunStart: () => {
          started = true;
        },
      }),
    ).rejects.toThrow(/workflow "ghost" is not defined/);
    expect(started).toBe(false);
  });
});
