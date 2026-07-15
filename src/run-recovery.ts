// Bounded run recovery: resume an interrupted unattended task without repeating
// steps already proven complete.
//
// An interrupted run can otherwise require a full restart, duplicating completed
// work and making long-running automation expensive and unsafe. This module
// persists a versioned recovery checkpoint of *identities and content digests
// only* — never raw evidence, prompts, secrets, or host paths — and, at resume
// time, decides whether that checkpoint still safely applies. Completion is
// proven by matching the durable evidence digest of each completed step, never
// by parsing log text. The evaluation fails closed: a stale (repository moved),
// ambiguous (different task), or tampered (evidence changed) checkpoint is
// refused without any mutation. Every public function is deterministic given its
// inputs, and all free-form values are redacted before they are persisted or
// displayed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { redactSecrets } from "./permission-impact.js";

export const RECOVERY_SCHEMA = "oh-my-cli.recovery";
export const RECOVERY_VERSION = 1;

/** A step proven complete: a stable identity and its durable evidence digest. */
export interface CompletedStep {
  /** Stable step identity (e.g. "write:src/foo.ts"); redacted on persist. */
  id: string;
  /** sha256 hex of the step's durable evidence — never the raw content. */
  digest: string;
}

/** A durable, versioned record of how far a task safely progressed. */
export interface RecoveryCheckpoint {
  schema: typeof RECOVERY_SCHEMA;
  v: typeof RECOVERY_VERSION;
  /** Stable identity of the task this checkpoint belongs to. */
  taskIdentity: string;
  /** Git HEAD at checkpoint time ("" when not a repository). */
  repoHead: string;
  /** Steps proven complete, in execution order. */
  steps: CompletedStep[];
}

/** The current state supplied by the caller at resume time. */
export interface RecoveryContext {
  taskIdentity: string;
  repoHead: string;
  /** Current evidence digests keyed by (redacted) step id. */
  evidence: Record<string, string>;
}

export type RecoveryDecision = "resume" | "refuse";

/** The deterministic outcome of evaluating a checkpoint against current state. */
export interface RecoveryPlan {
  schema: typeof RECOVERY_SCHEMA;
  v: typeof RECOVERY_VERSION;
  decision: RecoveryDecision;
  /** Why the decision was made (redacted, bounded). */
  reason: string;
  taskIdentity: string;
  /** The repository head that was evaluated. */
  repoHead: string;
  /** Step ids proven complete and safe to skip (only populated on `resume`). */
  completed: string[];
}

/**
 * Thrown when a recovery checkpoint or evidence file cannot be read, parsed, or
 * validated. Carries an actionable message; the CLI maps it to a usage error.
 */
export class RecoveryCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCheckpointError";
  }
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

/** sha256 hex of durable evidence content (the caller hashes the real artifact). */
export function hashEvidence(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// --- persistence ------------------------------------------------------------

/**
 * Persist a recovery checkpoint as JSON. Step ids and the task identity are
 * redacted so a secret that leaked into an identity never reaches disk; digests
 * are already opaque hashes and carry no content.
 */
export function writeRecoveryCheckpoint(filePath: string, checkpoint: RecoveryCheckpoint): void {
  const safe: RecoveryCheckpoint = {
    schema: RECOVERY_SCHEMA,
    v: RECOVERY_VERSION,
    taskIdentity: redact(checkpoint.taskIdentity),
    repoHead: checkpoint.repoHead,
    steps: checkpoint.steps.map((s) => ({ id: redact(s.id), digest: s.digest })),
  };
  fs.writeFileSync(filePath, JSON.stringify(safe, null, 2) + "\n", "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structurally validate an unknown value as a checkpoint. Throws
 * RecoveryCheckpointError on anything malformed or version-incompatible so a
 * stale or tampered file is rejected before any decision is made (fail closed).
 */
export function parseCheckpoint(value: unknown): RecoveryCheckpoint {
  if (!isRecord(value)) {
    throw new RecoveryCheckpointError("recovery checkpoint is not an object");
  }
  if (value.schema !== RECOVERY_SCHEMA) {
    throw new RecoveryCheckpointError(
      `unexpected recovery schema ${JSON.stringify(value.schema ?? null)}`,
    );
  }
  if (value.v !== RECOVERY_VERSION) {
    throw new RecoveryCheckpointError(
      `incompatible recovery checkpoint version ${JSON.stringify(value.v ?? null)}`,
    );
  }
  if (typeof value.taskIdentity !== "string") {
    throw new RecoveryCheckpointError("recovery checkpoint missing taskIdentity");
  }
  if (typeof value.repoHead !== "string") {
    throw new RecoveryCheckpointError("recovery checkpoint missing repoHead");
  }
  if (!Array.isArray(value.steps)) {
    throw new RecoveryCheckpointError("recovery checkpoint missing steps array");
  }
  const steps: CompletedStep[] = [];
  for (const s of value.steps) {
    if (!isRecord(s) || typeof s.id !== "string" || typeof s.digest !== "string") {
      throw new RecoveryCheckpointError("recovery checkpoint has a malformed step");
    }
    steps.push({ id: s.id, digest: s.digest });
  }
  return {
    schema: RECOVERY_SCHEMA,
    v: RECOVERY_VERSION,
    taskIdentity: value.taskIdentity,
    repoHead: value.repoHead,
    steps,
  };
}

/** Read and validate a checkpoint file, translating fs/parse errors into clear ones. */
export function readRecoveryCheckpoint(filePath: string): RecoveryCheckpoint {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new RecoveryCheckpointError(`cannot read recovery checkpoint: file not found: ${filePath}`);
    }
    throw new RecoveryCheckpointError(`cannot read recovery checkpoint: ${e.message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RecoveryCheckpointError("recovery checkpoint is not valid JSON");
  }
  return parseCheckpoint(value);
}

/**
 * Read a current-evidence file: a flat JSON object mapping step id -> digest.
 * Keys are redacted so they line up with the redacted ids stored in a checkpoint.
 */
export function readEvidenceFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new RecoveryCheckpointError(`cannot read evidence file: file not found: ${filePath}`);
    }
    throw new RecoveryCheckpointError(`cannot read evidence file: ${e.message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RecoveryCheckpointError("evidence file is not valid JSON");
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new RecoveryCheckpointError("evidence file must be a JSON object of stepId -> digest");
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new RecoveryCheckpointError(`evidence for "${redact(key)}" is not a string digest`);
    }
    out[redact(key)] = val;
  }
  return out;
}

/** Read the current git HEAD of a workspace read-only ("" when not a repository). */
export function currentRepoHead(workspace: string): string {
  try {
    return execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 1 << 20,
    }).trim();
  } catch {
    return "";
  }
}

// --- evaluation (pure) ------------------------------------------------------

/**
 * Decide whether a checkpoint still safely applies to the current state. The
 * decision is deterministic and refuses on any uncertainty:
 *   - ambiguous: the task identity does not match the checkpoint;
 *   - stale: the repository head moved since the checkpoint was written;
 *   - tampered/stale: a completed step's durable evidence is missing or its
 *     digest no longer matches.
 * Only when every completed step's evidence still verifies does it return
 * `resume` with the proven-complete step ids that are safe to skip.
 */
export function evaluateRecovery(
  checkpoint: RecoveryCheckpoint,
  context: RecoveryContext,
): RecoveryPlan {
  const base: Pick<RecoveryPlan, "schema" | "v" | "taskIdentity" | "repoHead"> = {
    schema: RECOVERY_SCHEMA,
    v: RECOVERY_VERSION,
    taskIdentity: context.taskIdentity,
    repoHead: context.repoHead,
  };

  if (checkpoint.taskIdentity !== context.taskIdentity) {
    return {
      ...base,
      decision: "refuse",
      reason: "task identity does not match the checkpoint (ambiguous)",
      completed: [],
    };
  }
  if (checkpoint.repoHead !== context.repoHead) {
    return {
      ...base,
      decision: "refuse",
      reason: "repository head no longer matches the checkpoint (stale)",
      completed: [],
    };
  }

  const completed: string[] = [];
  for (const step of checkpoint.steps) {
    const current = context.evidence[step.id];
    if (current === undefined) {
      return {
        ...base,
        decision: "refuse",
        reason: `completed step "${step.id}" has no current evidence (cannot verify)`,
        completed: [],
      };
    }
    if (current !== step.digest) {
      return {
        ...base,
        decision: "refuse",
        reason: `completed step "${step.id}" evidence changed since the checkpoint (tampered or stale)`,
        completed: [],
      };
    }
    completed.push(step.id);
  }

  return {
    ...base,
    decision: "resume",
    reason: "all completed-step evidence verified; safe to skip the proven steps",
    completed,
  };
}

/**
 * Given the full ordered list of step ids a run intends to perform and a
 * recovery plan, return only the steps that still need to run. Proven-complete
 * steps are removed so a completed step is never executed twice; on a refused
 * plan nothing is skipped (the caller must not resume).
 */
export function planRemainingSteps(planned: string[], plan: RecoveryPlan): string[] {
  if (plan.decision !== "resume") return planned.slice();
  const done = new Set(plan.completed);
  return planned.filter((id) => !done.has(id));
}

// --- formatting -------------------------------------------------------------

/** A concise, deterministic, human-readable recovery result. */
export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const lines: string[] = [];
  lines.push(`Run recovery (${plan.schema} v${plan.v})`);
  lines.push("─".repeat(40));
  lines.push(`decision:  ${plan.decision}`);
  lines.push(`reason:    ${redact(plan.reason)}`);
  lines.push(`task:      ${redact(plan.taskIdentity)}`);
  lines.push(`repo head: ${plan.repoHead || "(not a repository)"}`);
  if (plan.decision === "resume") {
    if (plan.completed.length === 0) {
      lines.push("completed: (none — starting fresh)");
    } else {
      lines.push(`completed: ${plan.completed.length} step(s) safe to skip:`);
      for (const id of plan.completed) {
        lines.push(`  - ${redact(id)}`);
      }
    }
  }
  return lines.join("\n");
}
