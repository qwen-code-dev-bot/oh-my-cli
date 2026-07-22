// A read-only, fail-closed prediction of whether integrating one revision into
// another would conflict (roadmap #39, "conflict prediction"). It runs
// `git merge-tree --write-tree` — which computes a merge without touching the
// working tree or creating any commit — and reports clean-vs-conflict plus a
// bounded, redacted list of conflicting paths. It refuses to predict (fails
// closed) on a dirty working tree, an unresolvable revision, or a merge-tree
// error, so a bad prediction can never lead to a silent bad merge.

import { execFileSync } from "node:child_process";
import { redactHomePath } from "./permission-impact.js";

export const CONFLICT_PREDICTION_SCHEMA = "oh-my-cli.conflict-prediction";
export const CONFLICT_PREDICTION_VERSION = 1;

// Bound the number of conflicting paths reported so a pathological merge cannot
// inflate the report; paths beyond the bound are counted in `truncated`.
const MAX_CONFLICT_PATHS = 100;

export interface ConflictPrediction {
  schema: typeof CONFLICT_PREDICTION_SCHEMA;
  v: typeof CONFLICT_PREDICTION_VERSION;
  source: string;
  target: string;
  // True when the merge would apply cleanly (no conflicts).
  clean: boolean;
  // Bounded, redacted conflicting paths (home collapsed to ~); empty when clean.
  conflicts: string[];
  // Count of conflicting paths beyond the bound (0 when none).
  truncated: number;
}

// Run a git command, capturing the exit status and stdout even on a non-zero exit
// (merge-tree signals "conflicts" with exit 1 and still prints useful output).
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

// Predict whether merging `source` into `target` would conflict, read-only. Throws
// a redacted error (fail closed) on a dirty working tree, an unresolvable
// revision, or a merge-tree failure.
export function predictMergeConflict(
  workspace: string,
  source: string,
  target: string,
): ConflictPrediction {
  // Fail closed on a dirty working tree: the prediction is about committed
  // branches, and uncommitted work could be affected by a subsequent integration.
  const status = gitCapture(workspace, ["status", "--porcelain"]);
  if (status.status !== 0) {
    throw new Error("Conflict prediction error: cannot read working-tree state (fail closed)");
  }
  if (status.stdout.trim() !== "") {
    throw new Error(
      "Conflict prediction error: working tree is dirty; commit or stash changes before predicting (fail closed)",
    );
  }

  // Fail closed on an unresolvable revision.
  for (const [label, rev] of [
    ["source", source],
    ["target", target],
  ] as const) {
    const resolved = gitCapture(workspace, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    if (resolved.status !== 0 || resolved.stdout.trim() === "") {
      throw new Error(`Conflict prediction error: cannot resolve ${label} revision "${rev}" (fail closed)`);
    }
  }

  // Read-only merge computation. Exit 0 ⇒ clean; exit 1 ⇒ conflicts (the merged
  // tree OID is printed first, then the conflicting paths with --name-only); any
  // other status is an error.
  const merge = gitCapture(workspace, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    target,
    source,
  ]);
  if (merge.status === 0) {
    return {
      schema: CONFLICT_PREDICTION_SCHEMA,
      v: CONFLICT_PREDICTION_VERSION,
      source,
      target,
      clean: true,
      conflicts: [],
      truncated: 0,
    };
  }
  if (merge.status === 1) {
    // Drop the merged-tree object-name line(s) (pure hex), keeping only paths.
    const paths = merge.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^[0-9a-f]{40,}$/i.test(line));
    const bounded = paths.slice(0, MAX_CONFLICT_PATHS).map((p) => redactHomePath(p));
    return {
      schema: CONFLICT_PREDICTION_SCHEMA,
      v: CONFLICT_PREDICTION_VERSION,
      source,
      target,
      clean: false,
      conflicts: bounded,
      truncated: Math.max(0, paths.length - bounded.length),
    };
  }
  throw new Error("Conflict prediction error: git merge-tree failed (fail closed)");
}

// A deterministic, human-readable rendering of the prediction. It contains only
// revision names and (redacted) conflicting paths — never file contents.
export function formatConflictPrediction(prediction: ConflictPrediction): string {
  const lines: string[] = [];
  lines.push(`Conflict prediction (${prediction.schema} v${prediction.v})`);
  lines.push(`  source:   ${prediction.source}`);
  lines.push(`  target:   ${prediction.target}`);
  lines.push(`  result:   ${prediction.clean ? "CLEAN" : "CONFLICT"}`);
  if (!prediction.clean) {
    lines.push(`  conflicts: ${prediction.conflicts.length}`);
    for (const path of prediction.conflicts) {
      lines.push(`    ${path}`);
    }
    if (prediction.truncated > 0) {
      lines.push(`  truncated: ${prediction.truncated} more conflicting path${prediction.truncated === 1 ? "" : "s"} beyond the bound`);
    }
  }
  return lines.join("\n");
}
