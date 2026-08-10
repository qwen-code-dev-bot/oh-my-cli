// Step links: links transcript turns, files, and tool results to Goal steps.
//
// Each Goal step can be linked to transcript turns, file paths, and tool
// result IDs, making the execution record navigable and auditable. Links
// are bounded (max 50 per step), redacted, and deterministic. Append-only.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const STEP_LINKS_SCHEMA = "oh-my-cli.step-links";
export const STEP_LINKS_VERSION = 1;

// --- types ------------------------------------------------------------------

export type LinkType = "turn" | "file" | "tool-result";

export interface StepLink {
  /** Link type. */
  type: LinkType;
  /** The linked item ID (turn ID, file path, or tool result ID). */
  itemId: string;
  /** When the link was created (epoch ms). */
  linkedAt: number;
}

export interface StepLinkCollection {
  /** Goal revision. */
  goalRevision: number;
  /** Step number (1-based). */
  stepNumber: number;
  /** Links for this step. */
  links: StepLink[];
}

// --- bounds -----------------------------------------------------------------

const MAX_LINKS_PER_STEP = 50;
const MAX_ITEM_ID_LENGTH = 200;

function safeItemId(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_ITEM_ID_LENGTH
    ? redacted
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_ITEM_ID_LENGTH - 1))}…`;
}

// --- step link tracker ------------------------------------------------------

export class StepLinkTracker {
  private readonly collections = new Map<string, StepLinkCollection>();

  private key(goalRevision: number, stepNumber: number): string {
    return `${goalRevision}:${stepNumber}`;
  }

  private getOrCreate(goalRevision: number, stepNumber: number): StepLinkCollection {
    const key = this.key(goalRevision, stepNumber);
    let collection = this.collections.get(key);
    if (!collection) {
      collection = { goalRevision, stepNumber, links: [] };
      this.collections.set(key, collection);
    }
    return collection;
  }

  /** Link a transcript turn to a step. */
  linkTurnToStep(goalRevision: number, stepNumber: number, turnId: string, linkedAt: number = Date.now()): StepLink | null {
    return this.addLink(goalRevision, stepNumber, "turn", turnId, linkedAt);
  }

  /** Link a file path to a step. */
  linkFileToStep(goalRevision: number, stepNumber: number, filePath: string, linkedAt: number = Date.now()): StepLink | null {
    return this.addLink(goalRevision, stepNumber, "file", filePath, linkedAt);
  }

  /** Link a tool result to a step. */
  linkToolResultToStep(goalRevision: number, stepNumber: number, toolResultId: string, linkedAt: number = Date.now()): StepLink | null {
    return this.addLink(goalRevision, stepNumber, "tool-result", toolResultId, linkedAt);
  }

  private addLink(goalRevision: number, stepNumber: number, type: LinkType, itemId: string, linkedAt: number): StepLink | null {
    const collection = this.getOrCreate(goalRevision, stepNumber);
    if (collection.links.length >= MAX_LINKS_PER_STEP) {
      return null; // At capacity.
    }

    const link: StepLink = {
      type,
      itemId: safeItemId(itemId),
      linkedAt,
    };
    collection.links.push(link);
    return { ...link };
  }

  /** Get all links for a step. */
  getLinksForStep(goalRevision: number, stepNumber: number): StepLink[] {
    const collection = this.collections.get(this.key(goalRevision, stepNumber));
    return collection ? collection.links.map((l) => ({ ...l })) : [];
  }

  /** Get all collections. */
  getAllCollections(): StepLinkCollection[] {
    return [...this.collections.values()].map((c) => ({
      ...c,
      links: c.links.map((l) => ({ ...l })),
    }));
  }

  /** Total number of links across all steps. */
  get totalLinks(): number {
    let total = 0;
    for (const collection of this.collections.values()) {
      total += collection.links.length;
    }
    return total;
  }

  /** Number of steps with links. */
  get size(): number {
    return this.collections.size;
  }
}

// --- formatting -------------------------------------------------------------

export function formatStepLinks(tracker: StepLinkTracker): string {
  const collections = tracker.getAllCollections();
  const lines: string[] = [];

  lines.push("Step Links");
  lines.push("═".repeat(50));
  lines.push(`Steps with links: ${tracker.size}  Total links: ${tracker.totalLinks}`);

  for (const collection of collections) {
    lines.push("");
    lines.push(`Rev ${collection.goalRevision}, Step ${collection.stepNumber} (${collection.links.length} links):`);
    for (const link of collection.links.slice(0, 10)) {
      const icon = linkIcon(link.type);
      lines.push(`  ${icon} [${link.type}] ${link.itemId}`);
    }
    if (collection.links.length > 10) {
      lines.push(`  … ${collection.links.length - 10} more`);
    }
  }

  lines.push("");
  lines.push("Read-only: no execution performed.");

  return lines.join("\n");
}

function linkIcon(type: LinkType): string {
  switch (type) {
    case "turn": return "💬";
    case "file": return "📄";
    case "tool-result": return "🔧";
  }
}
