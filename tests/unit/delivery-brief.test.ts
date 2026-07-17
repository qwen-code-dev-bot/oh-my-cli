import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDeliveryBrief,
  collectDeliveryBrief,
  formatDeliveryBrief,
  parseCiResult,
  DELIVERY_BRIEF_SCHEMA,
  DELIVERY_BRIEF_VERSION,
} from "../../src/delivery-brief.js";
import type { CiHandoffCommand } from "../../src/ci-handoff.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dlb-"));
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

// A repo whose package.json declares fast canonical commands so the handoff
// slice (build/test) runs in milliseconds.
function initRepoWithCommands(dir: string, scripts = { build: "true", test: "true" }): void {
  write(dir, "package.json", JSON.stringify({ name: "x", scripts }));
  write(dir, "src/foo.ts", "export const x = 1;\n");
  initRepo(dir);
}

const SECRET = "ghp_" + "a".repeat(36);

function cmd(over: Partial<CiHandoffCommand> = {}): CiHandoffCommand {
  return { name: "build", command: "tsc", localPassed: true, timedOut: false, exitCode: 0, ...over };
}

function facts(over: Partial<Parameters<typeof buildDeliveryBrief>[0]> = {}) {
  return {
    head: "f".repeat(40),
    base: { ref: "origin/main", sha: "0".repeat(40) },
    filesChanged: 2,
    linesAdded: 8,
    linesRemoved: 1,
    commands: [cmd(), cmd({ name: "test", command: "vitest run tests/unit" })],
    secretsIntroduced: 0,
    protectedPaths: [] as string[],
    planGrounded: true,
    ciResult: "pass" as const,
    ...over,
  };
}

describe("parseCiResult", () => {
  it("defaults to pending when omitted", () => {
    expect(parseCiResult(undefined)).toBe("pending");
  });

  it("accepts the bounded enum case-insensitively", () => {
    expect(parseCiResult("pass")).toBe("pass");
    expect(parseCiResult("PASS")).toBe("pass");
    expect(parseCiResult("fail")).toBe("fail");
    expect(parseCiResult("pending")).toBe("pending");
  });

  it("rejects out-of-enum input", () => {
    expect(() => parseCiResult("green")).toThrow(/invalid CI result/);
  });
});

describe("buildDeliveryBrief (pure)", () => {
  it("returns ship for an all-clear change", () => {
    const r = buildDeliveryBrief(facts());
    expect(r.verdict).toBe("ship");
    expect(r.blockers).toEqual([]);
    expect(r.holds).toEqual([]);
  });

  it("returns no-ship when CI failed", () => {
    const r = buildDeliveryBrief(facts({ ciResult: "fail" }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.some((b) => /CI failed/.test(b))).toBe(true);
  });

  it("returns hold when CI is pending", () => {
    const r = buildDeliveryBrief(facts({ ciResult: "pending" }));
    expect(r.verdict).toBe("hold");
    expect(r.holds.some((b) => /CI pending/.test(b))).toBe(true);
  });

  it("returns no-ship when a local verify command failed", () => {
    const r = buildDeliveryBrief(facts({ commands: [cmd(), cmd({ name: "test", localPassed: false, exitCode: 1 })] }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.some((b) => /verification failed/.test(b))).toBe(true);
  });

  it("returns no-ship when a secret was introduced", () => {
    const r = buildDeliveryBrief(facts({ secretsIntroduced: 2 }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.some((b) => /secret-like/.test(b))).toBe(true);
  });

  it("returns no-ship when a protected path was mutated", () => {
    const r = buildDeliveryBrief(facts({ protectedPaths: ["AUTONOMY.md"] }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.some((b) => b.includes("AUTONOMY.md"))).toBe(true);
  });

  it("returns hold when there is no change to deliver", () => {
    const r = buildDeliveryBrief(facts({ filesChanged: 0 }));
    expect(r.verdict).toBe("hold");
    expect(r.holds.some((b) => /no change to deliver/.test(b))).toBe(true);
  });

  it("returns hold when the plan has no grounded verification command", () => {
    const r = buildDeliveryBrief(facts({ planGrounded: false }));
    expect(r.verdict).toBe("hold");
    expect(r.holds.some((b) => /no grounded verification command/.test(b))).toBe(true);
  });

  it("does not hold on an ungrounded plan when there is no change", () => {
    const r = buildDeliveryBrief(facts({ filesChanged: 0, planGrounded: false }));
    expect(r.verdict).toBe("hold");
    expect(r.holds).toEqual(["no change to deliver"]);
  });

  it("a blocker takes precedence over a hold", () => {
    const r = buildDeliveryBrief(facts({ secretsIntroduced: 1, ciResult: "pending" }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("combines multiple blockers", () => {
    const r = buildDeliveryBrief(facts({ secretsIntroduced: 1, protectedPaths: ["AUTONOMY.md"], ciResult: "fail" }));
    expect(r.verdict).toBe("no-ship");
    expect(r.blockers.length).toBe(3);
  });

  it("emits the five contributing signals in canonical order", () => {
    const r = buildDeliveryBrief(facts());
    expect(r.signals.map((s) => s.name)).toEqual(["plan", "verify", "review", "handoff", "ci"]);
    expect(r.signals.find((s) => s.name === "ci")?.status).toBe("pass");
  });

  it("is deterministic for identical facts", () => {
    const f = facts({ ciResult: "fail", secretsIntroduced: 1 });
    expect(buildDeliveryBrief(f)).toEqual(buildDeliveryBrief(f));
  });

  it("carries schema/version and head/base binding", () => {
    const r = buildDeliveryBrief(facts());
    expect(r.schema).toBe(DELIVERY_BRIEF_SCHEMA);
    expect(r.v).toBe(DELIVERY_BRIEF_VERSION);
    expect(r.head).toBe("f".repeat(40));
    expect(r.base.ref).toBe("origin/main");
  });
});

describe("collectDeliveryBrief (real git + commands)", () => {
  it("ships a clean change with passing commands and CI pass", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = collectDeliveryBrief({ workspace: dir, ciResult: "pass" });
    expect(r.verdict).toBe("ship");
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("holds a clean change when CI is still pending (default)", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = collectDeliveryBrief({ workspace: dir });
    expect(r.verdict).toBe("hold");
    expect(r.holds.some((b) => /CI pending/.test(b))).toBe(true);
  });

  it("returns no-ship when a secret is introduced", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n`);
    const r = collectDeliveryBrief({ workspace: dir, ciResult: "pass" });
    expect(r.verdict).toBe("no-ship");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("returns hold for a clean repository (no change)", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    const r = collectDeliveryBrief({ workspace: dir, ciResult: "pass" });
    expect(r.verdict).toBe("hold");
    expect(r.changeSummary.filesChanged).toBe(0);
  });

  it("never leaks the workspace path or secrets in the JSON brief", () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n${dir}/src/secret.ts\n`);
    const json = JSON.stringify(collectDeliveryBrief({ workspace: dir, ciResult: "pass" }));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(dir);
  });
});

describe("formatDeliveryBrief", () => {
  it("renders a ship brief", () => {
    const text = formatDeliveryBrief(buildDeliveryBrief(facts()));
    expect(text).toContain("Delivery brief (oh-my-cli.delivery-brief v1)");
    expect(text).toContain("Verdict: ship");
    expect(text).toContain("Signals:");
    expect(text).toContain("Blockers: none");
    expect(text).toContain("Holds: none");
  });

  it("renders a no-ship brief with blocker reasons", () => {
    const text = formatDeliveryBrief(buildDeliveryBrief(facts({ ciResult: "fail" })));
    expect(text).toContain("Verdict: no-ship");
    expect(text).toContain("Blockers:");
    expect(text).toContain("CI failed");
  });

  it("renders a hold brief with hold reasons", () => {
    const text = formatDeliveryBrief(buildDeliveryBrief(facts({ ciResult: "pending" })));
    expect(text).toContain("Verdict: hold");
    expect(text).toContain("Holds:");
    expect(text).toContain("CI pending");
  });
});
