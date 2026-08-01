// Read-only memory inspection: shows durable memory entries with
// provenance, staleness detection, scope, and secret redaction.
//
// Memory entries expose key, display value (redacted for secrets), scope
// (workspace/repository/user), provenance (session, turn), revision
// binding, and stale flag. The view is read-only and never creates,
// modifies, promotes, supersedes, or deletes memory entries.

export const MEMORY_INSPECTION_SCHEMA = "oh-my-cli.memory-inspection";
export const MEMORY_INSPECTION_VERSION = 1;

// --- memory types -----------------------------------------------------------

export type MemoryScope = "workspace" | "repository" | "user";

export interface MemoryProvenance {
  /** Session that created this memory. */
  sessionId: string;
  /** Turn that produced the memory (when known). */
  turnId?: string;
  /** Epoch ms of creation. */
  createdAt: number;
}

export interface MemoryEntry {
  /** Stable key. */
  key: string;
  /** Display value (redacted for secrets). */
  displayValue: string;
  /** Whether the raw value is a secret. */
  isSecret: boolean;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  /** Revision binding (e.g. commit SHA, config hash) for staleness detection. */
  revisionBinding?: string;
  /** Whether this memory is stale (revision mismatch). */
  isStale: boolean;
  /** Human-readable citation. */
  citation: string;
}

// --- secret detection -------------------------------------------------------

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i,
  /credential/i, /auth/i, /private[_-]?key/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

export function redactValue(value: string): string {
  if (value.length <= 4) return "[REDACTED]";
  return `${value.slice(0, 2)}…${value.slice(-2)} [REDACTED]`;
}

// --- staleness detection ----------------------------------------------------

// Check if a memory is stale by comparing its revision binding against the
// current revision.
export function checkStaleness(entry: MemoryEntry, currentRevision: string): boolean {
  if (!entry.revisionBinding) return false;
  return entry.revisionBinding !== currentRevision;
}

// --- memory store (read-only view model) ------------------------------------

export class MemoryStore {
  private readonly entries: MemoryEntry[] = [];

  /** Register a memory entry (for testing/view model construction). */
  register(opts: {
    key: string;
    rawValue: string;
    scope: MemoryScope;
    provenance: MemoryProvenance;
    revisionBinding?: string;
    currentRevision?: string;
  }): MemoryEntry {
    const secret = isSecretKey(opts.key);
    const entry: MemoryEntry = {
      key: opts.key,
      displayValue: secret ? redactValue(opts.rawValue) : opts.rawValue,
      isSecret: secret,
      scope: opts.scope,
      provenance: opts.provenance,
      revisionBinding: opts.revisionBinding,
      isStale: false,
      citation: buildCitation(opts.key, opts.scope, opts.provenance),
    };

    if (opts.revisionBinding && opts.currentRevision) {
      entry.isStale = checkStaleness(entry, opts.currentRevision);
    }

    this.entries.push(entry);
    return entry;
  }

  /** Re-check staleness against a new current revision. */
  refreshStaleness(currentRevision: string): void {
    for (const entry of this.entries) {
      entry.isStale = checkStaleness(entry, currentRevision);
    }
  }

  list(): MemoryEntry[] {
    return [...this.entries];
  }

  getByScope(scope: MemoryScope): MemoryEntry[] {
    return this.entries.filter((e) => e.scope === scope);
  }

  getStale(): MemoryEntry[] {
    return this.entries.filter((e) => e.isStale);
  }

  getSecrets(): MemoryEntry[] {
    return this.entries.filter((e) => e.isSecret);
  }

  get size(): number {
    return this.entries.length;
  }
}

function buildCitation(key: string, scope: MemoryScope, prov: MemoryProvenance): string {
  const turn = prov.turnId ? ` turn:${prov.turnId}` : "";
  return `[${scope}] ${key} (session:${prov.sessionId}${turn})`;
}

// --- inspection view --------------------------------------------------------

export interface MemoryInspectionView {
  schema: typeof MEMORY_INSPECTION_SCHEMA;
  v: typeof MEMORY_INSPECTION_VERSION;
  entries: MemoryEntry[];
  totalCount: number;
  staleCount: number;
  secretCount: number;
  scopeCounts: Partial<Record<MemoryScope, number>>;
  hasStale: boolean;
  snapshotAt: number;
}

export function assembleMemoryView(store: MemoryStore): MemoryInspectionView {
  const entries = store.list();
  const scopeCounts: Partial<Record<MemoryScope, number>> = {};

  for (const e of entries) {
    scopeCounts[e.scope] = (scopeCounts[e.scope] ?? 0) + 1;
  }

  return {
    schema: MEMORY_INSPECTION_SCHEMA,
    v: MEMORY_INSPECTION_VERSION,
    entries,
    totalCount: entries.length,
    staleCount: store.getStale().length,
    secretCount: store.getSecrets().length,
    scopeCounts,
    hasStale: store.getStale().length > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

export function formatMemoryView(view: MemoryInspectionView): string {
  const lines: string[] = [];
  lines.push("Memory Inspection");
  lines.push("═".repeat(50));
  lines.push(`Total: ${view.totalCount}  Stale: ${view.staleCount}  Secrets: ${view.secretCount}`);

  const scopes = Object.entries(view.scopeCounts);
  if (scopes.length > 0) {
    lines.push(`Scopes: ${scopes.map(([s, c]) => `${s}:${c}`).join("  ")}`);
  }

  if (view.hasStale) {
    lines.push("⚠ Stale memories detected (revision mismatch)");
  }

  for (const entry of view.entries) {
    const staleIcon = entry.isStale ? " ⚠STALE" : "";
    const secretIcon = entry.isSecret ? " 🔒" : "";
    lines.push(`● ${entry.key} = ${entry.displayValue} [${entry.scope}]${staleIcon}${secretIcon}`);
    lines.push(`  ${entry.citation}`);
    if (entry.revisionBinding) {
      lines.push(`  rev: ${entry.revisionBinding}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no memories created, modified, or deleted.");

  return lines.join("\n");
}
