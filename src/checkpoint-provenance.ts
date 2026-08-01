// Read-only checkpoint provenance: traces changed hunks to producing turns
// when real evidence exists.
//
// Each checkpoint entry exposes stable identity, creating turn, timestamp,
// and a bounded file/hunk summary. Hunk-to-turn attribution links a changed
// hunk to its producing turn only when real evidence exists; absent evidence
// reports "no provenance" rather than guessing. The view is read-only and
// never creates, deletes, or reverts checkpoints.

export const CHECKPOINT_PROVENANCE_SCHEMA = "oh-my-cli.checkpoint-provenance";
export const CHECKPOINT_PROVENANCE_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const MAX_FILES_PER_CHECKPOINT = 100;
const MAX_HUNKS_PER_FILE = 20;

// --- checkpoint entries -----------------------------------------------------

export interface FileChange {
  path: string;
  /** Number of hunks changed in this file. */
  hunkCount: number;
  /** Lines added. */
  additions: number;
  /** Lines removed. */
  deletions: number;
}

export interface CheckpointEntry {
  /** Stable, unique checkpoint identifier. */
  id: string;
  /** Turn that created this checkpoint (when known). */
  turnId?: string;
  /** Epoch ms of checkpoint creation. */
  createdAt: number;
  /** Human-readable label. */
  label: string;
  /** Changed files in this checkpoint. */
  files: FileChange[];
  /** Total additions across all files. */
  totalAdditions: number;
  /** Total deletions across all files. */
  totalDeletions: number;
}

// --- hunk attribution -------------------------------------------------------

export type ProvenanceState = "attributed" | "no-provenance";

export interface HunkAttribution {
  /** File path of the hunk. */
  path: string;
  /** Hunk index within the file. */
  hunkIndex: number;
  /** The checkpoint that contains this hunk. */
  checkpointId: string;
  /** The producing turn (when evidence exists). */
  turnId?: string;
  /** Whether attribution is based on real evidence. */
  provenanceState: ProvenanceState;
}

// Attribute a hunk to its producing turn based on checkpoint evidence.
// Returns "no-provenance" when the checkpoint has no turn evidence.
export function attributeHunk(
  checkpoint: CheckpointEntry,
  path: string,
  hunkIndex: number,
): HunkAttribution {
  const hasFile = checkpoint.files.some((f) => f.path === path);
  if (!hasFile) {
    return {
      path,
      hunkIndex,
      checkpointId: checkpoint.id,
      provenanceState: "no-provenance",
    };
  }

  if (checkpoint.turnId) {
    return {
      path,
      hunkIndex,
      checkpointId: checkpoint.id,
      turnId: checkpoint.turnId,
      provenanceState: "attributed",
    };
  }

  return {
    path,
    hunkIndex,
    checkpointId: checkpoint.id,
    provenanceState: "no-provenance",
  };
}

// --- provenance view --------------------------------------------------------

export interface ProvenanceView {
  schema: typeof CHECKPOINT_PROVENANCE_SCHEMA;
  v: typeof CHECKPOINT_PROVENANCE_VERSION;
  checkpoints: CheckpointEntry[];
  /** Total checkpoints. */
  totalCount: number;
  /** Checkpoints with turn attribution. */
  attributedCount: number;
  /** Checkpoints without turn evidence. */
  noProvenanceCount: number;
  snapshotAt: number;
}

// Assemble a read-only provenance view from checkpoint entries.
export function assembleProvenanceView(checkpoints: CheckpointEntry[]): ProvenanceView {
  let attributedCount = 0;
  let noProvenanceCount = 0;

  for (const cp of checkpoints) {
    if (cp.turnId) attributedCount++;
    else noProvenanceCount++;
  }

  return {
    schema: CHECKPOINT_PROVENANCE_SCHEMA,
    v: CHECKPOINT_PROVENANCE_VERSION,
    checkpoints,
    totalCount: checkpoints.length,
    attributedCount,
    noProvenanceCount,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format a provenance view as a compact, color-independent TUI view.
export function formatProvenanceView(view: ProvenanceView): string {
  const lines: string[] = [];
  lines.push("Checkpoint Provenance");
  lines.push("═".repeat(50));
  lines.push(`Checkpoints: ${view.totalCount}  Attributed: ${view.attributedCount}  No provenance: ${view.noProvenanceCount}`);

  for (const cp of view.checkpoints) {
    lines.push("");
    const turn = cp.turnId ? ` turn:${cp.turnId}` : " turn:(no provenance)";
    lines.push(`◆ ${cp.label} [${cp.id}]${turn}`);
    lines.push(`  ${cp.files.length} files  +${cp.totalAdditions} -${cp.totalDeletions}`);

    for (const file of cp.files.slice(0, 5)) {
      lines.push(`  · ${file.path} (${file.hunkCount} hunks, +${file.additions} -${file.deletions})`);
    }
    if (cp.files.length > 5) {
      lines.push(`  · … ${cp.files.length - 5} more files`);
    }
  }

  lines.push("");
  lines.push("Read-only: no checkpoints created, deleted, or reverted.");

  return lines.join("\n");
}

// Format a single hunk attribution.
export function formatAttribution(attr: HunkAttribution): string {
  if (attr.provenanceState === "attributed") {
    return `${attr.path} hunk#${attr.hunkIndex} → turn:${attr.turnId} [${attr.checkpointId}]`;
  }
  return `${attr.path} hunk#${attr.hunkIndex} → (no provenance) [${attr.checkpointId}]`;
}
