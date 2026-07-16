// Portable, privacy-safe evidence bundle for an unattended run.
//
// Run summaries and recovery checkpoints are otherwise machine-local, which
// makes independent audit and regression reproduction hard. This module bundles
// the durable, already-redacted evidence of a run — the versioned run summary,
// recovery checkpoint metadata, command outcomes, and content digests — into one
// portable, deterministic JSON archive with a signed manifest, and verifies that
// archive offline.
//
// Guarantees:
//   - Privacy: no prompts, raw tool payloads, credentials, or absolute host
//     paths reach the bundle. Free-form values are secret-redacted and the home
//     directory is collapsed to ~ before content is serialized.
//   - Determinism: identical normalized evidence yields byte-identical archive
//     bytes. The serializer sorts keys, orders entries by name, and adds no
//     wall-clock timestamps.
//   - Integrity: each entry carries a sha256 of its content, and the manifest
//   (schema, version, source, and the entry name/kind/digest list) carries a
//   sha256 signature. Verification recomputes both and fails closed on any
//   missing, extra, reordered, or modified entry. ("Signed" here is a
//   deterministic integrity digest — there is deliberately no key management in
//   this slice.)

import { createHash } from "node:crypto";
import fs from "node:fs";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import type { RunSummary } from "./run-summary.js";
import type { RecoveryCheckpoint } from "./run-recovery.js";

export const EVIDENCE_ARCHIVE_SCHEMA = "oh-my-cli.evidence-archive" as const;
export const EVIDENCE_ARCHIVE_VERSION = 1 as const;

export type EvidenceKind =
  | "run-summary"
  | "checkpoint-metadata"
  | "command-outcomes"
  | "content-digests";

export interface EvidenceEntry {
  name: string;
  kind: EvidenceKind;
  // sha256 hex of the entry's canonical content.
  digest: string;
  // Canonical, redacted JSON text of the normalized evidence.
  content: string;
}

export interface EvidenceSource {
  task?: string;
  repoHead?: string;
  outcome?: "success" | "failure";
}

export interface EvidenceBundle {
  schema: typeof EVIDENCE_ARCHIVE_SCHEMA;
  v: typeof EVIDENCE_ARCHIVE_VERSION;
  source: EvidenceSource;
  entries: EvidenceEntry[];
  // sha256 over the canonical manifest (schema, v, source, entry name/kind/digest).
  signature: string;
}

// A single command's outcome. The command text is redacted before it is bundled.
export interface CommandOutcome {
  command: string;
  exitCode: number;
  ok: boolean;
}

export interface EvidenceInput {
  source?: EvidenceSource;
  summary?: RunSummary;
  checkpoint?: RecoveryCheckpoint;
  outcomes?: CommandOutcome[];
  // stepId -> durable content digest (values are opaque hashes).
  contentDigests?: Record<string, string>;
}

export interface EvidenceEntryReport {
  name: string;
  kind: EvidenceKind;
  ok: boolean;
  reason?: string;
}

export interface EvidenceVerifyResult {
  schema: typeof EVIDENCE_ARCHIVE_SCHEMA;
  v: typeof EVIDENCE_ARCHIVE_VERSION;
  ok: boolean;
  signatureValid: boolean;
  entries: EvidenceEntryReport[];
  errors: string[];
}

/** Thrown when an evidence bundle cannot be read, parsed, or structurally validated. */
export class EvidenceArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceArchiveError";
  }
}

// --- primitives --------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deterministic JSON: object keys sorted recursively, arrays preserved in order.
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

// --- normalization (per kind) ------------------------------------------------

function normalizeSummary(summary: RunSummary): unknown {
  // The run summary is already privacy-safe; collapse any residual home path and
  // pin the schema/version so a future summary version is explicit in the bundle.
  return {
    schema: summary.schema,
    v: summary.v,
    outcome: summary.outcome,
    exitCode: summary.exitCode,
    reason: summary.reason,
    elapsedMs: summary.elapsedMs,
    rounds: summary.rounds,
    toolCalls: summary.toolCalls,
    toolFailures: summary.toolFailures,
    tokens: summary.tokens,
    evidence: {
      sessionId: summary.evidence.sessionId,
      sessionPath: summary.evidence.sessionPath
        ? redactHomePath(summary.evidence.sessionPath)
        : null,
    },
  };
}

function normalizeCheckpoint(checkpoint: RecoveryCheckpoint): unknown {
  return {
    schema: checkpoint.schema,
    v: checkpoint.v,
    taskIdentity: redact(checkpoint.taskIdentity),
    repoHead: checkpoint.repoHead,
    stepCount: checkpoint.steps.length,
    steps: checkpoint.steps.map((s) => ({ id: redact(s.id), digest: s.digest })),
  };
}

function normalizeOutcomes(outcomes: CommandOutcome[]): unknown {
  return outcomes.map((o) => ({
    command: redact(o.command),
    exitCode: Math.trunc(o.exitCode),
    ok: Boolean(o.ok),
  }));
}

function normalizeContentDigests(digests: Record<string, string>): unknown {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(digests)) {
    out[redact(key)] = val;
  }
  return out;
}

function normalizeSource(input: EvidenceInput): EvidenceSource {
  const source: EvidenceSource = {};
  const task = input.source?.task ?? input.checkpoint?.taskIdentity;
  if (task) source.task = redact(task);
  const repoHead = input.source?.repoHead ?? input.checkpoint?.repoHead;
  if (repoHead) source.repoHead = repoHead;
  const outcome = input.source?.outcome ?? input.summary?.outcome;
  if (outcome) source.outcome = outcome;
  return source;
}

// --- build -------------------------------------------------------------------

const KIND_BY_FIELD: Array<{ key: keyof EvidenceInput; name: string; kind: EvidenceKind }> = [
  { key: "summary", name: "run-summary", kind: "run-summary" },
  { key: "checkpoint", name: "checkpoint", kind: "checkpoint-metadata" },
  { key: "outcomes", name: "command-outcomes", kind: "command-outcomes" },
  { key: "contentDigests", name: "content-digests", kind: "content-digests" },
];

function normalizedContent(field: keyof EvidenceInput, input: EvidenceInput): unknown {
  switch (field) {
    case "summary":
      return normalizeSummary(input.summary as RunSummary);
    case "checkpoint":
      return normalizeCheckpoint(input.checkpoint as RecoveryCheckpoint);
    case "outcomes":
      return normalizeOutcomes(input.outcomes as CommandOutcome[]);
    case "contentDigests":
      return normalizeContentDigests(input.contentDigests as Record<string, string>);
    default:
      return null;
  }
}

/**
 * Build a deterministic evidence bundle from the supplied (already privacy-safe)
 * evidence. Only the kinds present in `input` become entries. Entries are sorted
 * by name and the manifest is signed so the archive is tamper-evident.
 */
export function buildEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  const entries: EvidenceEntry[] = [];
  for (const { key, name, kind } of KIND_BY_FIELD) {
    if (input[key] === undefined) continue;
    const content = canonicalize(normalizedContent(key, input));
    entries.push({ name, kind, digest: sha256(content), content });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const source = normalizeSource(input);
  const bundle: EvidenceBundle = {
    schema: EVIDENCE_ARCHIVE_SCHEMA,
    v: EVIDENCE_ARCHIVE_VERSION,
    source,
    entries,
    signature: "",
  };
  bundle.signature = manifestSignature(bundle);
  return bundle;
}

// sha256 over the canonical manifest (everything except entry content and the
// signature itself), so any missing/extra/reordered/modified entry breaks it.
function manifestSignature(bundle: EvidenceBundle): string {
  const manifest = {
    schema: bundle.schema,
    v: bundle.v,
    source: bundle.source,
    entries: bundle.entries.map((e) => ({ name: e.name, kind: e.kind, digest: e.digest })),
  };
  return sha256(canonicalize(manifest));
}

/** Serialize a bundle to deterministic, portable JSON text (trailing newline). */
export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return canonicalize(bundle) + "\n";
}

/** Serialize and write a bundle to `filePath` (deterministic bytes, trailing newline). */
export function writeEvidenceBundle(filePath: string, bundle: EvidenceBundle): void {
  fs.writeFileSync(filePath, serializeEvidenceBundle(bundle), "utf8");
}

// --- parse / read ------------------------------------------------------------

/** Structurally validate an unknown value as a bundle; fail closed otherwise. */
export function parseEvidenceBundle(value: unknown): EvidenceBundle {
  if (!isRecord(value)) {
    throw new EvidenceArchiveError("evidence bundle is not an object");
  }
  if (value.schema !== EVIDENCE_ARCHIVE_SCHEMA) {
    throw new EvidenceArchiveError(
      `unexpected evidence schema ${JSON.stringify(value.schema ?? null)}`,
    );
  }
  if (value.v !== EVIDENCE_ARCHIVE_VERSION) {
    throw new EvidenceArchiveError(
      `incompatible evidence bundle version ${JSON.stringify(value.v ?? null)}`,
    );
  }
  if (!isRecord(value.source)) {
    throw new EvidenceArchiveError("evidence bundle missing source object");
  }
  const source: EvidenceSource = {};
  if (value.source.task !== undefined) {
    if (typeof value.source.task !== "string") throw new EvidenceArchiveError("source.task is not a string");
    source.task = value.source.task;
  }
  if (value.source.repoHead !== undefined) {
    if (typeof value.source.repoHead !== "string") throw new EvidenceArchiveError("source.repoHead is not a string");
    source.repoHead = value.source.repoHead;
  }
  if (value.source.outcome !== undefined) {
    if (value.source.outcome !== "success" && value.source.outcome !== "failure") {
      throw new EvidenceArchiveError("source.outcome is not success|failure");
    }
    source.outcome = value.source.outcome;
  }
  if (typeof value.signature !== "string") {
    throw new EvidenceArchiveError("evidence bundle missing signature");
  }
  if (!Array.isArray(value.entries)) {
    throw new EvidenceArchiveError("evidence bundle missing entries array");
  }
  const entries: EvidenceEntry[] = [];
  for (const e of value.entries) {
    if (!isRecord(e) || typeof e.name !== "string" || typeof e.content !== "string" || typeof e.digest !== "string") {
      throw new EvidenceArchiveError("evidence bundle has a malformed entry");
    }
    if (e.kind !== "run-summary" && e.kind !== "checkpoint-metadata" && e.kind !== "command-outcomes" && e.kind !== "content-digests") {
      throw new EvidenceArchiveError(`evidence bundle has an unknown entry kind ${JSON.stringify(e.kind)}`);
    }
    entries.push({ name: e.name, kind: e.kind, digest: e.digest, content: e.content });
  }
  return { schema: EVIDENCE_ARCHIVE_SCHEMA, v: EVIDENCE_ARCHIVE_VERSION, source, entries, signature: value.signature };
}

/** Read and validate a bundle file, translating fs/parse errors into clear ones. */
export function readEvidenceBundle(filePath: string): EvidenceBundle {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new EvidenceArchiveError(`cannot read evidence bundle: file not found: ${filePath}`);
    }
    throw new EvidenceArchiveError(`cannot read evidence bundle: ${e.message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvidenceArchiveError("evidence bundle is not valid JSON");
  }
  return parseEvidenceBundle(value);
}

/**
 * Read a command-outcomes file: a JSON array of `{ command, exitCode, ok }`.
 * Command text is validated only (redaction happens later, at build time); the
 * file is rejected on any malformed entry so a bad input fails closed.
 */
export function readCommandOutcomes(filePath: string): CommandOutcome[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new EvidenceArchiveError(`cannot read outcomes file: file not found: ${filePath}`);
    }
    throw new EvidenceArchiveError(`cannot read outcomes file: ${e.message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvidenceArchiveError("outcomes file is not valid JSON");
  }
  if (!Array.isArray(value)) {
    throw new EvidenceArchiveError("outcomes file must be a JSON array of {command, exitCode, ok}");
  }
  const outcomes: CommandOutcome[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.command !== "string" ||
      typeof item.exitCode !== "number" ||
      typeof item.ok !== "boolean"
    ) {
      throw new EvidenceArchiveError("each outcome must have string command, number exitCode, boolean ok");
    }
    outcomes.push({ command: item.command, exitCode: item.exitCode, ok: item.ok });
  }
  return outcomes;
}

// --- verify ------------------------------------------------------------------

/**
 * Verify a bundle offline. Recomputes the manifest signature and each entry's
 * content digest, and reports any missing, extra (duplicate), or modified entry.
 * Deterministic and read-only.
 */
export function verifyEvidenceBundle(bundle: EvidenceBundle): EvidenceVerifyResult {
  const errors: string[] = [];
  const reports: EvidenceEntryReport[] = [];

  const signatureValid = manifestSignature(bundle) === bundle.signature;
  if (!signatureValid) {
    errors.push("manifest signature does not match (entries added, removed, reordered, or digest changed)");
  }

  const seen = new Set<string>();
  for (const entry of bundle.entries) {
    if (seen.has(entry.name)) {
      reports.push({ name: entry.name, kind: entry.kind, ok: false, reason: "duplicate entry name" });
      errors.push(`duplicate entry "${entry.name}"`);
      continue;
    }
    seen.add(entry.name);
    const actual = sha256(entry.content);
    if (actual !== entry.digest) {
      reports.push({ name: entry.name, kind: entry.kind, ok: false, reason: "content digest mismatch (modified)" });
      errors.push(`entry "${entry.name}" content does not match its digest`);
    } else {
      reports.push({ name: entry.name, kind: entry.kind, ok: true });
    }
  }

  return {
    schema: EVIDENCE_ARCHIVE_SCHEMA,
    v: EVIDENCE_ARCHIVE_VERSION,
    ok: signatureValid && reports.every((r) => r.ok),
    signatureValid,
    entries: reports,
    errors,
  };
}

// --- formatting --------------------------------------------------------------

/** Concise human rendering of an exported bundle. */
export function formatEvidenceExport(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`Evidence archive (${bundle.schema} v${bundle.v})`);
  lines.push("─".repeat(40));
  if (bundle.source.task) lines.push(`task:      ${bundle.source.task}`);
  if (bundle.source.outcome) lines.push(`outcome:   ${bundle.source.outcome}`);
  if (bundle.source.repoHead) lines.push(`repo head: ${bundle.source.repoHead}`);
  lines.push(`entries:   ${bundle.entries.length}`);
  for (const e of bundle.entries) {
    lines.push(`  - ${e.name} (${e.kind}) ${e.digest.slice(0, 12)}…`);
  }
  lines.push(`signature: ${bundle.signature}`);
  return lines.join("\n");
}

/** Concise human rendering of a verification result. */
export function formatEvidenceVerification(result: EvidenceVerifyResult): string {
  const lines: string[] = [];
  lines.push(`Evidence verification (${result.schema} v${result.v})`);
  lines.push("─".repeat(40));
  lines.push(`result:    ${result.ok ? "valid" : "invalid"}`);
  lines.push(`signature: ${result.signatureValid ? "ok" : "MISMATCH"}`);
  for (const e of result.entries) {
    lines.push(`  - ${e.name}: ${e.ok ? "ok" : e.reason}`);
  }
  if (result.errors.length > 0) {
    lines.push("errors:");
    for (const err of result.errors) lines.push(`  - ${err}`);
  }
  return lines.join("\n");
}
