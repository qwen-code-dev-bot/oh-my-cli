// Session continuity: resolve and expose the state a session needs to hand off
// across surfaces — the exact head it is bound to, any pending approvals, and
// the surface of origin — plus a stale-head guard that refuses a mutation when
// the head has moved underneath the session. This is the TUI adoption child of
// the converged workbench roadmap (Issue #290) and builds directly on the shared
// concept contract (Issue #300): the continuity surface renders the canonical
// concepts from concept-contract.ts (never TUI-local strings), and the
// stale-head rejection uses the contract's canonical delivery-state failure
// semantic rather than an ad-hoc message. The cross-surface continuation child
// (#303) reads this state to move a real session between TUI and Desktop.
//
// Trust boundary: continuity resolves only REAL state from the workspace's git
// repository (exact HEAD sha, branch, cleanliness) via read-only `git` probes —
// nothing is simulated and nothing is mutated. `pendingApprovals` is supplied by
// a live session (the count of approvals actually awaiting a decision) and
// defaults to 0, which is the truthful value when no interactive mutation is in
// progress; this module never invents approvals. Branch names are secret-redacted
// like the rest of the product; head shas are hex and need no redaction.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";
import { CONCEPT_CONTRACT, conceptById } from "./concept-contract.js";
import type { ConceptId } from "./concept-contract.js";

export const SESSION_CONTINUITY_SCHEMA = "oh-my-cli.session-continuity";
export const SESSION_CONTINUITY_VERSION = 1;

// The surface a continuity snapshot originates from. This slice always reports
// "tui"; a Desktop renderer (#302) would report "desktop" through the same shape.
export type ContinuitySurface = "tui" | "desktop";

// The canonical concept ids this continuity surface renders, sourced directly
// from the shared contract so the surface cannot diverge from it. Exposed so a
// conformance test can pin that the TUI adopts the contract unchanged.
export const CONTINUITY_CONCEPT_IDS: readonly ConceptId[] = CONCEPT_CONTRACT.map(
  (concept) => concept.id,
);

// One canonical concept label as rendered by this surface: the stable id plus the
// contract's display name. Built from conceptById so the labels are the contract
// itself, not a copy.
export interface ContinuityConceptLabel {
  id: ConceptId;
  name: string;
}

// The canonical concept labels this surface renders (id + contract display name).
export function continuityConceptLabels(): ContinuityConceptLabel[] {
  return CONTINUITY_CONCEPT_IDS.map((id) => ({ id, name: conceptById(id).name }));
}

// Real, redacted continuity state for one surface. `boundHead` is the exact git
// HEAD sha the workspace is bound to (null when not a repository); `headRef` is
// the branch name (null when detached or not a repository).
export interface ContinuityState {
  schema: string;
  version: number;
  surface: ContinuitySurface;
  repo: boolean;
  boundHead: string | null;
  headRef: string | null;
  detached: boolean;
  clean: boolean;
  dirtyCount: number;
  pendingApprovals: number;
  concepts: ContinuityConceptLabel[];
}

export interface ContinuityOptions {
  /** Workspace to inspect (default cwd). */
  workspace?: string;
  /** Surface of origin (default tui). */
  surface?: ContinuitySurface;
  /** Real count of approvals awaiting a decision in a live session (default 0). */
  pendingApprovals?: number;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

// Read-only git probe bounded by a timeout, mirroring repo-context.ts so a
// pathological repository cannot hang the run. Never throws.
function git(workspace: string, args: string[], timeoutMs = 5_000): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// Resolve the exact HEAD sha the workspace is bound to, or null when the
// workspace is not a git repository. This is the real bound head — never guessed
// or simulated.
export function resolveBoundHead(workspace: string): string | null {
  const resolved = path.resolve(workspace);
  const isRepo =
    git(resolved, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  if (!isRepo) return null;
  const head = git(resolved, ["rev-parse", "HEAD"]).stdout.trim();
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

// Resolve the real continuity state for a workspace. All fields come from
// read-only git probes (or the caller-supplied real pending-approval count); a
// non-repository workspace reports repo:false with a null bound head and is not
// an error.
export function collectContinuity(opts: ContinuityOptions = {}): ContinuityState {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const surface = opts.surface ?? "tui";
  const pendingApprovals =
    typeof opts.pendingApprovals === "number" && Number.isFinite(opts.pendingApprovals)
      ? Math.max(0, Math.floor(opts.pendingApprovals))
      : 0;

  const isRepo =
    git(workspace, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  if (!isRepo) {
    return {
      schema: SESSION_CONTINUITY_SCHEMA,
      version: SESSION_CONTINUITY_VERSION,
      surface,
      repo: false,
      boundHead: null,
      headRef: null,
      detached: false,
      clean: false,
      dirtyCount: 0,
      pendingApprovals,
      concepts: continuityConceptLabels(),
    };
  }

  const boundHead = resolveBoundHead(workspace);
  const branchRaw = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached.
  const detached = branchRaw === "HEAD" || branchRaw === "";
  const headRef = detached ? null : redactSecrets(branchRaw).text;
  const dirtyCount = git(workspace, ["status", "--porcelain"])
    .stdout.split("\n")
    .filter((line) => line.trim().length > 0).length;

  return {
    schema: SESSION_CONTINUITY_SCHEMA,
    version: SESSION_CONTINUITY_VERSION,
    surface,
    repo: true,
    boundHead,
    headRef,
    detached,
    clean: dirtyCount === 0,
    dirtyCount,
    pendingApprovals,
    concepts: continuityConceptLabels(),
  };
}

// The result of guarding a mutation against a moved head.
export interface HeadGuardResult {
  ok: boolean;
  boundHead: string;
  currentHead: string | null;
  reason: string;
}

// Refuse a mutation when the workspace head has moved away from the head the
// session is bound to. The rejection reason carries the contract's canonical
// delivery-state failure semantic (no TUI-local message), satisfying the
// stale-head acceptance for #301. A matching head (or a non-repository workspace,
// where there is no head to have moved) is allowed.
export function assertHeadCurrent(
  boundHead: string,
  opts: { workspace?: string } = {},
): HeadGuardResult {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  const currentHead = resolveBoundHead(workspace);
  const canonical = conceptById("delivery-state").failureSemantic;
  if (currentHead === null) {
    // Not a repository: there is no head to have moved, so nothing is stale.
    return { ok: true, boundHead, currentHead, reason: "no repository head to guard" };
  }
  if (currentHead === boundHead) {
    return { ok: true, boundHead, currentHead, reason: "head is current" };
  }
  return {
    ok: false,
    boundHead,
    currentHead,
    reason: `${canonical} (head moved from ${boundHead.slice(0, 12)} to ${currentHead.slice(0, 12)})`,
  };
}

const SURFACE_LABELS: Record<ContinuitySurface, string> = {
  tui: "TUI",
  desktop: "Desktop",
};

// A redacted, human-readable continuity snapshot. Head shas are hex; branch names
// are already secret-redacted at collection.
export function formatContinuity(state: ContinuityState): string {
  const lines: string[] = [
    "Session Continuity",
    "─".repeat(40),
    `Schema:   ${state.schema} v${state.version}`,
    `Surface:  ${SURFACE_LABELS[state.surface]} (surface of origin)`,
  ];
  if (!state.repo) {
    lines.push("Bound head: (not a git repository)");
  } else {
    lines.push(`Bound head: ${state.boundHead ?? "(unknown)"}`);
    lines.push(
      `Branch:     ${state.headRef ?? (state.detached ? "(detached)" : "(unknown)")}`,
    );
    lines.push(`Worktree:   ${state.clean ? "clean" : `${state.dirtyCount} uncommitted change(s)`}`);
  }
  lines.push(`Pending approvals: ${state.pendingApprovals}`);
  lines.push(`Shared concepts:   ${state.concepts.map((c) => c.name).join(" · ")}`);
  return lines.join("\n");
}

// A compact rendering for space-constrained surfaces (the TUI slash command).
export function formatContinuityCompact(state: ContinuityState): string {
  const head = state.repo ? (state.boundHead ?? "(unknown)").slice(0, 12) : "(no repo)";
  const branch = state.repo ? (state.headRef ?? (state.detached ? "detached" : "?")) : "-";
  const worktree = state.repo ? (state.clean ? "clean" : `${state.dirtyCount} dirty`) : "-";
  return [
    `Continuity (${SURFACE_LABELS[state.surface]})`,
    `  head: ${head} · branch: ${branch} · ${worktree}`,
    `  pending approvals: ${state.pendingApprovals}`,
    `  concepts: ${state.concepts.map((c) => c.name).join(" · ")}`,
  ].join("\n");
}
