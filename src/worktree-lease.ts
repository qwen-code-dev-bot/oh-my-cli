// Leased git worktrees: one isolated workspace per mutating delegated agent.
//
// Two mutating agents in one workspace can silently overwrite or corrupt each
// other's work, so the shared-workspace guard refuses them. This module is the
// safe alternative it points at: it carves out a *leased* git worktree for one
// mutating agent and removes it again only after the agent's work is verified
// complete. The lease identity (branch + worktree path) is derived
// deterministically from the repository, the task, and the agent, so the same
// task+agent always maps to the same lease (collision-safe and idempotent),
// while different agents never collide.
//
// Safety is fail-closed and never destructive:
//   - Creation refuses a non-repository, a dirty parent worktree, an ambiguous
//     target (missing identity, or a repository with no commit to base from),
//     or an already-leased identity — before any mutation.
//   - Cleanup refuses to remove a worktree with uncommitted changes or a branch
//     with unmerged commits; it uses only non-forcing git commands and never
//     touches the parent worktree. There is no automatic merge and no forced
//     removal in this slice.
//   - Both operations are idempotent across interruption: re-creating an
//     existing lease returns it, and cleaning an absent lease is a no-op.
// All emitted evidence is redacted (host home paths collapsed, secrets
// removed) so credentials and private paths never reach the output.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets, redactHomePath } from "./permission-impact.js";

export const WORKTREE_LEASE_SCHEMA = "oh-my-cli.worktree-lease";
export const WORKTREE_LEASE_VERSION = 1;

export const WORKTREE_GRAPH_SCHEMA = "oh-my-cli.worktree-graph";
export const WORKTREE_GRAPH_VERSION = 1;

export const WORKTREE_HANDOFF_SCHEMA = "oh-my-cli.worktree-handoff";
export const WORKTREE_HANDOFF_VERSION = 1;

/** Options shared by lease creation and cleanup. */
export interface WorktreeLeaseOptions {
  /** The parent repository workspace the lease is carved from. */
  repo: string;
  /** Stable identity of the task the agent is performing. */
  taskIdentity: string;
  /** Stable identity of the mutating agent the lease is for. */
  agentIdentity: string;
  /**
   * Where leased worktrees live. Defaults to `<repo>/.oh-my-cli/worktrees`,
   * which is git-ignored. Override to keep worktrees outside the working tree.
   */
  worktreeRoot?: string;
}

/** Redacted, durable evidence describing a lease. */
export interface WorktreeLease {
  schema: typeof WORKTREE_LEASE_SCHEMA;
  v: typeof WORKTREE_LEASE_VERSION;
  /** Collision-safe id derived from repository + task + agent. */
  leaseId: string;
  /** The lease branch, `lease/wt-<leaseId>`. */
  branch: string;
  /** Home-collapsed absolute path to the leased worktree. */
  worktreePath: string;
  /** Commit the lease branch was based on ("" when the lease is absent). */
  baseSha: string;
  /** Redacted task identity. */
  taskIdentity: string;
  /** Redacted agent identity. */
  agentIdentity: string;
}

/** Why a lease creation was refused before any mutation. */
export type WorktreeCreateRefusalReason =
  | "non_repository"
  | "dirty"
  | "ambiguous"
  | "already_leased"
  | "git_error";

/** Why a lease cleanup was refused (the lease is retained safely). */
export type WorktreeCleanRefusalReason =
  | "non_repository"
  | "ambiguous"
  | "uncommitted_changes"
  | "unmerged_commits"
  | "git_error";

export type WorktreeCreateResult =
  | { ok: true; lease: WorktreeLease; created: boolean }
  | { ok: false; reason: WorktreeCreateRefusalReason; message: string };

export type WorktreeCleanResult =
  | { ok: true; lease: WorktreeLease; cleaned: boolean }
  | { ok: false; reason: WorktreeCleanRefusalReason; message: string };

/** Why a lease cancellation was refused (the lease is retained safely). */
export type WorktreeCancelRefusalReason =
  | "non_repository"
  | "ambiguous"
  | "uncommitted_changes"
  | "git_error";

/** A commit preserved on the lease branch by a cancellation (bounded, redacted). */
export interface PreservedCommit {
  sha: string;
  subject: string;
}

/** The committed work a cancellation preserves on the (kept) lease branch. */
export interface WorktreeCancelPreserved {
  branch: string;
  commits: PreservedCommit[];
  truncatedCommits: number;
}

export type WorktreeCancelResult =
  | {
      ok: true;
      lease: WorktreeLease;
      /** False when the lease was already absent (idempotent no-op). */
      cancelled: boolean;
      worktreeRemoved: boolean;
      /** True when uncommitted work was discarded via --cancel-force. */
      forced: boolean;
      preserved: WorktreeCancelPreserved;
    }
  | { ok: false; reason: WorktreeCancelRefusalReason; message: string };

/** One leased parallel workspace in the operator-visible graph (read-only). */
export interface WorktreeGraphEntry {
  /** Home-collapsed absolute path to the leased worktree. */
  worktreePath: string;
  /** Branch checked out in the worktree ("(detached)" when detached). */
  branch: string;
  /** Abbreviated HEAD commit of the worktree. */
  head: string;
  /** True when the worktree has uncommitted changes. */
  dirty: boolean;
}

/** A bounded, redacted, read-only view of the repository's leased workspaces. */
export interface WorktreeGraph {
  schema: typeof WORKTREE_GRAPH_SCHEMA;
  v: typeof WORKTREE_GRAPH_VERSION;
  /** Home-collapsed lease worktree root that was enumerated. */
  worktreeRoot: string;
  entries: WorktreeGraphEntry[];
  /** Count of workspaces beyond the bound (0 when none). */
  truncated: number;
}

/**
 * A bounded, redacted, read-only handoff brief for one specific leased workspace:
 * the agent's branch, the commits it made, the paths it changed, and its
 * clean/dirty state — for review before integration (#228) or cancellation (#230).
 */
export interface WorktreeHandoff {
  schema: typeof WORKTREE_HANDOFF_SCHEMA;
  v: typeof WORKTREE_HANDOFF_VERSION;
  leaseId: string;
  branch: string;
  /** Home-collapsed absolute path to the leased worktree. */
  worktreePath: string;
  /** False when no lease exists for this identity (an absent handoff). */
  present: boolean;
  /** Abbreviated branch head ("" when absent). */
  head: string;
  /** True when the worktree has uncommitted changes. */
  dirty: boolean;
  /** Commits the agent made (branch commits not in the parent HEAD), bounded. */
  commits: PreservedCommit[];
  truncatedCommits: number;
  /** Paths the agent changed (relative to the merge-base), bounded and redacted. */
  changedPaths: string[];
  truncatedPaths: number;
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

// --- identity (pure) --------------------------------------------------------

export interface LeaseIdentityInput {
  /** Canonical repository key (the git common directory's real path). */
  repoKey: string;
  taskIdentity: string;
  agentIdentity: string;
}

export interface LeaseIdentity {
  /** 16 hex chars; stable for one (repo, task, agent), unique across them. */
  leaseId: string;
  branch: string;
}

/**
 * Derive a collision-safe lease identity. The same (repository, task, agent)
 * always yields the same lease, while any difference in those inputs yields a
 * different lease — so distinct agents never share a branch or worktree, and a
 * repeated request is naturally idempotent.
 */
export function deriveLeaseIdentity(input: LeaseIdentityInput): LeaseIdentity {
  const digest = createHash("sha256")
    .update([input.repoKey, input.taskIdentity, input.agentIdentity].join("\u0000"), "utf8")
    .digest("hex");
  const leaseId = digest.slice(0, 16);
  return { leaseId, branch: `lease/wt-${leaseId}` };
}

// --- git helpers ------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeoutMs = 15_000): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Canonical repository identity: the shared git common directory's real path,
// or null when the path is not in a repository. Equal keys mean one repository,
// so a lease derived from any of its worktrees resolves to the same identity.
function repoCommonDir(repo: string): string | null {
  const r = git(repo, ["rev-parse", "--git-common-dir"]);
  const out = r.stdout.trim();
  if (!r.ok || !out) return null;
  const abs = path.isAbsolute(out) ? out : path.resolve(repo, out);
  return safeRealpath(abs);
}

// The main worktree root that anchors the default lease directory.
function defaultWorktreeRoot(commonDir: string): string {
  const anchor = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  return path.join(anchor, ".oh-my-cli", "worktrees");
}

function branchRefExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function worktreeRegistered(repo: string, worktreePath: string): boolean {
  const out = git(repo, ["worktree", "list", "--porcelain"]).stdout;
  const target = safeRealpath(worktreePath);
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const listed = line.slice("worktree ".length).trim();
    if (listed === worktreePath || safeRealpath(listed) === target) return true;
  }
  return false;
}

function dirtyCount(cwd: string): number {
  return git(cwd, ["status", "--porcelain"])
    .stdout.split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function buildLease(parts: {
  identity: LeaseIdentity;
  worktreePath: string;
  baseSha: string;
  taskIdentity: string;
  agentIdentity: string;
}): WorktreeLease {
  return {
    schema: WORKTREE_LEASE_SCHEMA,
    v: WORKTREE_LEASE_VERSION,
    leaseId: parts.identity.leaseId,
    branch: parts.identity.branch,
    worktreePath: redactHomePath(parts.worktreePath),
    baseSha: parts.baseSha,
    taskIdentity: redact(parts.taskIdentity),
    agentIdentity: redact(parts.agentIdentity),
  };
}

// --- lifecycle --------------------------------------------------------------

/**
 * Create a leased worktree for one mutating agent, or return the existing lease
 * idempotently. Refuses — before any mutation — a non-repository, a dirty parent
 * worktree, an ambiguous target, or an already-leased identity in a partial or
 * conflicting state.
 */
export function createWorktreeLease(opts: WorktreeLeaseOptions): WorktreeCreateResult {
  const repo = path.resolve(opts.repo);
  const task = (opts.taskIdentity ?? "").trim();
  const agent = (opts.agentIdentity ?? "").trim();
  if (!task || !agent) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "both --task-identity and --agent-identity are required to derive a lease",
    };
  }

  const commonDir = repoCommonDir(repo);
  if (commonDir === null) {
    return { ok: false, reason: "non_repository", message: "target is not a git repository" };
  }

  const baseSha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (!baseSha) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "repository has no commit to base a lease on",
    };
  }

  const dirty = dirtyCount(repo);
  if (dirty > 0) {
    return {
      ok: false,
      reason: "dirty",
      message: `parent worktree has ${dirty} uncommitted change(s); commit or stash before leasing`,
    };
  }

  const identity = deriveLeaseIdentity({ repoKey: commonDir, taskIdentity: task, agentIdentity: agent });
  const worktreeRoot = path.resolve(opts.worktreeRoot ?? defaultWorktreeRoot(commonDir));
  const worktreePath = path.join(worktreeRoot, identity.leaseId);

  // Reconcile any stale admin entries left by an interrupted create.
  git(repo, ["worktree", "prune"]);

  const wtListed = worktreeRegistered(repo, worktreePath);
  const branchExists = branchRefExists(repo, identity.branch);

  if (wtListed && branchExists) {
    // The lease already exists and is intact — idempotent re-create.
    return {
      ok: true,
      created: false,
      lease: buildLease({ identity, worktreePath, baseSha, taskIdentity: task, agentIdentity: agent }),
    };
  }
  if (wtListed || branchExists || pathExists(worktreePath)) {
    // A partial or conflicting lease occupies this identity. Do not guess or
    // force; require an explicit clean first.
    return {
      ok: false,
      reason: "already_leased",
      message: `lease ${identity.branch} already exists in a partial or conflicting state; clean it before re-creating`,
    };
  }

  fs.mkdirSync(worktreeRoot, { recursive: true });
  const add = git(repo, ["worktree", "add", "-b", identity.branch, worktreePath, "HEAD"]);
  if (!add.ok) {
    return {
      ok: false,
      reason: "git_error",
      message: redact(`git worktree add failed: ${add.stderr.trim() || "unknown error"}`),
    };
  }

  return {
    ok: true,
    created: true,
    lease: buildLease({ identity, worktreePath, baseSha, taskIdentity: task, agentIdentity: agent }),
  };
}

/**
 * Clean a leased worktree after the agent's work is verified complete. Refuses
 * to remove a worktree with uncommitted changes or a branch with unmerged
 * commits; otherwise removes the worktree and deletes the branch with
 * non-forcing git commands. Idempotent: cleaning an absent lease is a no-op.
 * The parent worktree is never touched.
 */
export function cleanWorktreeLease(opts: WorktreeLeaseOptions): WorktreeCleanResult {
  const repo = path.resolve(opts.repo);
  const task = (opts.taskIdentity ?? "").trim();
  const agent = (opts.agentIdentity ?? "").trim();
  if (!task || !agent) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "both --task-identity and --agent-identity are required to locate a lease",
    };
  }

  const commonDir = repoCommonDir(repo);
  if (commonDir === null) {
    return { ok: false, reason: "non_repository", message: "target is not a git repository" };
  }

  const identity = deriveLeaseIdentity({ repoKey: commonDir, taskIdentity: task, agentIdentity: agent });
  const worktreeRoot = path.resolve(opts.worktreeRoot ?? defaultWorktreeRoot(commonDir));
  const worktreePath = path.join(worktreeRoot, identity.leaseId);

  const wtListed = worktreeRegistered(repo, worktreePath);
  const branchExists = branchRefExists(repo, identity.branch);
  const baseSha = git(repo, ["rev-parse", "--verify", "--quiet", identity.branch]).stdout.trim();
  const lease = buildLease({ identity, worktreePath, baseSha, taskIdentity: task, agentIdentity: agent });

  if (!wtListed && !branchExists) {
    // Already clean — idempotent no-op.
    return { ok: true, cleaned: false, lease };
  }

  // Never remove a worktree holding uncommitted work.
  if (wtListed && dirtyCount(worktreePath) > 0) {
    return {
      ok: false,
      reason: "uncommitted_changes",
      message: "lease worktree has uncommitted changes; commit or discard them before cleaning",
    };
  }

  // Never delete a branch whose commits are not yet merged into the parent.
  if (branchExists) {
    const parentHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const merged =
      parentHead !== "" &&
      git(repo, ["merge-base", "--is-ancestor", identity.branch, parentHead]).ok;
    if (!merged) {
      return {
        ok: false,
        reason: "unmerged_commits",
        message: `lease branch ${identity.branch} has unmerged commits; merge it before cleaning`,
      };
    }
  }

  // Safe, non-forcing removal. The worktree (if any) goes first so the branch is
  // no longer checked out when we delete it.
  if (wtListed) {
    const rm = git(repo, ["worktree", "remove", worktreePath]);
    if (!rm.ok) {
      return {
        ok: false,
        reason: "git_error",
        message: redact(`git worktree remove failed: ${rm.stderr.trim() || "unknown error"}`),
      };
    }
  }
  if (branchExists) {
    const del = git(repo, ["branch", "-d", identity.branch]);
    if (!del.ok) {
      return {
        ok: false,
        reason: "git_error",
        message: redact(`git branch -d failed: ${del.stderr.trim() || "unknown error"}`),
      };
    }
  }

  return { ok: true, cleaned: true, lease };
}

// Bound the preserved-commit list so a long-lived lease cannot inflate the report.
const MAX_PRESERVED_COMMITS = 50;

// List the lease branch's commits not yet in the parent HEAD — the work a
// cancellation preserves by keeping the branch. Bounded and redacted.
function collectPreservedCommits(repo: string, branch: string): WorktreeCancelPreserved {
  const parentHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (!parentHead || !branchRefExists(repo, branch)) {
    return { branch, commits: [], truncatedCommits: 0 };
  }
  const log = git(repo, ["log", "--format=%H%x09%s", `${parentHead}..${branch}`]);
  const lines = log.stdout.split("\n").filter((line) => line.trim() !== "");
  const commits = lines.slice(0, MAX_PRESERVED_COMMITS).map((line) => {
    const tab = line.indexOf("\t");
    const sha = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : "";
    return { sha: sha.slice(0, 12), subject: redact(subject) };
  });
  return { branch, commits, truncatedCommits: Math.max(0, lines.length - commits.length) };
}

/**
 * Cancel a leased workspace: the safe teardown path for a cancelled agent. Unlike
 * `cleanWorktreeLease` (which requires the work to be merged before deleting the
 * branch), cancellation PRESERVES committed work by keeping the lease branch and
 * only removing the worktree, so the agent's commits survive for later integration.
 * It fails closed when the worktree holds uncommitted changes that would be lost,
 * unless `force` acknowledges the discard. Idempotent: cancelling an absent lease
 * is a no-op. The parent worktree is never touched.
 */
export function cancelWorktreeLease(
  opts: WorktreeLeaseOptions,
  cancelOpts: { force?: boolean } = {},
): WorktreeCancelResult {
  const force = Boolean(cancelOpts.force);
  const repo = path.resolve(opts.repo);
  const task = (opts.taskIdentity ?? "").trim();
  const agent = (opts.agentIdentity ?? "").trim();
  if (!task || !agent) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "both --task-identity and --agent-identity are required to locate a lease",
    };
  }

  const commonDir = repoCommonDir(repo);
  if (commonDir === null) {
    return { ok: false, reason: "non_repository", message: "target is not a git repository" };
  }

  const identity = deriveLeaseIdentity({ repoKey: commonDir, taskIdentity: task, agentIdentity: agent });
  const worktreeRoot = path.resolve(opts.worktreeRoot ?? defaultWorktreeRoot(commonDir));
  const worktreePath = path.join(worktreeRoot, identity.leaseId);

  const wtListed = worktreeRegistered(repo, worktreePath);
  const branchExists = branchRefExists(repo, identity.branch);
  const baseSha = git(repo, ["rev-parse", "--verify", "--quiet", identity.branch]).stdout.trim();
  const lease = buildLease({ identity, worktreePath, baseSha, taskIdentity: task, agentIdentity: agent });
  const emptyPreserved: WorktreeCancelPreserved = { branch: identity.branch, commits: [], truncatedCommits: 0 };

  if (!wtListed && !branchExists) {
    // Already absent — idempotent no-op.
    return { ok: true, cancelled: false, worktreeRemoved: false, forced: force, lease, preserved: emptyPreserved };
  }

  // Fail closed on uncommitted work unless --force acknowledges the loss.
  const dirty = wtListed ? dirtyCount(worktreePath) : 0;
  if (dirty > 0 && !force) {
    return {
      ok: false,
      reason: "uncommitted_changes",
      message: `lease worktree has ${dirty} uncommitted change(s) that would be lost; commit them or pass --cancel-force to discard`,
    };
  }

  // Preserve committed work (the branch is kept), then remove the worktree.
  const preserved = collectPreservedCommits(repo, identity.branch);
  let worktreeRemoved = false;
  if (wtListed) {
    const rm = force
      ? git(repo, ["worktree", "remove", "--force", worktreePath])
      : git(repo, ["worktree", "remove", worktreePath]);
    if (!rm.ok) {
      return {
        ok: false,
        reason: "git_error",
        message: redact(`git worktree remove failed: ${rm.stderr.trim() || "unknown error"}`),
      };
    }
    worktreeRemoved = true;
  }

  return { ok: true, cancelled: true, worktreeRemoved, forced: force, lease, preserved };
}

// Bound the workspace graph so a repository with many leases cannot inflate output.
const MAX_GRAPH_ENTRIES = 100;

/**
 * Collect a read-only, bounded, redacted graph of the repository's leased parallel
 * workspaces: the worktrees under the lease worktree root, each with its branch,
 * abbreviated head, and clean/dirty state. Never mutates anything. Throws a
 * redacted error when the target is not a repository.
 */
export function collectWorktreeGraph(opts: { repo: string; worktreeRoot?: string }): WorktreeGraph {
  const repo = path.resolve(opts.repo);
  const commonDir = repoCommonDir(repo);
  if (commonDir === null) {
    throw new Error("Worktree graph error: target is not a git repository");
  }
  const worktreeRoot = path.resolve(opts.worktreeRoot ?? defaultWorktreeRoot(commonDir));
  const rootReal = safeRealpath(worktreeRoot);

  const entries: WorktreeGraphEntry[] = [];
  let current: { path?: string; head?: string; branch?: string; detached?: boolean } = {};
  const flush = (): void => {
    if (current.path) {
      const pathReal = safeRealpath(current.path);
      const underRoot =
        pathReal === rootReal ||
        pathReal.startsWith(rootReal + path.sep) ||
        current.path.startsWith(worktreeRoot + path.sep);
      if (underRoot && pathReal !== safeRealpath(repo)) {
        entries.push({
          worktreePath: redactHomePath(current.path),
          branch: current.detached || !current.branch ? "(detached)" : current.branch.replace(/^refs\/heads\//, ""),
          head: (current.head ?? "").slice(0, 12),
          dirty: dirtyCount(current.path) > 0,
        });
      }
    }
    current = {};
  };

  const out = git(repo, ["worktree", "list", "--porcelain"]).stdout;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line.trim() === "detached") {
      current.detached = true;
    }
  }
  flush();

  const bounded = entries.slice(0, MAX_GRAPH_ENTRIES);
  return {
    schema: WORKTREE_GRAPH_SCHEMA,
    v: WORKTREE_GRAPH_VERSION,
    worktreeRoot: redactHomePath(worktreeRoot),
    entries: bounded,
    truncated: Math.max(0, entries.length - bounded.length),
  };
}

// Bounds that keep a handoff brief bounded.
const MAX_HANDOFF_COMMITS = 50;
const MAX_HANDOFF_PATHS = 100;

/**
 * Collect a read-only, bounded, redacted handoff brief for one specific leased
 * workspace (identified by task+agent identity, reusing the lease derivation).
 * Reports the agent's branch, the commits it made (branch commits not in the
 * parent HEAD), the paths it changed (relative to the merge-base), and its
 * clean/dirty state. Never mutates anything. An absent lease yields present:false
 * (not an error). Throws a redacted error on a missing identity or non-repository.
 */
export function collectWorktreeHandoff(opts: WorktreeLeaseOptions): WorktreeHandoff {
  const repo = path.resolve(opts.repo);
  const task = (opts.taskIdentity ?? "").trim();
  const agent = (opts.agentIdentity ?? "").trim();
  if (!task || !agent) {
    throw new Error("Worktree handoff error: both --task-identity and --agent-identity are required");
  }
  const commonDir = repoCommonDir(repo);
  if (commonDir === null) {
    throw new Error("Worktree handoff error: target is not a git repository");
  }
  const identity = deriveLeaseIdentity({ repoKey: commonDir, taskIdentity: task, agentIdentity: agent });
  const worktreeRoot = path.resolve(opts.worktreeRoot ?? defaultWorktreeRoot(commonDir));
  const worktreePath = path.join(worktreeRoot, identity.leaseId);

  const wtListed = worktreeRegistered(repo, worktreePath);
  const branchExists = branchRefExists(repo, identity.branch);
  const handoff: WorktreeHandoff = {
    schema: WORKTREE_HANDOFF_SCHEMA,
    v: WORKTREE_HANDOFF_VERSION,
    leaseId: identity.leaseId,
    branch: identity.branch,
    worktreePath: redactHomePath(worktreePath),
    present: wtListed || branchExists,
    head: "",
    dirty: false,
    commits: [],
    truncatedCommits: 0,
    changedPaths: [],
    truncatedPaths: 0,
  };
  if (!handoff.present) return handoff;

  handoff.head = git(repo, ["rev-parse", "--verify", "--quiet", identity.branch]).stdout.trim().slice(0, 12);
  if (wtListed) {
    handoff.dirty = dirtyCount(worktreePath) > 0;
  }

  const parentHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (parentHead && branchExists) {
    const log = git(repo, ["log", "--format=%H%x09%s", `${parentHead}..${identity.branch}`]);
    const commitLines = log.stdout.split("\n").filter((line) => line.trim() !== "");
    handoff.commits = commitLines.slice(0, MAX_HANDOFF_COMMITS).map((line) => {
      const tab = line.indexOf("\t");
      const sha = tab >= 0 ? line.slice(0, tab) : line;
      const subject = tab >= 0 ? line.slice(tab + 1) : "";
      return { sha: sha.slice(0, 12), subject: redact(subject) };
    });
    handoff.truncatedCommits = Math.max(0, commitLines.length - handoff.commits.length);

    const diff = git(repo, ["diff", "--name-only", `${parentHead}...${identity.branch}`]);
    const paths = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    handoff.changedPaths = paths.slice(0, MAX_HANDOFF_PATHS).map((p) => redactHomePath(p));
    handoff.truncatedPaths = Math.max(0, paths.length - handoff.changedPaths.length);
  }

  return handoff;
}

// --- formatting -------------------------------------------------------------

/** A concise, redacted, human-readable lease result. */
export function formatWorktreeLeaseResult(
  result: WorktreeCreateResult | WorktreeCleanResult,
  action: "create" | "clean",
): string {
  const lines: string[] = [];
  lines.push(`Worktree lease (${WORKTREE_LEASE_SCHEMA} v${WORKTREE_LEASE_VERSION})`);
  lines.push("─".repeat(40));
  lines.push(`action:   ${action}`);
  if (result.ok) {
    const status =
      action === "create"
        ? (result as Extract<WorktreeCreateResult, { ok: true }>).created
          ? "created"
          : "already present (idempotent)"
        : (result as Extract<WorktreeCleanResult, { ok: true }>).cleaned
          ? "cleaned"
          : "already absent (idempotent)";
    lines.push("result:   ok");
    lines.push(`status:   ${status}`);
    const lease = result.lease;
    lines.push(`lease:    ${lease.leaseId}`);
    lines.push(`branch:   ${lease.branch}`);
    lines.push(`worktree: ${lease.worktreePath}`);
    if (lease.baseSha) lines.push(`base:     ${lease.baseSha.slice(0, 12)}`);
    lines.push(`task:     ${lease.taskIdentity}`);
    lines.push(`agent:    ${lease.agentIdentity}`);
  } else {
    lines.push("result:   refused");
    lines.push(`reason:   ${result.reason}`);
    lines.push(`detail:   ${redact(result.message)}`);
  }
  return lines.join("\n");
}

/** A concise, redacted, human-readable workspace graph. */
export function formatWorktreeGraph(graph: WorktreeGraph): string {
  const lines: string[] = [];
  lines.push(`Worktree graph (${graph.schema} v${graph.v})`);
  lines.push("─".repeat(40));
  lines.push(`worktree root: ${graph.worktreeRoot}`);
  if (graph.entries.length === 0) {
    lines.push("workspaces: (none)");
  } else {
    lines.push(`workspaces: ${graph.entries.length}`);
    for (const entry of graph.entries) {
      lines.push(`  ${entry.worktreePath}`);
      lines.push(`    branch: ${entry.branch}  head: ${entry.head}  state: ${entry.dirty ? "dirty" : "clean"}`);
    }
    if (graph.truncated > 0) {
      lines.push(`  … ${graph.truncated} more workspace(s) beyond the bound`);
    }
  }
  return lines.join("\n");
}

/** A concise, redacted, human-readable handoff brief. */
export function formatWorktreeHandoff(handoff: WorktreeHandoff): string {
  const lines: string[] = [];
  lines.push(`Worktree handoff (${handoff.schema} v${handoff.v})`);
  lines.push("─".repeat(40));
  lines.push(`lease:    ${handoff.leaseId}`);
  lines.push(`branch:   ${handoff.branch}`);
  lines.push(`worktree: ${handoff.worktreePath}`);
  if (!handoff.present) {
    lines.push("status:   absent (no such lease)");
    return lines.join("\n");
  }
  lines.push(`head:     ${handoff.head}`);
  lines.push(`state:    ${handoff.dirty ? "dirty" : "clean"}`);
  lines.push(`commits:  ${handoff.commits.length}`);
  for (const commit of handoff.commits) {
    lines.push(`  ${commit.sha}  ${commit.subject}`);
  }
  if (handoff.truncatedCommits > 0) {
    lines.push(`  … ${handoff.truncatedCommits} more commit(s) beyond the bound`);
  }
  lines.push(`changed paths: ${handoff.changedPaths.length}`);
  for (const path of handoff.changedPaths) {
    lines.push(`  ${path}`);
  }
  if (handoff.truncatedPaths > 0) {
    lines.push(`  … ${handoff.truncatedPaths} more path(s) beyond the bound`);
  }
  return lines.join("\n");
}

/** A concise, redacted, human-readable cancellation result. */
export function formatWorktreeCancelResult(result: WorktreeCancelResult): string {
  const lines: string[] = [];
  lines.push(`Worktree lease cancellation (${WORKTREE_LEASE_SCHEMA} v${WORKTREE_LEASE_VERSION})`);
  lines.push("─".repeat(40));
  lines.push("action:   cancel");
  if (result.ok) {
    const status = !result.cancelled
      ? "already absent (idempotent)"
      : result.forced
        ? "cancelled (forced; uncommitted work discarded)"
        : "cancelled";
    lines.push("result:   ok");
    lines.push(`status:   ${status}`);
    lines.push(`lease:    ${result.lease.leaseId}`);
    lines.push(`branch:   ${result.lease.branch} (preserved)`);
    lines.push(`worktree: ${result.lease.worktreePath}${result.worktreeRemoved ? " (removed)" : ""}`);
    lines.push(`preserved commits: ${result.preserved.commits.length}`);
    for (const commit of result.preserved.commits) {
      lines.push(`  ${commit.sha}  ${commit.subject}`);
    }
    if (result.preserved.truncatedCommits > 0) {
      lines.push(`  … ${result.preserved.truncatedCommits} more commit(s) beyond the bound`);
    }
  } else {
    lines.push("result:   refused");
    lines.push(`reason:   ${result.reason}`);
    lines.push(`detail:   ${redact(result.message)}`);
  }
  return lines.join("\n");
}
