// Prior-session reference engine for the composer (#248).
//
// Lets a user cite one prior LOCAL session as bounded, redacted context while
// keeping the current session active — without resuming, merging, forking, or
// otherwise mutating the referenced session. A distinct `session:` namespace
// inside the composer `@` reference cannot collide with workspace path
// references (#196). Candidates reuse the same stable, redacted session fields
// as the session browser (#197). Resolution is fail-closed: the current session,
// corrupt or missing checkpoints, and incompatible cross-workspace sessions are
// refused with actionable, non-destructive reasons and never imply a provider
// call. The attached context is a bounded, redacted summary carrying provenance
// and explicit truncation metadata — never the full transcript, raw tool output,
// image bytes, approval decisions, or secrets.
//
// Everything here is pure and read-only: it reads session checkpoints through
// the SessionStore and never writes them, so the source transcripts stay
// byte-identical and rendering/redaction are unit-testable without a TTY.

import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import type { SessionSummary } from "./session-summary.js";
import { shortSessionId } from "./session-picker.js";
import type { SessionStore } from "./session.js";

export const SESSION_REFERENCE_SCHEMA = "oh-my-cli.session-reference";
export const SESSION_REFERENCE_VERSION = 1;

// The namespace prefix inside an `@` reference that selects a prior-session
// reference rather than a workspace path reference. A reference query of
// `session:<id-or-search>` cannot collide with a workspace path because path
// references never begin with `session:`.
export const SESSION_REFERENCE_PREFIX = "session:";

// Bounds keeping the reference bounded and composer-friendly.
const MAX_CANDIDATES = 50;
const MAX_EXCERPT_CHARS = 1200;
const MAX_TITLE_LENGTH = 60;
const PREVIEW_MAX_LEN = 200;

// --- namespace parsing ------------------------------------------------------

// Whether an `@` reference query targets the prior-session namespace.
export function isSessionReferenceQuery(query: string): boolean {
  return query.startsWith(SESSION_REFERENCE_PREFIX);
}

// The session id/search term after the `session:` prefix, or null when the query
// is not a session reference.
export function parseSessionReferenceQuery(query: string): string | null {
  if (!isSessionReferenceQuery(query)) return null;
  return query.slice(SESSION_REFERENCE_PREFIX.length);
}

// The composer token inserted for a chosen session reference (the part after the
// leading `@`). Uses the full id so resolution is exact and unambiguous.
export function sessionReferenceToken(sessionId: string): string {
  return `${SESSION_REFERENCE_PREFIX}${sessionId}`;
}

// --- helpers ----------------------------------------------------------------

function redactWorkspace(p: string | undefined): string {
  if (!p) return "unknown";
  return redactSecrets(redactHomePath(p)).text;
}

function redactModel(value: string | undefined): string {
  if (!value) return "unknown";
  return redactSecrets(value).text;
}

// A redacted, single-line, bounded title: the session goal objective when
// present, else a neutral "Session <shortId>" label. Never transcript text.
function sessionTitle(store: SessionStore, id: string): string {
  const shortId = shortSessionId(id);
  const goal = store.readGoal(id).goal?.objective;
  if (goal && goal.trim()) {
    const oneLine = redactSecrets(goal).text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= MAX_TITLE_LENGTH) return oneLine;
    return oneLine.slice(0, safeCutEnd(oneLine, MAX_TITLE_LENGTH - 1)).trimEnd() + "…";
  }
  return `Session ${shortId}`;
}

// --- candidates -------------------------------------------------------------

// A prior-session reference candidate: the same stable, redacted fields the
// session browser shows, restricted to eligible sessions, plus a context-size
// estimate for the preview.
export interface SessionReferenceCandidate {
  id: string;
  shortId: string;
  title: string; // redacted
  workspace: string; // redacted
  model: string; // redacted
  ageLabel: string;
  lastModified: number;
  approxTokens: number;
}

export interface SessionReferenceCollectOptions {
  /** The active session id; excluded from candidates (cannot reference itself). */
  currentSessionId?: string;
  /** The active workspace root; sessions from a different workspace are excluded. */
  currentWorkspace?: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  limit?: number;
}

// Enumerate eligible prior sessions as bounded, redacted candidates. Excludes
// the current session, corrupt checkpoints, and (when a current workspace is
// given) sessions belonging to a different workspace. Most recently active
// first, with the id as a stable tiebreaker.
export function collectSessionReferenceCandidates(
  store: SessionStore,
  opts: SessionReferenceCollectOptions = {},
): SessionReferenceCandidate[] {
  const now = opts.now ?? (() => Date.now());
  const summaries = collectSessionSummaries(store, { now });
  const candidates: SessionReferenceCandidate[] = [];
  for (const s of summaries) {
    if (s.corrupt) continue;
    if (opts.currentSessionId && s.id === opts.currentSessionId) continue;
    if (opts.currentWorkspace && s.workspace && s.workspace !== opts.currentWorkspace) continue;
    candidates.push({
      id: s.id,
      shortId: shortSessionId(s.id),
      title: sessionTitle(store, s.id),
      workspace: redactWorkspace(s.workspace),
      model: redactModel(s.model),
      ageLabel: formatSessionAge(s.ageMs),
      lastModified: s.lastModified,
      approxTokens: s.approxTokens,
    });
  }
  candidates.sort((a, b) => b.lastModified - a.lastModified || a.id.localeCompare(b.id));
  return candidates.slice(0, Math.max(0, opts.limit ?? MAX_CANDIDATES));
}

// Case-insensitive substring match across the visible candidate fields. Order is
// preserved so filtering stays deterministic.
export function filterSessionReferenceCandidates(
  candidates: SessionReferenceCandidate[],
  query: string,
): SessionReferenceCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter((c) =>
    [c.shortId, c.id, c.title, c.workspace, c.model].join(" ").toLowerCase().includes(q),
  );
}

// --- resolution + bounded summary -------------------------------------------

// A bounded, redacted summary of a referenced prior session, carrying
// provenance and explicit truncation metadata. This — never the full transcript
// — is what attaches to the provider context.
export interface SessionReferenceSummary {
  schema: typeof SESSION_REFERENCE_SCHEMA;
  v: typeof SESSION_REFERENCE_VERSION;
  sessionId: string;
  shortId: string;
  title: string; // redacted
  workspace: string; // redacted
  model: string; // redacted
  ageLabel: string;
  messageCount: number;
  /** Rough context-size estimate (labelled as an estimate). */
  approxTokens: number;
  /** Bounded, redacted excerpt of user/assistant text only (no tool output). */
  excerpt: string;
  /** True when the excerpt was bounded (more content existed than retained). */
  truncated: boolean;
}

export type SessionReferenceResolution =
  | { ok: true; summary: SessionReferenceSummary }
  | { ok: false; reason: string };

export interface ResolveSessionReferenceOptions {
  /** The active session id; referencing it fails closed. */
  currentSessionId?: string;
  /** The active workspace root; a different-workspace session fails closed. */
  currentWorkspace?: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

// Build the bounded, redacted excerpt: user/assistant text only (tool calls and
// tool results are never included, so raw tool output cannot leak), each entry
// secret-redacted, joined and bounded to MAX_EXCERPT_CHARS with a truncation
// flag when more content existed.
function buildExcerpt(store: SessionStore, id: string): { excerpt: string; truncated: boolean } {
  const diag = store.loadWithDiagnostics(id);
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const m of diag.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    const redacted = redactSecrets(m.content).text.trim();
    if (used + redacted.length + 1 > MAX_EXCERPT_CHARS) {
      truncated = true;
      const remaining = MAX_EXCERPT_CHARS - used;
      if (remaining > 0) parts.push(redacted.slice(0, remaining));
      break;
    }
    parts.push(redacted);
    used += redacted.length + 1; // +1 for the joining newline
  }
  return { excerpt: parts.join("\n"), truncated };
}

function buildSummary(
  store: SessionStore,
  s: SessionSummary,
): SessionReferenceSummary {
  const { excerpt, truncated } = buildExcerpt(store, s.id);
  return {
    schema: SESSION_REFERENCE_SCHEMA,
    v: SESSION_REFERENCE_VERSION,
    sessionId: s.id,
    shortId: shortSessionId(s.id),
    title: sessionTitle(store, s.id),
    workspace: redactWorkspace(s.workspace),
    model: redactModel(s.model),
    ageLabel: formatSessionAge(s.ageMs),
    messageCount: s.messageCount,
    approxTokens: s.approxTokens,
    excerpt,
    truncated,
  };
}

// Resolve an exact prior-session reference, fail-closed. The reference matches a
// full session id, or a short-id / id-prefix that identifies exactly one session;
// an ambiguous or unknown reference is refused (no fuzzy fallback to a different
// session). The current session, corrupt checkpoints, and different-workspace
// sessions are refused with actionable reasons. On success returns a bounded,
// redacted summary. Read-only: the source session is never mutated.
export function resolveSessionReference(
  store: SessionStore,
  reference: string,
  opts: ResolveSessionReferenceOptions = {},
): SessionReferenceResolution {
  const target = reference.trim();
  if (!target) {
    return { ok: false, reason: "no session reference was provided" };
  }
  const now = opts.now ?? (() => Date.now());
  const summaries = collectSessionSummaries(store, { now });

  let match = summaries.find((s) => s.id === target);
  if (!match) {
    const lower = target.toLowerCase();
    const prefixMatches = summaries.filter(
      (s) => shortSessionId(s.id).toLowerCase() === lower || s.id.toLowerCase().startsWith(lower),
    );
    if (prefixMatches.length === 1) {
      match = prefixMatches[0];
    } else if (prefixMatches.length > 1) {
      return {
        ok: false,
        reason: `session reference "${target}" is ambiguous; use the full session id`,
      };
    }
  }
  if (!match) {
    return { ok: false, reason: `session ${shortSessionId(target)} was not found` };
  }
  if (match.corrupt) {
    return {
      ok: false,
      reason: `session ${shortSessionId(match.id)} is corrupt and cannot be referenced safely`,
    };
  }
  if (opts.currentSessionId && match.id === opts.currentSessionId) {
    return { ok: false, reason: "cannot reference the current session" };
  }
  if (opts.currentWorkspace && match.workspace && match.workspace !== opts.currentWorkspace) {
    return {
      ok: false,
      reason:
        `session ${shortSessionId(match.id)} belongs to a different workspace ` +
        `(${redactWorkspace(match.workspace)}); cross-workspace references are not allowed`,
    };
  }
  return { ok: true, summary: buildSummary(store, match) };
}

// --- formatting -------------------------------------------------------------

// Render the bounded, redacted context block attached to the provider when a
// session reference is submitted. Carries provenance (id/title/workspace/model/
// age), a context-size estimate, and the bounded excerpt with explicit
// truncation metadata. Deterministic for a fixed session.
export function formatSessionReferenceContext(summary: SessionReferenceSummary): string {
  return [
    `[Prior session reference ${summary.shortId}]`,
    `Title: ${summary.title}`,
    `Provenance: workspace ${summary.workspace} · model ${summary.model} · last active ${summary.ageLabel}`,
    `Context size: ${summary.messageCount} messages, ~${summary.approxTokens} tokens (est.)`,
    `Excerpt (redacted${summary.truncated ? ", truncated" : ""}):`,
    summary.excerpt || "(no text content)",
    `[End prior session reference ${summary.shortId}]`,
  ].join("\n");
}

// A compact, color-independent preview of one candidate for the composer picker:
// a session glyph + label, the short id, title, workspace, context-size estimate,
// and age, clipped to width. The glyph + label keep it identifiable without color.
export function formatSessionReferencePreview(
  candidate: SessionReferenceCandidate,
  width: number = PREVIEW_MAX_LEN,
): string {
  const line =
    `◷ session  ${candidate.shortId}  ${candidate.title}  ·  ` +
    `${candidate.workspace}  ·  ~${candidate.approxTokens} tok  ·  ${candidate.ageLabel}`;
  if (Array.from(line).length <= width) return line;
  return Array.from(line).slice(0, Math.max(0, width - 1)).join("") + "…";
}
