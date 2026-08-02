// Compact TUI workspace explorer and context composition.
//
// Provides TUI-oriented view models for the workspace tree, search results,
// and symbol navigation (from #332/#333), with keyboard attachment into the
// context composer (#334). Bounded previews enforce #332 policies before
// rendering. Canonical references are identical to the Desktop surface.
//
// This module produces data structures for a TUI renderer; it does not
// render to the terminal directly.

import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
  type ContextReference,
  type ReferenceProvenance,
} from "./context-reference.js";
import type { SymbolResult, ReferenceResult } from "./semantic-navigation.js";

export const WORKSPACE_EXPLORER_TUI_SCHEMA = "oh-my-cli.workspace-explorer-tui";
export const WORKSPACE_EXPLORER_TUI_VERSION = 1;

// --- explorer panel types ---------------------------------------------------

export type ExplorerPanel = "tree" | "search" | "symbols";

export interface TreeEntry {
  path: string;
  type: "file" | "directory";
  depth: number;
  /** Whether this entry is expanded in the tree view. */
  expanded: boolean;
}

export interface SearchEntry {
  path: string;
  /** Match line number. */
  line: number;
  /** Preview of the matched line. */
  preview: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

// --- attachment -------------------------------------------------------------

export interface AttachedReference {
  /** The canonical reference (identical to Desktop surface). */
  ref: ContextReference;
  /** When the reference was attached (epoch ms). */
  attachedAt: number;
  /** How the reference was attached. */
  method: "keyboard" | "search" | "symbol" | "tree";
}

// --- composer state ---------------------------------------------------------

export interface ComposerState {
  /** Attached references in order. */
  attached: AttachedReference[];
  /** Estimated total tokens. */
  estimatedTokens: number;
  /** Token budget. */
  budget: number;
  /** Whether the budget is exceeded. */
  overBudget: boolean;
}

// --- explorer state ---------------------------------------------------------

export interface ExplorerState {
  schema: typeof WORKSPACE_EXPLORER_TUI_SCHEMA;
  v: typeof WORKSPACE_EXPLORER_TUI_VERSION;
  /** Active panel. */
  activePanel: ExplorerPanel;
  /** Tree entries (when panel is "tree"). */
  treeEntries: TreeEntry[];
  /** Search results (when panel is "search"). */
  searchResults: SearchEntry[];
  /** Symbol results (when panel is "symbols"). */
  symbolResults: SymbolEntry[];
  /** Currently selected index in the active panel. */
  selectedIndex: number;
  /** Composer state. */
  composer: ComposerState;
}

// --- explorer controller ----------------------------------------------------

const DEFAULT_BUDGET = 8_000;
const CHARS_PER_TOKEN = 4;

export class WorkspaceExplorer {
  private state: ExplorerState;

  constructor(budget: number = DEFAULT_BUDGET) {
    this.state = {
      schema: WORKSPACE_EXPLORER_TUI_SCHEMA,
      v: WORKSPACE_EXPLORER_TUI_VERSION,
      activePanel: "tree",
      treeEntries: [],
      searchResults: [],
      symbolResults: [],
      selectedIndex: 0,
      composer: {
        attached: [],
        estimatedTokens: 0,
        budget,
        overBudget: false,
      },
    };
  }

  /** Switch the active panel. */
  setPanel(panel: ExplorerPanel): void {
    this.state.activePanel = panel;
    this.state.selectedIndex = 0;
  }

  /** Set tree entries. */
  setTreeEntries(entries: TreeEntry[]): void {
    this.state.treeEntries = entries;
  }

  /** Set search results. */
  setSearchResults(results: SearchEntry[]): void {
    this.state.searchResults = results;
  }

  /** Set symbol results. */
  setSymbolResults(results: SymbolEntry[]): void {
    this.state.symbolResults = results;
  }

  /** Move selection up/down. */
  moveSelection(delta: number): void {
    const max = this.activeEntries().length - 1;
    this.state.selectedIndex = Math.max(0, Math.min(max, this.state.selectedIndex + delta));
  }

  /** Attach the currently selected entry as a canonical reference. */
  attachSelected(method: AttachedReference["method"] = "keyboard"): AttachedReference | null {
    const entries = this.activeEntries();
    if (this.state.selectedIndex >= entries.length) return null;

    const ref = this.entryToReference(entries[this.state.selectedIndex]);
    if (!ref) return null;

    const attached: AttachedReference = {
      ref,
      attachedAt: Date.now(),
      method,
    };

    this.state.composer.attached.push(attached);
    this.recalculateBudget();
    return attached;
  }

  /** Attach a specific canonical reference directly. */
  attachReference(ref: ContextReference, method: AttachedReference["method"]): void {
    this.state.composer.attached.push({
      ref,
      attachedAt: Date.now(),
      method,
    });
    this.recalculateBudget();
  }

  /** Remove an attached reference by index. */
  removeAttached(index: number): void {
    if (index >= 0 && index < this.state.composer.attached.length) {
      this.state.composer.attached.splice(index, 1);
      this.recalculateBudget();
    }
  }

  /** Get the current state (read-only snapshot). */
  getState(): ExplorerState {
    return { ...this.state, composer: { ...this.state.composer, attached: [...this.state.composer.attached] } };
  }

  /** Get the composer state. */
  getComposer(): ComposerState {
    return { ...this.state.composer, attached: [...this.state.composer.attached] };
  }

  // --- internal helpers ---

  private activeEntries(): Array<TreeEntry | SearchEntry | SymbolEntry> {
    switch (this.state.activePanel) {
      case "tree": return this.state.treeEntries;
      case "search": return this.state.searchResults;
      case "symbols": return this.state.symbolResults;
    }
  }

  private entryToReference(entry: TreeEntry | SearchEntry | SymbolEntry): ContextReference | null {
    if ("type" in entry) {
      // TreeEntry
      if (entry.type === "directory") return null;
      return {
        schema: CONTEXT_REFERENCE_SCHEMA,
        v: CONTEXT_REFERENCE_VERSION,
        path: entry.path,
        provenance: "picker" as ReferenceProvenance,
      };
    }
    if ("preview" in entry) {
      // SearchEntry
      return {
        schema: CONTEXT_REFERENCE_SCHEMA,
        v: CONTEXT_REFERENCE_VERSION,
        path: entry.path,
        lines: { start: entry.line, end: entry.line },
        provenance: "search" as ReferenceProvenance,
      };
    }
    // SymbolEntry
    return {
      schema: CONTEXT_REFERENCE_SCHEMA,
      v: CONTEXT_REFERENCE_VERSION,
      path: entry.filePath,
      lines: { start: entry.line, end: entry.line },
      symbol: entry.name,
      provenance: "search" as ReferenceProvenance,
    };
  }

  private recalculateBudget(): void {
    let total = 0;
    for (const a of this.state.composer.attached) {
      // Rough estimate based on path length and line range.
      const lineCount = a.ref.lines ? a.ref.lines.end - a.ref.lines.start + 1 : 50;
      total += Math.ceil((lineCount * 40) / CHARS_PER_TOKEN);
    }
    this.state.composer.estimatedTokens = total;
    this.state.composer.overBudget = total > this.state.composer.budget;
  }
}

// --- surface equivalence ----------------------------------------------------

// Verify that a TUI-produced reference is equivalent to a Desktop-produced
// reference (same path, lines, symbol, provenance).
export function verifySurfaceEquivalence(
  tuiRef: ContextReference,
  desktopRef: ContextReference,
): boolean {
  return (
    tuiRef.path === desktopRef.path &&
    tuiRef.schema === desktopRef.schema &&
    tuiRef.v === desktopRef.v &&
    (tuiRef.lines?.start ?? 0) === (desktopRef.lines?.start ?? 0) &&
    (tuiRef.lines?.end ?? 0) === (desktopRef.lines?.end ?? 0) &&
    (tuiRef.symbol ?? "") === (desktopRef.symbol ?? "") &&
    tuiRef.provenance === desktopRef.provenance
  );
}

// --- formatting -------------------------------------------------------------

export function formatExplorerState(state: ExplorerState): string {
  const lines: string[] = [];
  lines.push(`Explorer [${state.activePanel}]`);
  lines.push("─".repeat(40));

  const entries = state.activePanel === "tree" ? state.treeEntries :
    state.activePanel === "search" ? state.searchResults :
    state.symbolResults;

  for (let i = 0; i < Math.min(entries.length, 10); i++) {
    const cursor = i === state.selectedIndex ? "▸" : " ";
    const entry = entries[i];
    if ("type" in entry) {
      const icon = entry.type === "directory" ? "📁" : "📄";
      lines.push(`${cursor} ${"  ".repeat(entry.depth)}${icon} ${entry.path}`);
    } else if ("preview" in entry) {
      lines.push(`${cursor} ${entry.path}:${entry.line} ${entry.preview}`);
    } else {
      lines.push(`${cursor} ${entry.kind} ${entry.name} — ${entry.filePath}:${entry.line}`);
    }
  }

  lines.push("");
  lines.push(`Composer: ${state.composer.attached.length} refs, ~${state.composer.estimatedTokens}/${state.composer.budget} tokens${state.composer.overBudget ? " ⚠OVER" : ""}`);
  for (const a of state.composer.attached) {
    lines.push(`  · ${a.ref.path}${a.ref.lines ? `:${a.ref.lines.start}-${a.ref.lines.end}` : ""} [${a.method}]`);
  }

  return lines.join("\n");
}
