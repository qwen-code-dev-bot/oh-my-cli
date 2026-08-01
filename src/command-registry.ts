// Authoritative command registry: unifies slash-command discovery, help
// metadata, shortcut hints, and fuzzy action search in one stable model.
//
// Each action has a stable identifier, category, aliases, capability
// requirements, and a user-facing disabled reason. Search ranks exact,
// prefix, alias, recent, and fuzzy matches deterministically. Unavailable
// actions remain visible with the missing capability, state, or permission
// as a disabled reason. Shortcut hints derive from registry metadata without
// creating destructive single-keystroke defaults.
//
// The registry is surface-independent: the same metadata drives the TUI
// palette and a future Desktop command palette.

export const COMMAND_REGISTRY_SCHEMA = "oh-my-cli.command-registry";
export const COMMAND_REGISTRY_VERSION = 1;

// --- command metadata -------------------------------------------------------

export type CommandCategory =
  | "session"
  | "navigation"
  | "model"
  | "workflow"
  | "goal"
  | "diff"
  | "settings"
  | "help"
  | "system";

// A capability that may gate a command's availability.
export type Capability =
  | "trusted-workspace"
  | "active-session"
  | "provider-configured"
  | "workflow-enabled"
  | "goal-enabled"
  | "git-repository";

export interface CommandMeta {
  /** Stable, unique identifier (e.g. "session.export"). */
  id: string;
  /** User-facing title. */
  title: string;
  /** Slash-command trigger (e.g. "/export"). */
  slash: string;
  category: CommandCategory;
  /** Alternative triggers. */
  aliases: string[];
  /** Capabilities required for this command to be available. */
  capabilities: Capability[];
  /** Keyboard shortcut hint (e.g. "ctrl+e"). Never a destructive single key. */
  shortcut?: string;
  /** Brief description for help/palette. */
  description: string;
}

// --- disabled state ---------------------------------------------------------

export interface DisabledState {
  commandId: string;
  /** The missing capability, state, or permission. */
  reason: string;
}

// --- search ranking ---------------------------------------------------------

export type MatchType = "exact" | "prefix" | "alias" | "recent" | "fuzzy";

export interface SearchResult {
  command: CommandMeta;
  matchType: MatchType;
  score: number;
  disabled?: DisabledState;
}

// --- registry ---------------------------------------------------------------

export class CommandRegistry {
  private readonly commands = new Map<string, CommandMeta>();
  private readonly recentIds: string[] = [];
  private readonly maxRecent = 20;

  register(meta: CommandMeta): void {
    if (this.commands.has(meta.id)) {
      throw new Error(`Duplicate command id: ${meta.id}`);
    }
    // Validate shortcut safety: no single-character shortcuts (destructive).
    if (meta.shortcut && meta.shortcut.length <= 1) {
      throw new Error(`Unsafe single-keystroke shortcut for ${meta.id}: ${meta.shortcut}`);
    }
    this.commands.set(meta.id, meta);
  }

  get(id: string): CommandMeta | undefined {
    return this.commands.get(id);
  }

  getBySlash(slash: string): CommandMeta | undefined {
    for (const cmd of this.commands.values()) {
      if (cmd.slash === slash) return cmd;
      if (cmd.aliases.includes(slash)) return cmd;
    }
    return undefined;
  }

  list(): CommandMeta[] {
    return [...this.commands.values()];
  }

  listByCategory(category: CommandCategory): CommandMeta[] {
    return this.list().filter((c) => c.category === category);
  }

  /** Record a command usage for recency ranking. */
  recordUsage(id: string): void {
    const idx = this.recentIds.indexOf(id);
    if (idx >= 0) this.recentIds.splice(idx, 1);
    this.recentIds.unshift(id);
    if (this.recentIds.length > this.maxRecent) this.recentIds.length = this.maxRecent;
  }

  get size(): number {
    return this.commands.size;
  }

  // --- availability ---------------------------------------------------------

  /** Check which commands are disabled given the current capabilities. */
  checkAvailability(activeCapabilities: Set<Capability>): DisabledState[] {
    const disabled: DisabledState[] = [];
    for (const cmd of this.commands.values()) {
      for (const cap of cmd.capabilities) {
        if (!activeCapabilities.has(cap)) {
          disabled.push({
            commandId: cmd.id,
            reason: `Requires ${cap}`,
          });
          break; // One reason per command is enough.
        }
      }
    }
    return disabled;
  }

  isAvailable(id: string, activeCapabilities: Set<Capability>): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    return cmd.capabilities.every((cap) => activeCapabilities.has(cap));
  }

  // --- search ---------------------------------------------------------------

  /** Search commands by query with deterministic ranking. */
  search(
    query: string,
    activeCapabilities: Set<Capability>,
    limit: number = 20,
  ): SearchResult[] {
    const q = query.toLowerCase().trim();
    const disabledMap = new Map<string, DisabledState>();
    for (const d of this.checkAvailability(activeCapabilities)) {
      disabledMap.set(d.commandId, d);
    }

    const results: SearchResult[] = [];

    for (const cmd of this.commands.values()) {
      const match = scoreMatch(q, cmd, this.recentIds);
      if (match === null) continue;

      results.push({
        command: cmd,
        matchType: match.type,
        score: match.score,
        disabled: disabledMap.get(cmd.id),
      });
    }

    // Sort by score descending, then by id for determinism.
    results.sort((a, b) => b.score - a.score || a.command.id.localeCompare(b.command.id));
    return results.slice(0, limit);
  }
}

// --- matching ---------------------------------------------------------------

interface MatchScore {
  type: MatchType;
  score: number;
}

// Score a query against a command. Returns null for no match.
// Ranking: exact (100) > prefix (80) > alias (70) > recent (60) > fuzzy (variable).
function scoreMatch(query: string, cmd: CommandMeta, recentIds: string[]): MatchScore | null {
  if (query.length === 0) {
    return { type: "exact", score: 0 }; // Empty query matches everything.
  }

  const title = cmd.title.toLowerCase();
  const slash = cmd.slash.toLowerCase();
  const id = cmd.id.toLowerCase();

  // Exact match on slash command or id.
  if (slash === query || id === query) {
    return { type: "exact", score: 100 };
  }

  // Exact match on title.
  if (title === query) {
    return { type: "exact", score: 95 };
  }

  // Prefix match on slash or title.
  if (slash.startsWith(query) || title.startsWith(query)) {
    return { type: "prefix", score: 80 };
  }

  // Alias match.
  for (const alias of cmd.aliases) {
    if (alias.toLowerCase() === query) {
      return { type: "alias", score: 75 };
    }
    if (alias.toLowerCase().startsWith(query)) {
      return { type: "alias", score: 70 };
    }
  }

  // Recent match.
  const recentIdx = recentIds.indexOf(cmd.id);
  if (recentIdx >= 0 && (title.includes(query) || id.includes(query))) {
    return { type: "recent", score: 60 - recentIdx };
  }

  // Fuzzy subsequence match on title.
  const fuzzy = fuzzySubsequence(query, title);
  if (fuzzy !== null) {
    return { type: "fuzzy", score: fuzzy };
  }

  // Fuzzy on id.
  const fuzzyId = fuzzySubsequence(query, id);
  if (fuzzyId !== null) {
    return { type: "fuzzy", score: fuzzyId - 5 };
  }

  return null;
}

// Fuzzy subsequence scoring. Returns a score (1-50) or null for no match.
function fuzzySubsequence(query: string, target: string): number | null {
  let qi = 0;
  let score = 0;
  let prev = -2;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      score += 1;
      if (ti === prev + 1) score += 3; // Contiguity bonus.
      if (ti === 0 || " /-_.:".includes(target[ti - 1])) score += 2; // Boundary bonus.
      prev = ti;
      qi++;
    }
  }

  if (qi < query.length) return null;
  // Normalize to 1-50 range.
  return Math.min(50, Math.max(1, score));
}

// --- formatting -------------------------------------------------------------

// Format search results as a compact TUI palette list.
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matching commands.";

  const lines: string[] = [];
  for (const r of results) {
    const shortcut = r.command.shortcut ? ` [${r.command.shortcut}]` : "";
    const disabled = r.disabled ? ` ✗ ${r.disabled.reason}` : "";
    const aliasHint = r.command.aliases.length > 0 ? ` (${r.command.aliases.join(", ")})` : "";
    lines.push(`  ${r.command.slash} — ${r.command.title}${aliasHint}${shortcut}${disabled}`);
  }
  return lines.join("\n");
}

// Format a command's full help entry.
export function formatCommandHelp(cmd: CommandMeta): string {
  const lines: string[] = [];
  lines.push(`${cmd.slash} — ${cmd.title}`);
  lines.push(`  Category:   ${cmd.category}`);
  lines.push(`  ID:         ${cmd.id}`);
  if (cmd.aliases.length > 0) lines.push(`  Aliases:    ${cmd.aliases.join(", ")}`);
  if (cmd.shortcut) lines.push(`  Shortcut:   ${cmd.shortcut}`);
  if (cmd.capabilities.length > 0) lines.push(`  Requires:   ${cmd.capabilities.join(", ")}`);
  lines.push(`  ${cmd.description}`);
  return lines.join("\n");
}
