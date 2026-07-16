import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planTask,
  formatTaskPlan,
  deriveVerifyCommands,
  buildPlanSteps,
  PLAN_SCHEMA,
  PLAN_VERSION,
} from "../../src/task-plan.js";
import { collectRepoContext } from "../../src/repo-context.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function write(dir: string, rel: string, content = ""): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("phase sequence", () => {
  it("produces the ordered understand/implement/verify/review phases", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const plan = planTask({ task: "add a feature", workspace: dir });
    expect(plan.schema).toBe(PLAN_SCHEMA);
    expect(plan.v).toBe(PLAN_VERSION);
    expect(plan.steps.map((s) => s.phase)).toEqual(["understand", "implement", "verify", "review"]);
    expect(plan.steps.map((s) => s.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("verify-command derivation", () => {
  it("grounds the verify step in package.json canonical commands, in order", () => {
    const dir = tmp();
    write(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." } }),
    );
    const plan = planTask({ task: "refactor X", workspace: dir });
    expect(plan.verifyCommands).toEqual(["tsc", "vitest run", "tsc --noEmit", "eslint ."]);
    const verify = plan.steps.find((s) => s.phase === "verify");
    expect(verify?.commands).toEqual(["tsc", "vitest run", "tsc --noEmit", "eslint ."]);
  });

  it("derives commands from a Makefile", () => {
    const dir = tmp();
    write(dir, "Makefile", "build:\n\techo b\n\ntest:\n\techo t\n");
    const plan = planTask({ task: "fix", workspace: dir });
    expect(plan.verifyCommands).toEqual(["make build", "make test"]);
  });

  it("derives commands from pyproject tool sections", () => {
    const dir = tmp();
    write(dir, "pyproject.toml", "[tool.pytest.ini_options]\nx=1\n\n[tool.mypy]\nstrict=true\n");
    const plan = planTask({ task: "fix", workspace: dir });
    expect(plan.verifyCommands).toEqual(["pytest", "mypy"]);
  });

  it("degrades gracefully when no verification command is detected", () => {
    const dir = tmp();
    const plan = planTask({ task: "do something", workspace: dir });
    expect(plan.verifyCommands).toEqual([]);
    const verify = plan.steps.find((s) => s.phase === "verify");
    expect(verify?.commands).toBeUndefined();
    expect(verify?.intent).toMatch(/No canonical verification command detected/);
  });

  it("deriveVerifyCommands is a pure function of the snapshot", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const snap = collectRepoContext({ workspace: dir });
    expect(deriveVerifyCommands(snap)).toEqual(["vitest run"]);
  });
});

describe("toolchain grounding", () => {
  it("references the detected toolchain in the understand step", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    write(dir, "package-lock.json", "{}");
    const plan = planTask({ task: "add X", workspace: dir });
    expect(plan.toolchain).toEqual(["npm"]);
    expect(plan.steps.find((s) => s.phase === "understand")?.intent).toContain("npm");
  });

  it("notes an unknown toolchain when none is detected", () => {
    const dir = tmp();
    const plan = planTask({ task: "add X", workspace: dir });
    expect(plan.toolchain).toEqual([]);
    expect(plan.steps.find((s) => s.phase === "understand")?.intent).toContain("unknown toolchain");
  });
});

describe("redaction and bounding", () => {
  it("redacts a secret in the task objective", () => {
    const dir = tmp();
    const plan = planTask({ task: `deploy --token ${SECRET}`, workspace: dir });
    expect(plan.objective).not.toContain(SECRET);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(plan.objective).toContain("[REDACTED]");
  });

  it("redacts a secret in a detected verify command", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    const plan = planTask({ task: "fix", workspace: dir });
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(plan.verifyCommands[0]).toContain("[REDACTED]");
  });

  it("bounds the objective length", () => {
    const dir = tmp();
    const long = "x".repeat(600);
    const plan = planTask({ task: long, workspace: dir });
    expect(plan.objective.length).toBe(500);
  });

  it("never leaks the workspace path", () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    const plan = planTask({ task: "add X", workspace: dir });
    expect(JSON.stringify(plan)).not.toContain(dir);
  });
});

describe("determinism", () => {
  it("is identical for identical task and repository state", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
    initRepo(dir);
    const a = JSON.stringify(planTask({ task: "implement feature Y", workspace: dir }));
    const b = JSON.stringify(planTask({ task: "implement feature Y", workspace: dir }));
    expect(a).toBe(b);
  });

  it("buildPlanSteps is a pure function of the snapshot and commands", () => {
    const dir = tmp();
    write(dir, "package.json", "{}");
    const snap = collectRepoContext({ workspace: dir });
    const a = buildPlanSteps(snap, ["tsc"]);
    const b = buildPlanSteps(snap, ["tsc"]);
    expect(a).toEqual(b);
    expect(a[2].commands).toEqual(["tsc"]);
  });
});

describe("formatTaskPlan", () => {
  it("renders the objective, toolchain, steps, and verify commands", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
    write(dir, "package-lock.json", "{}");
    const text = formatTaskPlan(planTask({ task: "add a feature", workspace: dir }));
    expect(text).toContain("Task plan (oh-my-cli.plan v1)");
    expect(text).toContain("Objective : add a feature");
    expect(text).toContain("Toolchain : npm");
    expect(text).toContain("understand");
    expect(text).toContain("implement");
    expect(text).toContain("verify");
    expect(text).toContain("- tsc");
    expect(text).toContain("- vitest run");
    expect(text).toContain("review");
  });

  it("renders the no-command verify step for an empty directory", () => {
    const text = formatTaskPlan(planTask({ task: "do something", workspace: tmp() }));
    expect(text).toContain("Toolchain : unknown");
    expect(text).toContain("No canonical verification command detected");
  });
});
