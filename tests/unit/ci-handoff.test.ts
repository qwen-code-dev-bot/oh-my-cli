import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectCiHandoff,
  formatCiHandoffReport,
  buildCiHandoffReport,
  CI_HANDOFF_SCHEMA,
  CI_HANDOFF_VERSION,
} from "../../src/ci-handoff.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cih-"));
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

function stage(dir: string): void {
  git(dir, ["add", "-A"]);
}

// A repo whose package.json declares fast canonical commands so verifyTask
// (build/test) runs in milliseconds.
function initRepoWithCommands(dir: string): void {
  write(dir, "package.json", JSON.stringify({ name: "x", scripts: { build: "true", test: "true" } }));
  write(dir, "src/foo.ts", "export const x = 1;\n");
  initRepo(dir);
}

const SECRET = "ghp_" + "a".repeat(36);

function signals(over: Partial<ReturnType<typeof baseSignals>> = {}) {
  return { ...baseSignals(), ...over };
}
function baseSignals() {
  return {
    secretsIntroduced: 0,
    protectedPaths: [] as string[],
    sourceWithoutTests: false,
    oversized: false,
    dependenciesAdded: [] as string[],
  };
}

function facts(over: Partial<Parameters<typeof buildCiHandoffReport>[0]> = {}) {
  return {
    head: "f".repeat(40),
    base: { ref: "origin/main", sha: "0".repeat(40) },
    filesChanged: 2,
    linesAdded: 8,
    linesRemoved: 1,
    commands: [
      { name: "build" as const, command: "tsc", localPassed: true, timedOut: false, exitCode: 0 },
      { name: "test" as const, command: "vitest run tests/unit", localPassed: true, timedOut: false, exitCode: 0 },
    ],
    reviewSignals: baseSignals(),
    verifyVerdict: "pass" as const,
    ...over,
  };
}

describe("buildCiHandoffReport (pure)", () => {
  it("returns no-change when nothing changed", () => {
    const r = buildCiHandoffReport(facts({ filesChanged: 0 }));
    expect(r.verdict).toBe("no-change");
    expect(r.blockers).toEqual([]);
  });

  it("returns ready-for-ci for a clean change with passing verify", () => {
    const r = buildCiHandoffReport(facts());
    expect(r.verdict).toBe("ready-for-ci");
    expect(r.blockers).toEqual([]);
  });

  it("flags introduced secrets as a local blocker", () => {
    const r = buildCiHandoffReport(facts({ reviewSignals: signals({ secretsIntroduced: 2 }) }));
    expect(r.verdict).toBe("local-blockers");
    expect(r.blockers.some((b) => /secret-like/.test(b))).toBe(true);
  });

  it("flags a mutated protected path as a local blocker", () => {
    const r = buildCiHandoffReport(
      facts({ reviewSignals: signals({ protectedPaths: ["AUTONOMY.md"] }) }),
    );
    expect(r.verdict).toBe("local-blockers");
    expect(r.blockers.some((b) => b.includes("AUTONOMY.md"))).toBe(true);
  });

  it("flags failing local verification as a local blocker", () => {
    const r = buildCiHandoffReport(facts({ verifyVerdict: "fail" }));
    expect(r.verdict).toBe("local-blockers");
    expect(r.blockers.some((b) => /verification failed/.test(b))).toBe(true);
  });

  it("combines multiple blockers", () => {
    const r = buildCiHandoffReport(
      facts({ verifyVerdict: "fail", reviewSignals: signals({ secretsIntroduced: 1 }) }),
    );
    expect(r.verdict).toBe("local-blockers");
    expect(r.blockers.length).toBe(2);
  });

  it("treats no-verify-commands as ready-for-ci, not a blocker", () => {
    const r = buildCiHandoffReport(facts({ commands: [], verifyVerdict: "no-verify-commands" }));
    expect(r.verdict).toBe("ready-for-ci");
    expect(r.blockers).toEqual([]);
  });

  it("no-change takes precedence even when local verify fails", () => {
    const r = buildCiHandoffReport(facts({ filesChanged: 0, verifyVerdict: "fail" }));
    expect(r.verdict).toBe("no-change");
    expect(r.blockers).toEqual([]);
  });

  it("surfaces advisory signals without making them blockers", () => {
    const r = buildCiHandoffReport(
      facts({ reviewSignals: signals({ sourceWithoutTests: true, oversized: true, dependenciesAdded: ["zod"] }) }),
    );
    expect(r.verdict).toBe("ready-for-ci");
    expect(r.review.sourceWithoutTests).toBe(true);
    expect(r.review.oversized).toBe(true);
    expect(r.review.dependenciesAdded).toContain("zod");
  });

  it("bounds the command list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: "build" as const,
      command: `c${i}`,
      localPassed: true,
      timedOut: false,
      exitCode: 0,
    }));
    const r = buildCiHandoffReport(facts({ commands: many }));
    expect(r.commands.length).toBe(8);
  });

  it("is deterministic for identical facts", () => {
    const f = facts({ verifyVerdict: "fail" });
    expect(buildCiHandoffReport(f)).toEqual(buildCiHandoffReport(f));
  });

  it("carries schema/version and head/base binding", () => {
    const r = buildCiHandoffReport(facts());
    expect(r.schema).toBe(CI_HANDOFF_SCHEMA);
    expect(r.v).toBe(CI_HANDOFF_VERSION);
    expect(r.head).toBe("f".repeat(40));
    expect(r.base.ref).toBe("origin/main");
  });
});

describe("collectCiHandoff (real git + commands)", () => {
  it("reports ready-for-ci for a clean change with passing commands", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    stage(dir);
    const r = collectCiHandoff({ workspace: dir });
    expect(r.verdict).toBe("ready-for-ci");
    expect(r.commands.length).toBeGreaterThan(0);
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("binds the brief to the repository head SHA", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    stage(dir);
    const r = collectCiHandoff({ workspace: dir });
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("flags an introduced secret in an untracked file as a local blocker", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n`);
    const r = collectCiHandoff({ workspace: dir });
    expect(r.verdict).toBe("local-blockers");
    expect(r.review.secretsIntroduced).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("flags failing local verification as a local blocker", () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ name: "x", scripts: { build: "true", test: "false" } }));
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    stage(dir);
    const r = collectCiHandoff({ workspace: dir });
    expect(r.verdict).toBe("local-blockers");
    expect(r.blockers.some((b) => /verification failed/.test(b))).toBe(true);
  });

  it("reports no-change for a clean repository", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    const r = collectCiHandoff({ workspace: dir });
    expect(r.verdict).toBe("no-change");
    expect(r.changeSummary.filesChanged).toBe(0);
  });

  it("never leaks the workspace path or secrets in the JSON brief", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n${dir}/src/secret.ts\n`);
    const json = JSON.stringify(collectCiHandoff({ workspace: dir }));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(dir);
  });
});

describe("formatCiHandoffReport", () => {
  it("renders a ready-for-ci brief", () => {
    const text = formatCiHandoffReport(buildCiHandoffReport(facts()));
    expect(text).toContain("CI handoff (oh-my-cli.ci-handoff v1)");
    expect(text).toContain("Verdict: ready-for-ci");
    expect(text).toContain("Commands for CI:");
    expect(text).toContain("Blockers: none");
  });

  it("renders a no-change brief", () => {
    const text = formatCiHandoffReport(buildCiHandoffReport(facts({ filesChanged: 0 })));
    expect(text).toContain("Verdict: no-change");
    expect(text).toContain("No changes to hand off.");
  });

  it("renders a local-blockers brief with the blocker reasons", () => {
    const r = buildCiHandoffReport(facts({ reviewSignals: signals({ secretsIntroduced: 1 }) }));
    const text = formatCiHandoffReport(r);
    expect(text).toContain("Verdict: local-blockers");
    expect(text).toContain("Blockers:");
    expect(text).toContain("secret-like");
  });
});
