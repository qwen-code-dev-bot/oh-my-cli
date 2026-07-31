// Canonical context reference shared by the TUI and Desktop surfaces.
//
// A context reference is a bounded, surface-independent pointer to a location
// in the workspace: a file path (workspace-relative, `/`-separated), an
// optional line range, an optional symbol name, and a provenance tag that
// records how the reference was produced (tree walk, recent list, content
// search, manual entry, or `@` picker). Both surfaces serialize and parse the
// same wire format so a reference produced in one surface is valid in the
// other.
//
// This module is pure: it defines the format, validates instances, and
// provides serialization round-trips. It never touches the filesystem. Policy
// enforcement (trust, ignore, binary, secret, size) is the navigator's
// responsibility before a reference is returned to a surface.

export const CONTEXT_REFERENCE_SCHEMA = "oh-my-cli.context-reference";
export const CONTEXT_REFERENCE_VERSION = 1;

// How a reference was produced. Surfaces use this to group, sort, or badge
// references without changing the wire format.
export type ReferenceProvenance =
  | "tree"
  | "recent"
  | "search"
  | "manual"
  | "picker";

const PROVENANCE_VALUES: ReadonlySet<string> = new Set([
  "tree",
  "recent",
  "search",
  "manual",
  "picker",
]);

// A line range is 1-based, inclusive on both ends. `start <= end` is enforced
// by validation. A single-line reference uses start === end.
export interface LineRange {
  start: number;
  end: number;
}

// The canonical context reference. Every field except `path` and `provenance`
// is optional: a file-level reference has no lines or symbol; a symbol-level
// reference carries the symbol name and may also carry the line range where
// the symbol was found.
export interface ContextReference {
  schema: typeof CONTEXT_REFERENCE_SCHEMA;
  v: typeof CONTEXT_REFERENCE_VERSION;
  /** Workspace-relative, `/`-separated path. Never absolute, never `..`. */
  path: string;
  /** Optional 1-based inclusive line range. */
  lines?: LineRange;
  /** Optional symbol name (function, class, …) the reference points at. */
  symbol?: string;
  /** How this reference was produced. */
  provenance: ReferenceProvenance;
}

// --- validation -------------------------------------------------------------

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

// Validate a candidate object as a ContextReference. Checks structural
// correctness and path safety (no absolute paths, no `..` traversal, no NUL
// bytes). Does not touch the filesystem.
export function validateContextReference(v: unknown): ValidationResult {
  if (typeof v !== "object" || v === null) {
    return { valid: false, reason: "not an object" };
  }
  const o = v as Record<string, unknown>;

  if (o.schema !== CONTEXT_REFERENCE_SCHEMA) {
    return { valid: false, reason: `unexpected schema: ${String(o.schema)}` };
  }
  if (o.v !== CONTEXT_REFERENCE_VERSION) {
    return { valid: false, reason: `unsupported version: ${String(o.v)}` };
  }
  if (typeof o.path !== "string" || o.path.length === 0) {
    return { valid: false, reason: "path must be a non-empty string" };
  }
  const pathResult = validatePath(o.path);
  if (!pathResult.valid) return pathResult;

  if (o.lines !== undefined) {
    if (typeof o.lines !== "object" || o.lines === null) {
      return { valid: false, reason: "lines must be an object" };
    }
    const lines = o.lines as Record<string, unknown>;
    if (
      typeof lines.start !== "number" ||
      typeof lines.end !== "number" ||
      !Number.isInteger(lines.start) ||
      !Number.isInteger(lines.end) ||
      lines.start < 1 ||
      lines.end < lines.start
    ) {
      return { valid: false, reason: "lines must be 1-based with start <= end" };
    }
  }

  if (o.symbol !== undefined && typeof o.symbol !== "string") {
    return { valid: false, reason: "symbol must be a string when present" };
  }

  if (typeof o.provenance !== "string" || !PROVENANCE_VALUES.has(o.provenance)) {
    return { valid: false, reason: `unknown provenance: ${String(o.provenance)}` };
  }

  return { valid: true };
}

// Path safety: no absolute paths, no `..` segments, no NUL bytes, no
// backslashes (the canonical separator is `/`).
function validatePath(p: string): ValidationResult {
  if (p.includes("\0")) {
    return { valid: false, reason: "path contains NUL" };
  }
  if (p.startsWith("/")) {
    return { valid: false, reason: "path must be workspace-relative" };
  }
  if (p.includes("\\")) {
    return { valid: false, reason: "path must use / separators" };
  }
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return { valid: false, reason: "path must not contain .." };
    }
  }
  return { valid: true };
}

// --- construction -----------------------------------------------------------

// Create a validated ContextReference. Throws on invalid input so callers
// cannot silently propagate a malformed reference.
export function createContextReference(
  path: string,
  provenance: ReferenceProvenance,
  lines?: LineRange,
  symbol?: string,
): ContextReference {
  const ref: ContextReference = {
    schema: CONTEXT_REFERENCE_SCHEMA,
    v: CONTEXT_REFERENCE_VERSION,
    path,
    provenance,
    ...(lines !== undefined ? { lines } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
  };
  const result = validateContextReference(ref);
  if (!result.valid) {
    throw new Error(`Invalid context reference: ${result.reason}`);
  }
  return ref;
}

// --- serialization ----------------------------------------------------------

// Serialize a ContextReference to a compact, human-readable string:
//
//   path
//   path:10
//   path:10-25
//   path:10-25#symbolName
//   path#symbolName
//
// The schema and version are implicit (the wire format is versioned by the
// module). Provenance is not serialized: it is metadata about how the
// reference was produced, not part of the location. Callers that need
// provenance across a boundary should transmit the full JSON form.
export function serializeReference(ref: ContextReference): string {
  let out = ref.path;
  if (ref.lines) {
    out += ref.lines.start === ref.lines.end
      ? `:${ref.lines.start}`
      : `:${ref.lines.start}-${ref.lines.end}`;
  }
  if (ref.symbol) {
    out += `#${ref.symbol}`;
  }
  return out;
}

// Parse a serialized reference string back into a ContextReference. The
// `provenance` parameter supplies the provenance (not encoded in the wire
// format). Returns null when the string is malformed.
export function parseSerializedReference(
  raw: string,
  provenance: ReferenceProvenance = "manual",
): ContextReference | null {
  if (raw.length === 0) return null;

  // Split off the symbol fragment first (rightmost `#`).
  let symbol: string | undefined;
  let rest = raw;
  const hashIdx = rest.lastIndexOf("#");
  if (hashIdx > 0) {
    symbol = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
    if (symbol.length === 0) symbol = undefined;
  }

  // Split off the line range (rightmost `:` after the last `/` so Windows-free
  // paths with drive letters are not a concern; the canonical format uses `/`).
  let lines: LineRange | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const colonIdx = rest.indexOf(":", lastSlash + 1);
  if (colonIdx > 0) {
    const linePart = rest.slice(colonIdx + 1);
    rest = rest.slice(0, colonIdx);
    const dashIdx = linePart.indexOf("-");
    if (dashIdx >= 0) {
      const start = Number(linePart.slice(0, dashIdx));
      const end = Number(linePart.slice(dashIdx + 1));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return null;
      }
      lines = { start, end };
    } else {
      const line = Number(linePart);
      if (!Number.isInteger(line) || line < 1) return null;
      lines = { start: line, end: line };
    }
  }

  if (rest.length === 0) return null;

  const ref: ContextReference = {
    schema: CONTEXT_REFERENCE_SCHEMA,
    v: CONTEXT_REFERENCE_VERSION,
    path: rest,
    provenance,
    ...(lines ? { lines } : {}),
    ...(symbol ? { symbol } : {}),
  };
  const result = validateContextReference(ref);
  return result.valid ? ref : null;
}

// --- JSON round-trip --------------------------------------------------------

// Serialize to a JSON string (full fidelity including provenance).
export function referenceToJson(ref: ContextReference): string {
  return JSON.stringify(ref);
}

// Parse from a JSON string. Returns null on any structural or validation
// failure.
export function referenceFromJson(json: string): ContextReference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = validateContextReference(parsed);
  return result.valid ? (parsed as ContextReference) : null;
}

// --- display ----------------------------------------------------------------

// A compact, color-independent display string for a reference. The format is:
//
//   ▸ path:10-25 (symbol) [provenance]
//
// Suitable for both TUI and Desktop rendering.
export function formatContextReference(ref: ContextReference): string {
  let out = `▸ ${ref.path}`;
  if (ref.lines) {
    out += ref.lines.start === ref.lines.end
      ? `:${ref.lines.start}`
      : `:${ref.lines.start}-${ref.lines.end}`;
  }
  if (ref.symbol) {
    out += ` (${ref.symbol})`;
  }
  out += ` [${ref.provenance}]`;
  return out;
}

// Whether two references point to the same location (path + lines + symbol).
// Provenance is intentionally excluded: two references to the same location
// from different navigation paths are equal for deduplication.
export function referencesEqual(a: ContextReference, b: ContextReference): boolean {
  if (a.path !== b.path) return false;
  if ((a.symbol ?? "") !== (b.symbol ?? "")) return false;
  const aStart = a.lines?.start ?? 0;
  const aEnd = a.lines?.end ?? 0;
  const bStart = b.lines?.start ?? 0;
  const bEnd = b.lines?.end ?? 0;
  return aStart === bStart && aEnd === bEnd;
}

// Deduplicate a list of references, preserving first-occurrence order.
export function dedupeContextReferences(refs: ContextReference[]): ContextReference[] {
  const seen = new Set<string>();
  const out: ContextReference[] = [];
  for (const ref of refs) {
    const key = `${ref.path}\0${ref.lines?.start ?? 0}\0${ref.lines?.end ?? 0}\0${ref.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
