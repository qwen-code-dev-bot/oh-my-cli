// Context composer: assembles canonical references into a bounded context
// with an estimated token budget, provenance, exclusions, and trust flags.
//
// Before sending context to the agent, users need to see what will be
// included — estimated token budget, where each item came from (provenance),
// what is excluded and why, and whether each item is trusted. This module
// takes canonical references (from context-reference.ts), resolves their
// content through the navigator's policy enforcement (workspace-navigator.ts),
// estimates token cost, and assembles a bounded context that fits within a
// declared budget. Exclusions are explicit with reasons, never silent.
//
// The composed context is surface-independent: the same references produce
// the same composed output for both the TUI and Desktop.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import { IgnoreSet } from "./discovery.js";
import type { ContextReference, ReferenceProvenance } from "./context-reference.js";
import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
} from "./context-reference.js";

export const CONTEXT_COMPOSER_SCHEMA = "oh-my-cli.context-composer";
export const CONTEXT_COMPOSER_VERSION = 1;

// --- token estimation -------------------------------------------------------

// Rough token estimate: ~4 characters per token for English source code.
// This is intentionally conservative and deterministic — the goal is a
// bounded preview estimate, not an exact tokenizer match.
const CHARS_PER_TOKEN = 4;

// Default token budget when none is specified. Large enough for a meaningful
// context window, small enough to avoid flooding.
const DEFAULT_TOKEN_BUDGET = 8_000;

// Maximum bytes read per file for token estimation and content preview.
const MAX_READ_BYTES = 512 * 1_024; // 512 KiB

// Maximum lines included per item in the composed output.
const MAX_LINES_PER_ITEM = 200;

// Estimate the token count for a string of content.
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

// --- exclusion reasons ------------------------------------------------------

// Why an item was excluded from the composed context. Each variant names the
// reason explicitly so the user can see what was dropped and why.
export type ExclusionReason =
  | "ignored"
  | "binary"
  | "oversized"
  | "untrusted"
  | "secret"
  | "over-budget"
  | "unreadable"
  | "outside-workspace";

// A single excluded reference with its reason.
export interface ContextExclusion {
  /** Workspace-relative path of the excluded reference. */
  path: string;
  reason: ExclusionReason;
  /** Human-readable detail (e.g. file size, policy message). */
  detail: string;
}

// --- composed items ---------------------------------------------------------

// A single item in the composed context: the reference, its resolved content,
// estimated token cost, provenance, and trust status.
export interface ComposedItem {
  ref: ContextReference;
  /** Estimated token cost of this item's content. */
  estimatedTokens: number;
  /** Provenance carried from the reference. */
  provenance: ReferenceProvenance;
  /** Whether this item comes from a trusted source. */
  trusted: boolean;
  /** Resolved content lines (bounded). */
  lines: string[];
  /** 1-based number of the first line included. */
  startLine: number;
  /** Total lines in the source file. */
  totalLines: number;
  /** Whether the content was truncated to fit MAX_LINES_PER_ITEM. */
  truncated: boolean;
}

// The composed context: a bounded, budget-tracked assembly of canonical
// references with provenance, exclusions, and trust flags.
export interface ComposedContext {
  schema: typeof CONTEXT_COMPOSER_SCHEMA;
  v: typeof CONTEXT_COMPOSER_VERSION;
  /** Declared token budget. */
  budget: number;
  /** Estimated tokens used by included items. */
  usedTokens: number;
  /** Remaining token budget. */
  remainingTokens: number;
  /** Included items, in insertion order. */
  items: ComposedItem[];
  /** Excluded references with reasons. */
  exclusions: ContextExclusion[];
  /** True when any included item is not trusted. */
  hasUntrusted: boolean;
  /** True when items were dropped due to budget overflow. */
  budgetExceeded: boolean;
}

// --- policy checks (pure, mirrors workspace-navigator) ----------------------

// File extensions treated as binary.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff", ".heic", ".avif",
  ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".bin", ".class", ".jar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".wav", ".flac", ".ogg", ".webm", ".m4a", ".aac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".wasm",
]);

// Basename shapes that denote likely-secret material.
const SECRET_BASENAME_RE = new RegExp(
  "^(?:" +
    [
      "\\.env(?:\\..+)?",
      "\\.netrc",
      "\\.pgpass",
      "\\.htpasswd",
      "id_(?:rsa|dsa|ecdsa|ed25519)",
      ".+_rsa",
      ".+_ed25519",
      ".+\\.pem",
      ".+\\.pfx",
      ".+\\.p12",
      ".+\\.p8",
      ".+\\.ppk",
      ".+\\.key",
      ".+\\.keystore",
      ".+\\.jks",
      ".+\\.tfstate(?:\\.json)?",
      "credentials(?:\\.json)?",
      "(?:.*[_-])?secrets?(?:[_-].*)?\\.(?:json|ya?ml|txt|env|toml)",
      "(?:.*[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token)(?:[_-].*)?\\.(?:json|ya?ml|txt|env|toml)",
    ].join("|") +
  ")$",
  "i",
);

const SNIFF_BYTES = 8_000;

function hasBinaryExtension(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function looksLikeSecretPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return SECRET_BASENAME_RE.test(base);
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- composer options -------------------------------------------------------

export interface ComposerOptions {
  /** Token budget. Defaults to DEFAULT_TOKEN_BUDGET. */
  budget?: number;
  /** Whether the workspace is trusted. Defaults to true. */
  trusted?: boolean;
  /** Apply .gitignore + built-in skip rules. Defaults to true. */
  ignore?: boolean;
  /** Maximum file size (bytes) eligible for inclusion. */
  maxFileBytes?: number;
}

// --- composition ------------------------------------------------------------

// Compose a bounded context from canonical references. Each reference is
// resolved, policy-checked, token-estimated, and either included (within
// budget) or excluded with an explicit reason. The result is deterministic
// and surface-independent.
export function composeContext(
  workspace: Workspace,
  refs: ContextReference[],
  opts: ComposerOptions = {},
): ComposedContext {
  const budget = opts.budget ?? DEFAULT_TOKEN_BUDGET;
  const trusted = opts.trusted ?? true;
  const ignore = opts.ignore ?? true;
  const maxFileBytes = opts.maxFileBytes ?? MAX_READ_BYTES;

  const ignoreSet = ignore ? IgnoreSet.load(workspace) : new IgnoreSet();
  const items: ComposedItem[] = [];
  const exclusions: ContextExclusion[] = [];
  let usedTokens = 0;
  let budgetExceeded = false;

  for (const ref of refs) {
    // Path safety.
    if (ref.path.startsWith("/") || ref.path.split("/").includes("..")) {
      exclusions.push({
        path: ref.path,
        reason: "outside-workspace",
        detail: "Path is absolute or contains ..",
      });
      continue;
    }

    // Trust gate.
    if (!trusted) {
      exclusions.push({
        path: ref.path,
        reason: "untrusted",
        detail: "Workspace is untrusted",
      });
      continue;
    }

    // Ignore check.
    if (ignore && ignoreSet.isIgnored(ref.path, false)) {
      exclusions.push({
        path: ref.path,
        reason: "ignored",
        detail: "Path matches .gitignore or built-in skip rules",
      });
      continue;
    }

    // Binary check.
    if (hasBinaryExtension(ref.path)) {
      exclusions.push({
        path: ref.path,
        reason: "binary",
        detail: `Extension ${path.extname(ref.path)} is binary`,
      });
      continue;
    }

    // Secret check.
    if (looksLikeSecretPath(ref.path)) {
      exclusions.push({
        path: ref.path,
        reason: "secret",
        detail: "Basename matches a secret-bearing pattern",
      });
      continue;
    }

    // Resolve and read.
    let abs: string;
    try {
      abs = workspace.resolve(ref.path);
    } catch {
      exclusions.push({
        path: ref.path,
        reason: "outside-workspace",
        detail: "Path escapes the workspace",
      });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      exclusions.push({
        path: ref.path,
        reason: "unreadable",
        detail: "File does not exist or is not readable",
      });
      continue;
    }

    if (stat.size > maxFileBytes) {
      exclusions.push({
        path: ref.path,
        reason: "oversized",
        detail: `File is ${stat.size} bytes (limit ${maxFileBytes})`,
      });
      continue;
    }

    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      exclusions.push({
        path: ref.path,
        reason: "unreadable",
        detail: "Read failed",
      });
      continue;
    }

    if (looksBinary(buf)) {
      exclusions.push({
        path: ref.path,
        reason: "binary",
        detail: "Content contains NUL bytes",
      });
      continue;
    }

    const content = buf.toString("utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;

    // Determine line range.
    let start: number;
    let end: number;
    if (ref.lines) {
      start = Math.max(1, ref.lines.start);
      end = Math.min(totalLines, ref.lines.end);
    } else {
      start = 1;
      end = totalLines;
    }

    // Bound to MAX_LINES_PER_ITEM.
    const truncated = end - start + 1 > MAX_LINES_PER_ITEM;
    if (truncated) {
      end = start + MAX_LINES_PER_ITEM - 1;
    }

    const lines = allLines.slice(start - 1, end);
    const itemContent = lines.join("\n");
    const itemTokens = estimateTokens(itemContent);

    // Budget check.
    if (usedTokens + itemTokens > budget) {
      budgetExceeded = true;
      exclusions.push({
        path: ref.path,
        reason: "over-budget",
        detail: `Item needs ~${itemTokens} tokens but only ${budget - usedTokens} remain`,
      });
      continue;
    }

    usedTokens += itemTokens;
    items.push({
      ref,
      estimatedTokens: itemTokens,
      provenance: ref.provenance,
      trusted: true,
      lines,
      startLine: start,
      totalLines,
      truncated,
    });
  }

  return {
    schema: CONTEXT_COMPOSER_SCHEMA,
    v: CONTEXT_COMPOSER_VERSION,
    budget,
    usedTokens,
    remainingTokens: budget - usedTokens,
    items,
    exclusions,
    hasUntrusted: items.some((i) => !i.trusted),
    budgetExceeded,
  };
}

// --- formatting -------------------------------------------------------------

// Format a composed context as a compact, color-independent summary suitable
// for both TUI and Desktop rendering. Shows budget usage, item count,
// provenance breakdown, and exclusion reasons.
export function formatComposedContext(ctx: ComposedContext): string {
  const lines: string[] = [];
  lines.push("Context Composition");
  lines.push("─".repeat(40));
  lines.push(`Budget:     ${ctx.usedTokens} / ${ctx.budget} tokens (${ctx.remainingTokens} remaining)`);
  lines.push(`Items:      ${ctx.items.length} included, ${ctx.exclusions.length} excluded`);

  if (ctx.items.length > 0) {
    lines.push("");
    lines.push("Included:");
    for (const item of ctx.items) {
      const range = item.ref.lines
        ? `:${item.ref.lines.start}-${item.ref.lines.end}`
        : "";
      const trust = item.trusted ? "" : " [UNTRUSTED]";
      lines.push(`  ▸ ${item.ref.path}${range} [${item.provenance}] ~${item.estimatedTokens}tok${trust}`);
    }
  }

  if (ctx.exclusions.length > 0) {
    lines.push("");
    lines.push("Excluded:");
    for (const ex of ctx.exclusions) {
      lines.push(`  ✗ ${ex.path} — ${ex.reason}: ${ex.detail}`);
    }
  }

  if (ctx.budgetExceeded) {
    lines.push("");
    lines.push("⚠ Budget exceeded: some items were dropped.");
  }

  return lines.join("\n");
}

// Whether two composed contexts are structurally equal (same items, same
// exclusions, same budget). Used for surface-independence verification.
export function composedContextsEqual(a: ComposedContext, b: ComposedContext): boolean {
  if (a.budget !== b.budget) return false;
  if (a.usedTokens !== b.usedTokens) return false;
  if (a.items.length !== b.items.length) return false;
  if (a.exclusions.length !== b.exclusions.length) return false;
  for (let i = 0; i < a.items.length; i++) {
    if (a.items[i].ref.path !== b.items[i].ref.path) return false;
    if (a.items[i].estimatedTokens !== b.items[i].estimatedTokens) return false;
    if (a.items[i].provenance !== b.items[i].provenance) return false;
  }
  for (let i = 0; i < a.exclusions.length; i++) {
    if (a.exclusions[i].path !== b.exclusions[i].path) return false;
    if (a.exclusions[i].reason !== b.exclusions[i].reason) return false;
  }
  return true;
}
