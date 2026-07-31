import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_CONTINUITY_SCHEMA,
  SESSION_CONTINUITY_VERSION,
  CONTINUITY_CONCEPT_IDS,
  continuityConceptLabels,
  collectContinuity,
  resolveBoundHead,
  assertHeadCurrent,
  formatContinuity,
  formatContinuityCompact,
} from "../../src/session-continuity.js";
import { CONCEPT_CONTRACT, conceptById } from "../../src/concept-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-continuity-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// Create a REAL git repository with one commit and return its path and exact HEAD
// sha. Continuity state is resolved from genuine git state, never simulated.
function initRepo(): { dir: string; head: string } {
  const dir = tmpDir();
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q"]);
  git(["config", "user.name", "Continuity Test"]);
  git(["config", "user.email", "continuity@example.com"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "seed"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  return { dir, head };
}

function commitAgain(dir: string, file: string): string {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  git(["add", file]);
  git(["commit", "-q", "-m", `add ${file}`]);
  return git(["rev-parse", "HEAD"]).trim();
}

describe("session continuity constants", () => {
  it("exposes a stable schema id and version", () => {
    expect(SESSION_CONTINUITY_SCHEMA).toBe("oh-my-cli.session-continuity");
    expect(SESSION_CONTINUITY_VERSION).toBe(1);
  });
});

describe("contract conformance (TUI adopts the #300 contract, no divergence)", () => {
  it("renders exactly the canonical concept ids, in contract order", () => {
    expect(CONTINUITY_CONCEPT_IDS).toEqual(CONCEPT_CONTRACT.map((c) => c.id));
  });

  it("renders each concept label from the contract itself (id + canonical name)", () => {
    const labels = continuityConceptLabels();
    expect(labels).toEqual(CONCEPT_CONTRACT.map((c) => ({ id: c.id, name: c.name })));
    for (const label of labels) {
      expect(label.name).toBe(conceptById(label.id).name);
    }
  });

  it("carries the canonical labels into the collected continuity state", () => {
    const { dir } = initRepo();
    const state = collectContinuity({ workspace: dir });
    expect(state.concepts).toEqual(CONCEPT_CONTRACT.map((c) => ({ id: c.id, name: c.name })));
  });
});

describe("collectContinuity: real git state", () => {
  it("resolves the real bound head, branch, and a clean worktree", () => {
    const { dir, head } = initRepo();
    const state = collectContinuity({ workspace: dir });
    expect(state.repo).toBe(true);
    expect(state.boundHead).toBe(head);
    expect(state.boundHead).toMatch(/^[0-9a-f]{40}$/);
    expect(state.detached).toBe(false);
    expect(state.clean).toBe(true);
    expect(state.dirtyCount).toBe(0);
    expect(state.surface).toBe("tui");
  });

  it("reflects resolveBoundHead exactly", () => {
    const { dir, head } = initRepo();
    expect(resolveBoundHead(dir)).toBe(head);
  });

  it("tracks the head when it moves and reports a dirty worktree honestly", () => {
    const { dir, head } = initRepo();
    const head2 = commitAgain(dir, "a.txt");
    expect(head2).not.toBe(head);
    const state = collectContinuity({ workspace: dir });
    expect(state.boundHead).toBe(head2);
    expect(state.clean).toBe(true);
    // An uncommitted change makes the worktree dirty (real status, not simulated).
    fs.writeFileSync(path.join(dir, "uncommitted.txt"), "x\n");
    const dirty = collectContinuity({ workspace: dir });
    expect(dirty.clean).toBe(false);
    expect(dirty.dirtyCount).toBe(1);
  });

  it("reports a non-repository workspace without error", () => {
    const dir = tmpDir();
    const state = collectContinuity({ workspace: dir });
    expect(state.repo).toBe(false);
    expect(state.boundHead).toBeNull();
    expect(state.headRef).toBeNull();
    expect(resolveBoundHead(dir)).toBeNull();
  });
});

describe("collectContinuity: pending approvals are real, never invented", () => {
  it("defaults to zero pending approvals", () => {
    const { dir } = initRepo();
    expect(collectContinuity({ workspace: dir }).pendingApprovals).toBe(0);
  });

  it("reflects a caller-supplied real count and floors invalid values to zero", () => {
    const { dir } = initRepo();
    expect(collectContinuity({ workspace: dir, pendingApprovals: 3 }).pendingApprovals).toBe(3);
    expect(collectContinuity({ workspace: dir, pendingApprovals: -2 }).pendingApprovals).toBe(0);
    expect(collectContinuity({ workspace: dir, pendingApprovals: NaN }).pendingApprovals).toBe(0);
  });
});

describe("assertHeadCurrent: stale-head guard uses the canonical failure semantic", () => {
  it("allows a mutation when the head is current", () => {
    const { dir, head } = initRepo();
    const guard = assertHeadCurrent(head, { workspace: dir });
    expect(guard.ok).toBe(true);
    expect(guard.currentHead).toBe(head);
  });

  it("refuses a mutation against a moved head with the canonical delivery-state semantic", () => {
    const { dir, head } = initRepo();
    const head2 = commitAgain(dir, "b.txt");
    const guard = assertHeadCurrent(head, { workspace: dir });
    expect(guard.ok).toBe(false);
    expect(guard.currentHead).toBe(head2);
    // The rejection carries the contract's canonical failure semantic, not an
    // ad-hoc TUI-local message.
    expect(guard.reason).toContain(conceptById("delivery-state").failureSemantic);
    expect(guard.reason).toContain(head.slice(0, 12));
    expect(guard.reason).toContain(head2.slice(0, 12));
  });

  it("treats a non-repository workspace as having no head to guard", () => {
    const dir = tmpDir();
    const guard = assertHeadCurrent("0".repeat(40), { workspace: dir });
    expect(guard.ok).toBe(true);
    expect(guard.currentHead).toBeNull();
  });
});

describe("formatContinuity", () => {
  it("renders the real state and canonical concept labels", () => {
    const { dir, head } = initRepo();
    const out = formatContinuity(collectContinuity({ workspace: dir, pendingApprovals: 2 }));
    expect(out).toContain(SESSION_CONTINUITY_SCHEMA);
    expect(out).toContain("Surface:  TUI (surface of origin)");
    expect(out).toContain(`Bound head: ${head}`);
    expect(out).toContain("Worktree:   clean");
    expect(out).toContain("Pending approvals: 2");
    expect(out).toContain("Conversation");
    expect(out).toContain("Delivery state");
  });

  it("renders a non-repository workspace safely", () => {
    const out = formatContinuity(collectContinuity({ workspace: tmpDir() }));
    expect(out).toContain("Bound head: (not a git repository)");
  });
});

describe("formatContinuityCompact", () => {
  it("renders a compact view with the bound head and canonical concepts", () => {
    const { dir, head } = initRepo();
    const out = formatContinuityCompact(collectContinuity({ workspace: dir }));
    expect(out).toContain("Continuity (TUI)");
    expect(out).toContain(head.slice(0, 12));
    expect(out).toContain("pending approvals: 0");
    expect(out).toContain("Conversation");
  });
});
