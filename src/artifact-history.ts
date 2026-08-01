// Read-only artifact history: links produced artifacts to producing turns
// and file diffs when real evidence exists.
//
// Artifact entries expose stable identity, kind, producing turn, session,
// content hash, timestamp, and associated file paths. History is ordered by
// production time and bounded. Attribution is present only when real
// evidence exists; absent evidence reports "no attribution". The view is
// read-only and never creates, modifies, or deletes artifacts.

export const ARTIFACT_HISTORY_SCHEMA = "oh-my-cli.artifact-history";
export const ARTIFACT_HISTORY_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 100;

// --- artifact types ---------------------------------------------------------

export type ArtifactKind = "html" | "image" | "screenshot" | "export" | "document" | "other";

export type AttributionState = "attributed" | "no-attribution";

export interface ArtifactEntry {
  /** Stable, unique identifier. */
  id: string;
  kind: ArtifactKind;
  /** Display label. */
  label: string;
  /** SHA-256 hex digest of the artifact content. */
  contentHash: string;
  /** Session that produced this artifact. */
  sessionId: string;
  /** Turn that produced this artifact (when known). */
  turnId?: string;
  /** Associated file paths (when known). */
  filePaths: string[];
  /** Epoch ms of production. */
  producedAt: number;
  /** Size in bytes. */
  sizeBytes: number;
  /** Whether turn/file attribution is based on real evidence. */
  attributionState: AttributionState;
}

// --- artifact history -------------------------------------------------------

export class ArtifactHistory {
  private readonly entries: ArtifactEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Record a produced artifact. */
  record(opts: {
    id: string;
    kind: ArtifactKind;
    label: string;
    contentHash: string;
    sessionId: string;
    turnId?: string;
    filePaths?: string[];
    producedAt: number;
    sizeBytes: number;
  }): ArtifactEntry {
    const entry: ArtifactEntry = {
      ...opts,
      filePaths: opts.filePaths ?? [],
      attributionState: (opts.turnId || (opts.filePaths && opts.filePaths.length > 0))
        ? "attributed"
        : "no-attribution",
    };
    this.entries.push(entry);
    // Bound the history.
    if (this.entries.length > this.maxEntries) {
      this.entries.shift(); // Remove oldest.
    }
    return entry;
  }

  /** Get all entries ordered by production time (newest first). */
  list(): ArtifactEntry[] {
    return [...this.entries].sort((a, b) => b.producedAt - a.producedAt);
  }

  /** Get entries for a specific session. */
  getBySession(sessionId: string): ArtifactEntry[] {
    return this.list().filter((e) => e.sessionId === sessionId);
  }

  /** Get entries for a specific turn. */
  getByTurn(turnId: string): ArtifactEntry[] {
    return this.list().filter((e) => e.turnId === turnId);
  }

  /** Get entries with no attribution. */
  getUnattributed(): ArtifactEntry[] {
    return this.list().filter((e) => e.attributionState === "no-attribution");
  }

  get size(): number {
    return this.entries.length;
  }
}

// --- history view -----------------------------------------------------------

export interface ArtifactHistoryView {
  schema: typeof ARTIFACT_HISTORY_SCHEMA;
  v: typeof ARTIFACT_HISTORY_VERSION;
  entries: ArtifactEntry[];
  totalCount: number;
  attributedCount: number;
  unattributedCount: number;
  /** Counts by kind. */
  kindCounts: Partial<Record<ArtifactKind, number>>;
  snapshotAt: number;
}

// Assemble a read-only history view.
export function assembleArtifactHistoryView(history: ArtifactHistory): ArtifactHistoryView {
  const entries = history.list();
  const kindCounts: Partial<Record<ArtifactKind, number>> = {};

  let attributedCount = 0;
  let unattributedCount = 0;

  for (const e of entries) {
    kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    if (e.attributionState === "attributed") attributedCount++;
    else unattributedCount++;
  }

  return {
    schema: ARTIFACT_HISTORY_SCHEMA,
    v: ARTIFACT_HISTORY_VERSION,
    entries,
    totalCount: entries.length,
    attributedCount,
    unattributedCount,
    kindCounts,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format a history view as a compact TUI view.
export function formatArtifactHistoryView(view: ArtifactHistoryView): string {
  const lines: string[] = [];
  lines.push("Artifact History");
  lines.push("═".repeat(50));
  lines.push(`Total: ${view.totalCount}  Attributed: ${view.attributedCount}  Unattributed: ${view.unattributedCount}`);

  const kinds = Object.entries(view.kindCounts);
  if (kinds.length > 0) {
    lines.push(`Kinds: ${kinds.map(([k, v]) => `${k}:${v}`).join("  ")}`);
  }

  for (const entry of view.entries.slice(0, 10)) {
    const icon = kindIcon(entry.kind);
    const turn = entry.turnId ? ` turn:${entry.turnId}` : " turn:(no attribution)";
    const files = entry.filePaths.length > 0 ? ` files:[${entry.filePaths.join(", ")}]` : "";
    lines.push(`${icon} ${entry.label} [${entry.id}]${turn}${files}`);
    lines.push(`  ${entry.kind}  ${entry.sizeBytes}B  hash:${entry.contentHash.slice(0, 12)}…`);
  }

  if (view.entries.length > 10) {
    lines.push(`… ${view.entries.length - 10} more artifacts`);
  }

  lines.push("");
  lines.push("Read-only: no artifacts created, modified, or deleted.");

  return lines.join("\n");
}

function kindIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "html": return "◆";
    case "image": return "▣";
    case "screenshot": return "▣";
    case "export": return "◇";
    case "document": return "▤";
    case "other": return "·";
  }
}
