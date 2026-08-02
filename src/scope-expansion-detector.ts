// Scope expansion detector: detects when a Goal revision is materially
// broader than the previous objective.
//
// Compares a new objective against the previous one using heuristics
// (word count increase, new keywords, broader action verbs). Returns
// expansion status with details. Read-only detection, deterministic.

export const SCOPE_EXPANSION_SCHEMA = "oh-my-cli.scope-expansion-detector";
export const SCOPE_EXPANSION_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface ScopeExpansionResult {
  schema: typeof SCOPE_EXPANSION_SCHEMA;
  v: typeof SCOPE_EXPANSION_VERSION;
  /** Whether the new objective is materially broader. */
  expanded: boolean;
  /** The previous objective. */
  previousObjective: string;
  /** The new objective. */
  newObjective: string;
  /** Word count of the previous objective. */
  previousWordCount: number;
  /** Word count of the new objective. */
  newWordCount: number;
  /** New keywords found in the new objective. */
  newKeywords: string[];
  /** Explanation of the expansion detection. */
  reason: string;
}

// --- heuristics -------------------------------------------------------------

// Words that indicate broader scope.
const BROAD_KEYWORDS = new Set([
  "refactor", "redesign", "rewrite", "rebuild", "overhaul",
  "entire", "all", "every", "complete", "full",
  "and", "also", "additionally", "plus",
]);

// Action verbs that indicate broader scope.
const BROAD_VERBS = new Set([
  "refactor", "redesign", "rewrite", "rebuild", "migrate",
  "add", "implement", "create", "build",
]);

// --- detection --------------------------------------------------------------

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/);
  return new Set(words.filter((w) => w.length > 2));
}

// Detect whether a new objective is materially broader than the previous one.
export function detectScopeExpansion(
  previousObjective: string,
  newObjective: string,
): ScopeExpansionResult {
  const prevWords = countWords(previousObjective);
  const newWords = countWords(newObjective);
  const wordIncrease = newWords - prevWords;

  // Find new keywords.
  const prevKeywords = extractKeywords(previousObjective);
  const newKeywordsSet = extractKeywords(newObjective);
  const newKeywords = [...newKeywordsSet].filter((k) => !prevKeywords.has(k));

  // Find broad keywords/verbs in the new keywords.
  const broadKeywords = newKeywords.filter(
    (k) => BROAD_KEYWORDS.has(k) || BROAD_VERBS.has(k),
  );

  // Expansion heuristics:
  // 1. Word count increase > 50%
  // 2. New broad keywords/verbs present
  const wordCountExpansion = prevWords > 0 && wordIncrease > 0 && (wordIncrease / prevWords) > 0.5;
  const broadKeywordExpansion = broadKeywords.length > 0;

  const expanded = wordCountExpansion || broadKeywordExpansion;

  let reason: string;
  if (!expanded) {
    reason = "Scope is similar to the previous objective.";
  } else {
    const reasons: string[] = [];
    if (wordCountExpansion) {
      reasons.push(`word count increased ${prevWords} → ${newWords} (+${wordIncrease})`);
    }
    if (broadKeywordExpansion) {
      reasons.push(`new broad keywords: ${broadKeywords.join(", ")}`);
    }
    reason = `Scope expansion detected: ${reasons.join("; ")}. Confirm before proceeding.`;
  }

  return {
    schema: SCOPE_EXPANSION_SCHEMA,
    v: SCOPE_EXPANSION_VERSION,
    expanded,
    previousObjective,
    newObjective,
    previousWordCount: prevWords,
    newWordCount: newWords,
    newKeywords,
    reason,
  };
}

// --- formatting -------------------------------------------------------------

export function formatScopeExpansionWarning(result: ScopeExpansionResult): string {
  const icon = result.expanded ? "⚠" : "✓";
  const status = result.expanded ? "SCOPE EXPANSION" : "SCOPE OK";

  const lines: string[] = [];
  lines.push(`Scope: ${icon} ${status}`);
  lines.push(`Previous: "${result.previousObjective}"`);
  lines.push(`New: "${result.newObjective}"`);
  lines.push(`Words: ${result.previousWordCount} → ${result.newWordCount}`);
  if (result.newKeywords.length > 0) {
    lines.push(`New keywords: ${result.newKeywords.join(", ")}`);
  }
  lines.push(`Reason: ${result.reason}`);

  return lines.join("\n");
}
