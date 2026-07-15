// Workspace identity and the shared-workspace launch guard.
//
// Before a mutating task is delegated to a child agent, we must be sure the
// child will not write into the same workspace the parent (or a sibling) is
// already writing to: two writers in one workspace can silently overwrite or
// corrupt each other's work. This module decides whether two paths denote the
// *same* workspace and exposes the guard the subagent launcher applies.
//
// "Same workspace" is deliberately broader than "same directory string":
//   - Symlinked path aliases of one directory collapse to one identity (via
//     realpath), so a child pointed at an alias cannot bypass the guard.
//   - Linked git worktrees of one repository share a single git common
//     directory, so they collapse to one identity too — a child in a worktree
//     still shares the repository's object store and refs with the parent.
// Outside a repository, identity falls back to the real directory.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Whether a delegated task may mutate its workspace. */
export type WorkspaceMode = "mutating" | "read-only";

export interface WorkspaceIdentity {
  /** "git" when the path is inside a repository, "plain" otherwise. */
  kind: "git" | "plain";
  /** Canonical key; equal keys mean the same workspace. */
  key: string;
  /** Human-readable real path, for messages. */
  displayPath: string;
}

/**
 * Resolve a workspace path to its canonical identity. Two identities with the
 * same `key` denote the same workspace and must not both host mutating work.
 */
export function workspaceIdentity(workspacePath: string): WorkspaceIdentity {
  const abs = path.resolve(workspacePath);
  const displayPath = safeRealpath(abs);
  const commonDir = gitCommonDir(abs);
  if (commonDir !== null) {
    return { kind: "git", key: safeRealpath(commonDir), displayPath };
  }
  return { kind: "plain", key: displayPath, displayPath };
}

// Resolve the repository's shared common directory (the main `.git`), or null
// when the path is not in a repository (or git is unavailable). Relative output
// is resolved against the queried path, then canonicalised by the caller.
function gitCommonDir(absWorkspace: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", absWorkspace, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 1 << 20,
      },
    ).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(absWorkspace, out);
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // A not-yet-existing path still has a stable, comparable absolute form.
    return path.resolve(p);
  }
}

export interface GuardCheck {
  /** Identity of the parent (already-running) workspace. */
  parentIdentity: WorkspaceIdentity;
  /** The child's intended workspace path. */
  childWorkspace: string;
  /** Whether the child may mutate. */
  mode: WorkspaceMode;
}

export type GuardDecision =
  | { allowed: true; identity: WorkspaceIdentity }
  | {
      allowed: false;
      identity: WorkspaceIdentity;
      reason: "shared_workspace";
      message: string;
    };

/**
 * Decide whether a delegated task may launch. Read-only tasks are always
 * allowed (parallel investigation is safe). A mutating task is refused when it
 * would share the parent's workspace.
 */
export function evaluateWorkspaceGuard(check: GuardCheck): GuardDecision {
  const identity = workspaceIdentity(check.childWorkspace);
  if (check.mode === "read-only") {
    return { allowed: true, identity };
  }
  if (identity.key === check.parentIdentity.key) {
    return {
      allowed: false,
      identity,
      reason: "shared_workspace",
      message: sharedWorkspaceMessage(identity),
    };
  }
  return { allowed: true, identity };
}

function sharedWorkspaceMessage(child: WorkspaceIdentity): string {
  const scope =
    child.kind === "git" ? "repository (shared git directory)" : "workspace";
  return (
    `Refusing to launch a mutating delegated agent in the parent's ${scope}: ` +
    `${child.displayPath}. Two writers in one workspace can overwrite or ` +
    `corrupt each other's work. Run this task sequentially in the parent ` +
    `session, or delegate it to an isolated workspace (a separate clone or ` +
    `worktree) when supported.`
  );
}

/**
 * Thrown by the subagent launcher when a mutating child is refused because it
 * would share the parent's workspace. Carries the actionable explanation.
 */
export class SharedWorkspaceLaunchError extends Error {
  readonly reason = "shared_workspace" as const;

  constructor(message: string) {
    super(message);
    this.name = "SharedWorkspaceLaunchError";
  }
}
