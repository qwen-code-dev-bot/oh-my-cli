// Semantic navigation: symbol search, go-to-definition, find-references,
// and diagnostics as bounded canonical references with git-aware badges.
//
// Builds on the canonical reference model (#332) and enforces the same
// trust/ignore/redaction/size/binary policies. Navigation results are
// bounded, policy-checked, and attachable as context. Git-aware badges
// mark modified/staged results. The module is surface-independent.

import path from "node:path";
import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
  type ContextReference,
  type LineRange,
} from "./context-reference.js";

export const SEMANTIC_NAVIGATION_SCHEMA = "oh-my-cli.semantic-navigation";
export const SEMANTIC_NAVIGATION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type SymbolKind =
  | "function" | "class" | "method" | "interface" | "type"
  | "variable" | "constant" | "enum" | "module" | "property";

export type GitBadge = "clean" | "modified" | "staged" | "untracked";

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface SymbolResult {
  /** Symbol name. */
  name: string;
  kind: SymbolKind;
  /** File path (workspace-relative). */
  filePath: string;
  /** Line range of the symbol definition. */
  range: LineRange;
  /** Git status badge. */
  gitBadge: GitBadge;
  /** Whether this result passed policy checks. */
  policyAllowed: boolean;
  /** Policy refusal reason (when not allowed). */
  policyRefusal?: string;
}

export interface ReferenceResult {
  /** The symbol being referenced. */
  symbolName: string;
  /** File containing the reference. */
  filePath: string;
  /** Line of the reference. */
  line: number;
  /** Git status badge. */
  gitBadge: GitBadge;
  policyAllowed: boolean;
  policyRefusal?: string;
}

export interface DiagnosticResult {
  filePath: string;
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  /** Git status badge. */
  gitBadge: GitBadge;
  policyAllowed: boolean;
}

// --- navigation result ------------------------------------------------------

export interface NavigationResult {
  schema: typeof SEMANTIC_NAVIGATION_SCHEMA;
  v: typeof SEMANTIC_NAVIGATION_VERSION;
  /** Symbol definitions found. */
  symbols: SymbolResult[];
  /** References found. */
  references: ReferenceResult[];
  /** Diagnostics found. */
  diagnostics: DiagnosticResult[];
  /** Total results before bounding. */
  totalBeforeBound: number;
  /** Whether results were truncated. */
  truncated: boolean;
}

// --- bounds -----------------------------------------------------------------

const MAX_SYMBOLS = 50;
const MAX_REFERENCES = 100;
const MAX_DIAGNOSTICS = 50;

// --- policy enforcement (mirrors #332) --------------------------------------

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i,
  /credential/i, /auth/i, /private[_-]?key/i,
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".so", ".dylib",
  ".woff", ".woff2", ".ttf", ".otf", ".wasm",
]);

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "__pycache__", ".git",
]);

export interface NavigationPolicy {
  trusted: boolean;
  ignore: boolean;
}

// Check if a file path passes navigation policy.
export function checkNavigationPolicy(
  filePath: string,
  policy: NavigationPolicy,
): { allowed: boolean; refusal?: string } {
  if (!policy.trusted) {
    return { allowed: false, refusal: "untrusted" };
  }

  const segments = filePath.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(seg) || seg.startsWith(".")) {
      return { allowed: false, refusal: "ignored" };
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return { allowed: false, refusal: "binary" };
  }

  const basename = segments[segments.length - 1];
  if (SECRET_KEY_PATTERNS.some((re) => re.test(basename))) {
    return { allowed: false, refusal: "secret" };
  }

  return { allowed: true };
}

// --- canonical reference conversion -----------------------------------------

// Convert a symbol result to a canonical context reference (#332 model).
export function symbolToReference(symbol: SymbolResult): ContextReference | null {
  if (!symbol.policyAllowed) return null;
  return {
    schema: CONTEXT_REFERENCE_SCHEMA,
    v: CONTEXT_REFERENCE_VERSION,
    path: symbol.filePath,
    lines: symbol.range,
    symbol: symbol.name,
    provenance: "search",
  };
}

// Convert a reference result to a canonical context reference.
export function referenceToReference(ref: ReferenceResult): ContextReference | null {
  if (!ref.policyAllowed) return null;
  return {
    schema: CONTEXT_REFERENCE_SCHEMA,
    v: CONTEXT_REFERENCE_VERSION,
    path: ref.filePath,
    lines: { start: ref.line, end: ref.line },
    provenance: "search",
  };
}

// --- result assembly --------------------------------------------------------

// Assemble a bounded navigation result from raw results, applying policy
// checks and git badges.
export function assembleNavigationResult(opts: {
  symbols: Array<Omit<SymbolResult, "policyAllowed" | "policyRefusal" | "gitBadge">>;
  references: Array<Omit<ReferenceResult, "policyAllowed" | "policyRefusal" | "gitBadge">>;
  diagnostics: Array<Omit<DiagnosticResult, "policyAllowed" | "gitBadge">>;
  policy: NavigationPolicy;
  gitStatus?: Map<string, GitBadge>;
}): NavigationResult {
  const { policy, gitStatus } = opts;
  const totalBeforeBound = opts.symbols.length + opts.references.length + opts.diagnostics.length;

  const symbols: SymbolResult[] = opts.symbols.slice(0, MAX_SYMBOLS).map((s) => {
    const policyCheck = checkNavigationPolicy(s.filePath, policy);
    return {
      ...s,
      gitBadge: gitStatus?.get(s.filePath) ?? "clean",
      policyAllowed: policyCheck.allowed,
      policyRefusal: policyCheck.refusal,
    };
  });

  const references: ReferenceResult[] = opts.references.slice(0, MAX_REFERENCES).map((r) => {
    const policyCheck = checkNavigationPolicy(r.filePath, policy);
    return {
      ...r,
      gitBadge: gitStatus?.get(r.filePath) ?? "clean",
      policyAllowed: policyCheck.allowed,
      policyRefusal: policyCheck.refusal,
    };
  });

  const diagnostics: DiagnosticResult[] = opts.diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => {
    const policyCheck = checkNavigationPolicy(d.filePath, policy);
    return {
      ...d,
      gitBadge: gitStatus?.get(d.filePath) ?? "clean",
      policyAllowed: policyCheck.allowed,
    };
  });

  return {
    schema: SEMANTIC_NAVIGATION_SCHEMA,
    v: SEMANTIC_NAVIGATION_VERSION,
    symbols,
    references,
    diagnostics,
    totalBeforeBound,
    truncated: totalBeforeBound > symbols.length + references.length + diagnostics.length,
  };
}

// --- formatting -------------------------------------------------------------

export function formatNavigationResult(result: NavigationResult): string {
  const lines: string[] = [];
  lines.push("Semantic Navigation");
  lines.push("═".repeat(50));

  if (result.symbols.length > 0) {
    lines.push(`Symbols (${result.symbols.length}):`);
    for (const s of result.symbols) {
      const badge = badgeIcon(s.gitBadge);
      const policy = s.policyAllowed ? "" : ` [BLOCKED: ${s.policyRefusal}]`;
      lines.push(`  ${badge} ${s.kind} ${s.name} — ${s.filePath}:${s.range.start}-${s.range.end}${policy}`);
    }
  }

  if (result.references.length > 0) {
    lines.push(`References (${result.references.length}):`);
    for (const r of result.references) {
      const badge = badgeIcon(r.gitBadge);
      const policy = r.policyAllowed ? "" : ` [BLOCKED: ${r.policyRefusal}]`;
      lines.push(`  ${badge} ${r.symbolName} — ${r.filePath}:${r.line}${policy}`);
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push(`Diagnostics (${result.diagnostics.length}):`);
    for (const d of result.diagnostics) {
      const badge = badgeIcon(d.gitBadge);
      lines.push(`  ${badge} [${d.severity}] ${d.filePath}:${d.line} — ${d.message}`);
    }
  }

  if (result.truncated) {
    lines.push(`… truncated (${result.totalBeforeBound} total results)`);
  }

  lines.push("");
  lines.push("Read-only: no files modified, no symbols mutated.");

  return lines.join("\n");
}

function badgeIcon(badge: GitBadge): string {
  switch (badge) {
    case "clean": return "○";
    case "modified": return "●";
    case "staged": return "◆";
    case "untracked": return "?";
  }
}
