// Read-only artifact revision tracking: records content-hash snapshots,
// detects external file changes, and flags stale overwrites.
//
// Revision entries expose artifact path, revision index, content hash,
// timestamp, and change source. External change detection compares hashes.
// Stale-overwrite warnings appear when an agent edit would replace
// externally modified content. The view is read-only and never writes,
// creates, or modifies artifact files.

export const REVISION_TRACKING_SCHEMA = "oh-my-cli.revision-tracking";
export const REVISION_TRACKING_VERSION = 1;

// --- revision types ---------------------------------------------------------

export type ChangeSource = "agent" | "external" | "unknown";

export interface RevisionEntry {
  /** Artifact path (workspace-relative). */
  path: string;
  /** Revision index (0-based, monotonically increasing per artifact). */
  revisionIndex: number;
  /** SHA-256 hex digest of the content at this revision. */
  contentHash: string;
  /** Epoch ms of the revision. */
  timestamp: number;
  /** Who made the change. */
  source: ChangeSource;
}

export interface ArtifactRevisionHistory {
  path: string;
  revisions: RevisionEntry[];
  /** Index of the last known revision. */
  lastIndex: number;
  /** Hash of the last known revision. */
  lastHash: string;
  /** Whether an external change has been detected since the last agent edit. */
  externallyModified: boolean;
  /** Whether an agent edit would overwrite external changes. */
  staleOverwriteRisk: boolean;
}

// --- revision tracker -------------------------------------------------------

export class RevisionTracker {
  private readonly histories = new Map<string, ArtifactRevisionHistory>();

  /** Record a new revision for an artifact. */
  recordRevision(opts: {
    path: string;
    contentHash: string;
    timestamp: number;
    source: ChangeSource;
  }): RevisionEntry {
    let history = this.histories.get(opts.path);
    if (!history) {
      history = {
        path: opts.path,
        revisions: [],
        lastIndex: -1,
        lastHash: "",
        externallyModified: false,
        staleOverwriteRisk: false,
      };
      this.histories.set(opts.path, history);
    }

    const entry: RevisionEntry = {
      path: opts.path,
      revisionIndex: history.lastIndex + 1,
      contentHash: opts.contentHash,
      timestamp: opts.timestamp,
      source: opts.source,
    };

    history.revisions.push(entry);
    history.lastIndex = entry.revisionIndex;
    history.lastHash = entry.contentHash;

    // Update external modification and stale-overwrite tracking.
    if (opts.source === "external") {
      history.externallyModified = true;
    } else if (opts.source === "agent") {
      // Agent edit clears external flag but check for stale overwrite.
      if (history.externallyModified) {
        history.staleOverwriteRisk = true;
      }
      history.externallyModified = false;
    }

    return entry;
  }

  /** Detect external changes by comparing the last known hash against a
   *  current hash. Returns true if the file was modified externally. */
  detectExternalChange(path: string, currentHash: string): boolean {
    const history = this.histories.get(path);
    if (!history || history.lastHash === "") return false;

    if (history.lastHash !== currentHash) {
      history.externallyModified = true;
      return true;
    }
    return false;
  }

  /** Check if an agent edit would risk overwriting external changes. */
  checkStaleOverwrite(path: string): boolean {
    const history = this.histories.get(path);
    return history?.externallyModified ?? false;
  }

  get(path: string): ArtifactRevisionHistory | undefined {
    return this.histories.get(path);
  }

  list(): ArtifactRevisionHistory[] {
    return [...this.histories.values()];
  }

  /** Get all artifacts with external modifications. */
  getExternallyModified(): ArtifactRevisionHistory[] {
    return this.list().filter((h) => h.externallyModified);
  }

  /** Get all artifacts with stale-overwrite risk. */
  getStaleOverwriteRisks(): ArtifactRevisionHistory[] {
    return this.list().filter((h) => h.staleOverwriteRisk);
  }

  get size(): number {
    return this.histories.size;
  }
}

// --- formatting -------------------------------------------------------------

export function formatRevisionHistory(history: ArtifactRevisionHistory): string {
  const lines: string[] = [];
  const warn = history.externallyModified ? " ⚠EXTERNALLY MODIFIED" : "";
  const stale = history.staleOverwriteRisk ? " ⚠STALE OVERWRITE RISK" : "";
  lines.push(`${history.path} (${history.revisions.length} revisions)${warn}${stale}`);

  for (const rev of history.revisions) {
    const icon = sourceIcon(rev.source);
    lines.push(`  ${icon} rev ${rev.revisionIndex} hash:${rev.contentHash.slice(0, 12)}… [${rev.source}]`);
  }

  return lines.join("\n");
}

export function formatTrackerSummary(tracker: RevisionTracker): string {
  const lines: string[] = [];
  lines.push("Revision Tracking");
  lines.push("═".repeat(50));
  lines.push(`Artifacts: ${tracker.size}  Externally modified: ${tracker.getExternallyModified().length}  Stale risks: ${tracker.getStaleOverwriteRisks().length}`);

  for (const history of tracker.list()) {
    lines.push("");
    lines.push(formatRevisionHistory(history));
  }

  lines.push("");
  lines.push("Read-only: no files written, created, or modified.");

  return lines.join("\n");
}

function sourceIcon(source: ChangeSource): string {
  switch (source) {
    case "agent": return "◆";
    case "external": return "○";
    case "unknown": return "?";
  }
}
