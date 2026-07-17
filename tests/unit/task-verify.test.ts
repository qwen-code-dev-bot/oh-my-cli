import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyTask,
  formatVerifyReport,
  buildVerifyReport,
  runCommand,
  scrubOutput,
  displayCommand,
  VERIFY_SCHEMA,
  VERIFY_VERSION,
  type CommandResult,
} from "../../src/task-verify.js";
import { collectRepoContext } from "../../src/repo-context.js";
import { deriveVerifyCommands } from "../../src/task-plan.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tv-"));
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

function result(name: CommandResult["name"], passed: boolean): CommandResult {
  return {
    name,
    command: "true",
    exitCode: passed ? 0 : 1,
    passed,
    timedOut: false,
    durationMs: 1,
    outputTail: "",
  };
}

const SECRET = "ghp_" + "a".repeat(36);

describe("buildVerifyReport", () => {
  it("verdict is no-verify-commands when nothing was detected", () => {
    const report = buildVerifyReport("abc", []);
    expect(report.schema).toBe(VERIFY_SCHEMA);
    expect(report.v).toBe(VERIFY_VERSION);
    expect(report.verdict).toBe("no-verify-commands");
    expect(report.results).toEqual([]);
  });

  it("verdict is pass only when every command passed", () => {
    expect(buildVerifyReport("abc", [result("build", true), result("test", true)]).verdict).toBe("pass");
  });

  it("verdict is fail when any command failed", () => {
    expect(buildVerifyReport("abc", [result("build", true), result("test", false)]).verdict).toBe("fail");
  });

  it("is deterministic for identical inputs", () => {
    const results = [result("build", true), result("test", false)];
    const a = JSON.stringify(buildVerifyReport("sha1", results));
    const b = JSON.stringify(buildVerifyReport("sha1", results));
    expect(a).toBe(b);
  });
});

describe("scrubOutput", () => {
  it("redacts secrets in captured output", () => {
    const out = scrubOutput(`auth failed: ${SECRET}`, tmp());
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs the absolute workspace path", () => {
    const dir = tmp();
    const out = scrubOutput(`cannot open ${dir}/src/index.ts`, dir);
    expect(out).not.toContain(dir);
    expect(out).toContain("[workspace]");
  });

  it("bounds the captured output to the tail", () => {
    const out = scrubOutput("x".repeat(20_000), tmp());
    expect(out.length).toBe(8 * 1024);
  });
});

describe("displayCommand", () => {
  it("redacts and bounds a command for display", () => {
    expect(displayCommand(`run --token ${SECRET}`)).toBe("run --token [REDACTED]");
    expect(displayCommand("y".repeat(200)).length).toBe(120);
  });

  it("scrubs the workspace path when provided", () => {
    const dir = tmp();
    expect(displayCommand(`node ${dir}/build.js`, dir)).toBe("node [workspace]/build.js");
  });
});

describe("runCommand", () => {
  it("marks a zero-exit command as passed", () => {
    const r = runCommand("build", "true", tmp(), 5_000);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("marks a non-zero-exit command as failed and captures output", () => {
    const r = runCommand("test", "echo boom >&2; exit 3", tmp(), 5_000);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.outputTail).toContain("boom");
  });

  it("flags a command that exceeds its timeout", () => {
    const r = runCommand("test", "sleep 5", tmp(), 100);
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  it("redacts secrets and scrubs the workspace path from captured output", () => {
    const dir = tmp();
    const r = runCommand("test", `echo ${SECRET}; echo ${dir}/src/x.ts`, dir, 5_000);
    expect(r.outputTail).not.toContain(SECRET);
    expect(r.outputTail).not.toContain(dir);
    expect(r.outputTail).toContain("[REDACTED]");
    expect(r.outputTail).toContain("[workspace]");
  });
});

describe("verifyTask", () => {
  it("runs detected canonical commands in order and reports pass", () => {
    const dir = tmp();
    write(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { build: "echo b", test: "echo t", typecheck: "echo tc", lint: "echo l" },
      }),
    );
    const report = verifyTask({ workspace: dir });
    expect(report.verdict).toBe("pass");
    expect(report.results.map((r) => r.name)).toEqual(["build", "test", "typecheck", "lint"]);
  });

  it("executes exactly the command set the planner derives", () => {
    const dir = tmp();
    write(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { build: "echo b", test: "echo t", typecheck: "echo tc", lint: "echo l" },
      }),
    );
    const report = verifyTask({ workspace: dir });
    const planned = deriveVerifyCommands(collectRepoContext({ workspace: dir }));
    expect(report.results.map((r) => r.command)).toEqual(planned);
  });

  it("reports fail when a detected command fails", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "true", test: "false" } }));
    const report = verifyTask({ workspace: dir });
    expect(report.verdict).toBe("fail");
    expect(report.results.find((r) => r.name === "build")?.passed).toBe(true);
    expect(report.results.find((r) => r.name === "test")?.passed).toBe(false);
  });

  it("degrades gracefully when no canonical command is detected", () => {
    const report = verifyTask({ workspace: tmp() });
    expect(report.verdict).toBe("no-verify-commands");
    expect(report.results).toEqual([]);
  });

  it("binds the verdict to the repo head when in a repository", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "true" } }));
    initRepo(dir);
    const report = verifyTask({ workspace: dir });
    expect(report.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a null head outside a repository", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "true" } }));
    const report = verifyTask({ workspace: dir });
    expect(report.head).toBeNull();
  });

  it("never leaks the workspace path or secrets in the JSON verdict", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: `echo ${SECRET}; echo ${dir}/x` } }));
    const json = JSON.stringify(verifyTask({ workspace: dir }));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(dir);
  });
});

describe("formatVerifyReport", () => {
  it("renders the verdict, head, and per-command results", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "true", test: "true" } }));
    const text = formatVerifyReport(verifyTask({ workspace: dir }));
    expect(text).toContain("Task verification (oh-my-cli.task-verify v1)");
    expect(text).toContain("Verdict: pass");
    expect(text).toContain("[PASS] build");
    expect(text).toContain("[PASS] test");
  });

  it("renders the no-command case", () => {
    const text = formatVerifyReport(verifyTask({ workspace: tmp() }));
    expect(text).toContain("Verdict: no-verify-commands");
    expect(text).toContain("No canonical verification command detected");
  });

  it("shows a failing command's redacted output tail", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: "echo boom >&2; exit 1" } }));
    const text = formatVerifyReport(verifyTask({ workspace: dir }));
    expect(text).toContain("Verdict: fail");
    expect(text).toContain("[FAIL] test");
    expect(text).toContain("boom");
  });
});
