// A governed, reviewable, fail-closed integration of a parallel agent's branch
// into the current branch (roadmap #39, "selective integration"). It reuses the
// conflict prediction from #226 to refuse to integrate when the merge would
// conflict, shows a bounded, redacted preview (changed paths + commit list) of
// what the integration brings, and otherwise performs a non-fast-forward merge
// that preserves the source's commit identity. It fails closed on a dirty working
// tree, an unresolvable revision, a detached HEAD, a predicted conflict, or a
// failed merge — it never discards changes or auto-resolves conflicts.

import { execFileSync } from "node:child_process";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { predictMergeConflict } from "./conflict-prediction.js";

export const SELECTIVE_INTEGRATION_SCHEMA = "oh-my-cli.selective-integration";
export const SELECTIVE_INTEGRATION_VERSION = 1;

// Bounds that keep the preview free of high-cardinality output.
const MAX_PREVIEW_PATHS = 100;
const MAX_PREVIEW_COMMITS = 50;

export interface IntegrationCommit {
  // Abbreviated commit SHA (identity-preserving merge keeps the full commit).
  sha: string;
  subject: string;
}

export interface IntegrationPreview {
  changedPaths: string[];
  truncatedPaths: number;
  commits: IntegrationCommit[];
  truncatedCommits: number;
}

export interface IntegrationResult {
  schema: typeof SELECTIVE_INTEGRATION_SCHEMA;
  v: typeof SELECTIVE_INTEGRATION_VERSION;
  source: string;
  target: string;
  // True when a merge commit was created; false when there was nothing to
  // integrate (the source was already contained in the target).
  integrated: boolean;
  // Resulting HEAD SHA after the operation (null only when nothing was integrated
  // and the head could not be read).
  head: string | null;
  preview: IntegrationPreview;
}

export interface IntegrateOptions {
  // When true, compute and return the preview without performing the merge.
  dryRun?: boolean;
}

// Run a git command, capturing the exit status and stdout even on a non-zero exit.
function gitCapture(workspace: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 4 << 20,
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    return { status: typeof e.status === "number" ? e.status : 128, stdout };
  }
}

// The current branch name; fails closed on a detached HEAD (the integration needs
// a named target branch to merge into).
function currentBranch(workspace: string): string {
  const result = gitCapture(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = result.stdout.trim();
  if (result.status !== 0 || branch === "" || branch === "HEAD") {
    throw new Error("Selective integration error: not on a branch (detached HEAD); check out the target branch (fail closed)");
  }
  return branch;
}

function buildPreview(workspace: string, source: string, target: string): IntegrationPreview {
  const diff = gitCapture(workspace, ["diff", "--name-only", `${target}...${source}`]);
  const paths = diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const changedPaths = paths.slice(0, MAX_PREVIEW_PATHS).map((p) => redactHomePath(p));

  const log = gitCapture(workspace, ["log", "--format=%H%x09%s", `${target}..${source}`]);
  const commitLines = log.stdout.split("\n").filter((line) => line.trim() !== "");
  const commits: IntegrationCommit[] = commitLines.slice(0, MAX_PREVIEW_COMMITS).map((line) => {
    const tab = line.indexOf("\t");
    const sha = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : "";
    return { sha: sha.slice(0, 12), subject: redactSecrets(subject).text };
  });

  return {
    changedPaths,
    truncatedPaths: Math.max(0, paths.length - changedPaths.length),
    commits,
    truncatedCommits: Math.max(0, commitLines.length - commits.length),
  };
}

// Integrate `source` into the current branch. Fails closed (throws a redacted
// error) on a detached HEAD, a dirty tree, an unresolvable revision, a predicted
// conflict, or a failed merge. With `dryRun`, returns the preview without merging.
export function integrateBranch(
  workspace: string,
  source: string,
  opts: IntegrateOptions = {},
): IntegrationResult {
  const target = currentBranch(workspace);

  // Fail closed on a dirty tree, an unresolvable revision, or a predicted
  // conflict (predictMergeConflict checks all three and throws on any).
  const prediction = predictMergeConflict(workspace, source, target);
  if (!prediction.clean) {
    throw new Error(
      `Selective integration error: predicted conflict on ${prediction.conflicts.length} path(s) ` +
        `(${prediction.conflicts.slice(0, 5).join(", ")}${prediction.conflicts.length > 5 ? ", …" : ""}); ` +
        "refusing to integrate (fail closed)",
    );
  }

  const preview = buildPreview(workspace, source, target);
  if (opts.dryRun) {
    const head = gitCapture(workspace, ["rev-parse", "HEAD"]).stdout.trim() || null;
    return {
      schema: SELECTIVE_INTEGRATION_SCHEMA,
      v: SELECTIVE_INTEGRATION_VERSION,
      source,
      target,
      integrated: false,
      head,
      preview,
    };
  }

  // Nothing to integrate: the source is already contained in the target.
  if (preview.commits.length === 0) {
    const head = gitCapture(workspace, ["rev-parse", "HEAD"]).stdout.trim() || null;
    return {
      schema: SELECTIVE_INTEGRATION_SCHEMA,
      v: SELECTIVE_INTEGRATION_VERSION,
      source,
      target,
      integrated: false,
      head,
      preview,
    };
  }

  // Non-fast-forward merge preserves the source's commit identity.
  const merge = gitCapture(workspace, ["merge", "--no-ff", "--no-edit", source]);
  if (merge.status !== 0) {
    throw new Error("Selective integration error: merge failed (fail closed)");
  }
  const head = gitCapture(workspace, ["rev-parse", "HEAD"]).stdout.trim() || null;
  return {
    schema: SELECTIVE_INTEGRATION_SCHEMA,
    v: SELECTIVE_INTEGRATION_VERSION,
    source,
    target,
    integrated: true,
    head,
    preview,
  };
}

// A deterministic, human-readable rendering of the integration result. It contains
// only revision names, redacted paths, and commit subjects — never file contents.
export function formatIntegrationResult(result: IntegrationResult): string {
  const lines: string[] = [];
  lines.push(`Selective integration (${result.schema} v${result.v})`);
  lines.push(`  source:   ${result.source}`);
  lines.push(`  target:   ${result.target}`);
  lines.push(`  result:   ${result.integrated ? "INTEGRATED" : "NOT INTEGRATED (nothing to merge or dry run)"}`);
  if (result.head) lines.push(`  head:     ${result.head}`);
  lines.push(`  preview:`);
  lines.push(`    changed paths: ${result.preview.changedPaths.length}`);
  for (const path of result.preview.changedPaths) {
    lines.push(`      ${path}`);
  }
  if (result.preview.truncatedPaths > 0) {
    lines.push(`      … ${result.preview.truncatedPaths} more path(s) beyond the bound`);
  }
  lines.push(`    commits: ${result.preview.commits.length}`);
  for (const commit of result.preview.commits) {
    lines.push(`      ${commit.sha}  ${commit.subject}`);
  }
  if (result.preview.truncatedCommits > 0) {
    lines.push(`      … ${result.preview.truncatedCommits} more commit(s) beyond the bound`);
  }
  return lines.join("\n");
}
