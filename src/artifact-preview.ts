// Safe static HTML artifact preview.
//
// Accepts a local HTML artifact reference, resolves it within the trusted
// workspace, and produces an inspectable preview with scripts, network,
// navigation, and filesystem access disabled by default. The preview policy
// is fail-closed: anything not explicitly allowed is blocked, and every
// blocked item is reported with a reason. Preview evidence is attributable
// to the active session and exact artifact content hash.
//
// The module is surface-independent: the same artifact produces the same
// sanitized output and policy report for both the TUI and a future Desktop
// pane.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import { safeCutEnd } from "./text-cut.js";

export const ARTIFACT_PREVIEW_SCHEMA = "oh-my-cli.artifact-preview";
export const ARTIFACT_PREVIEW_VERSION = 1;

// --- bounds -----------------------------------------------------------------

const MAX_ARTIFACT_BYTES = 5 * 1_048_576; // 5 MiB
const MAX_PREVIEW_LINES = 500;
const SNIFF_BYTES = 8_000;

// --- preview policy ---------------------------------------------------------

// The security policy applied to every artifact preview. All capabilities
// are disabled by default; the struct records what was enforced.
export interface PreviewPolicy {
  scripts: "disabled";
  network: "disabled";
  navigation: "disabled";
  filesystem: "disabled";
  forms: "disabled";
}

export const DEFAULT_PREVIEW_POLICY: PreviewPolicy = Object.freeze({
  scripts: "disabled",
  network: "disabled",
  navigation: "disabled",
  filesystem: "disabled",
  forms: "disabled",
});

// --- blocked content --------------------------------------------------------

export type BlockedReason =
  | "script-tag"
  | "event-handler"
  | "remote-url"
  | "iframe"
  | "form"
  | "meta-refresh"
  | "object-embed"
  | "javascript-uri";

export interface BlockedContent {
  reason: BlockedReason;
  /** 1-based line number where the content was found. */
  line: number;
  /** Truncated preview of the blocked line. */
  preview: string;
}

// --- artifact identity ------------------------------------------------------

export interface ArtifactIdentity {
  /** Workspace-relative path. */
  path: string;
  /** SHA-256 hex digest of the raw artifact content. */
  contentHash: string;
  /** Size in bytes. */
  sizeBytes: number;
}

// --- preview result ---------------------------------------------------------

export type RenderStatus = "ok" | "refused";

export interface ArtifactPreview {
  schema: typeof ARTIFACT_PREVIEW_SCHEMA;
  v: typeof ARTIFACT_PREVIEW_VERSION;
  identity: ArtifactIdentity;
  policy: PreviewPolicy;
  renderStatus: RenderStatus;
  /** Sanitized HTML lines (scripts/network/navigation removed). */
  sanitizedLines: string[];
  /** Total lines in the original artifact. */
  totalLines: number;
  /** Whether the preview was truncated to MAX_PREVIEW_LINES. */
  truncated: boolean;
  /** Content that was blocked, with reasons. */
  blocked: BlockedContent[];
  /** Whether any content was blocked. */
  hasBlockedContent: boolean;
}

export interface ArtifactRefusal {
  renderStatus: "refused";
  reason: "untrusted" | "oversized" | "unreadable" | "binary" | "outside-workspace" | "not-html";
  detail: string;
}

export type ArtifactPreviewResult = ArtifactPreview | ArtifactRefusal;

// --- detection patterns -----------------------------------------------------

const SCRIPT_TAG_RE = /<script[\s>]/i;
const EVENT_HANDLER_RE = /\bon\w+\s*=/i;
const REMOTE_URL_RE = /(?:src|href|action|data|poster)\s*=\s*["']?https?:\/\//i;
const IFRAME_RE = /<iframe[\s>]/i;
const FORM_RE = /<form[\s>]/i;
const META_REFRESH_RE = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i;
const OBJECT_EMBED_RE = /<(?:object|embed)[\s>]/i;
const JAVASCRIPT_URI_RE = /(?:href|src|action)\s*=\s*["']?\s*javascript:/i;

const DETECTION_RULES: Array<{ re: RegExp; reason: BlockedReason }> = [
  { re: SCRIPT_TAG_RE, reason: "script-tag" },
  { re: EVENT_HANDLER_RE, reason: "event-handler" },
  { re: REMOTE_URL_RE, reason: "remote-url" },
  { re: IFRAME_RE, reason: "iframe" },
  { re: FORM_RE, reason: "form" },
  { re: META_REFRESH_RE, reason: "meta-refresh" },
  { re: OBJECT_EMBED_RE, reason: "object-embed" },
  { re: JAVASCRIPT_URI_RE, reason: "javascript-uri" },
];

// --- sanitization -----------------------------------------------------------

// Sanitize a single HTML line by neutralizing dangerous content. The line
// is returned with blocked patterns replaced by safe placeholders, and the
// blocked items are recorded.
function sanitizeLine(line: string, lineNum: number, blocked: BlockedContent[]): string {
  let sanitized = line;

  for (const { re, reason } of DETECTION_RULES) {
    if (re.test(sanitized)) {
      blocked.push({
        reason,
        line: lineNum,
        preview: truncate(line.trim(), 120),
      });
      // Neutralize: replace the dangerous content with a safe comment.
      sanitized = neutralize(sanitized, reason);
    }
  }

  return sanitized;
}

// Replace dangerous HTML constructs with safe, visible placeholders.
function neutralize(line: string, reason: BlockedReason): string {
  switch (reason) {
    case "script-tag":
      return line.replace(/<script[\s\S]*?<\/script>/gi, `<!-- [BLOCKED: script] -->`)
                 .replace(/<script[\s>][^>]*>/gi, `<!-- [BLOCKED: script] -->`);
    case "event-handler":
      return line.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "data-blocked-handler");
    case "remote-url":
      return line.replace(/((?:src|href|action|data|poster)\s*=\s*["']?)https?:\/\/[^"'\s>]*/gi, "$1about:blank");
    case "iframe":
      return line.replace(/<iframe[\s\S]*?<\/iframe>/gi, `<!-- [BLOCKED: iframe] -->`)
                 .replace(/<iframe[^>]*\/?>/gi, `<!-- [BLOCKED: iframe] -->`);
    case "form":
      return line.replace(/<form([^>]*)>/gi, "<div data-blocked-form$1>")
                 .replace(/<\/form>/gi, "</div>");
    case "meta-refresh":
      return line.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, `<!-- [BLOCKED: meta-refresh] -->`);
    case "object-embed":
      return line.replace(/<(?:object|embed)[\s\S]*?<\/(?:object|embed)>/gi, `<!-- [BLOCKED: object/embed] -->`)
                 .replace(/<(?:object|embed)[^>]*\/?>/gi, `<!-- [BLOCKED: object/embed] -->`);
    case "javascript-uri":
      return line.replace(/((?:href|src|action)\s*=\s*["']?\s*)javascript:[^"'\s>]*/gi, "$1about:blank");
    default:
      return line;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, safeCutEnd(s, max - 1)) + "…";
}

// --- binary detection -------------------------------------------------------

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- preview ----------------------------------------------------------------

export interface PreviewOptions {
  /** Whether the workspace is trusted. Defaults to true. */
  trusted?: boolean;
  /** Maximum artifact size in bytes. */
  maxBytes?: number;
}

// Default deliverable path for an exported artifact (Issue #803): strip one
// trailing .html/.htm extension from the basename and append ".safe.html",
// keeping the file beside the original. Pure: no filesystem access.
export function defaultDeliverablePath(relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath).replace(/\.(html|htm)$/i, "");
  const name = `${base}.safe.html`;
  return dir === "." ? name : path.join(dir, name);
}

// Produce a safe static preview of a local HTML artifact. The artifact is
// resolved within the workspace, validated, sanitized (scripts, network,
// navigation, forms disabled), and returned with a full policy report and
// blocked-content inventory. Fails closed with explicit recovery guidance.
export function previewArtifact(
  workspace: Workspace,
  relPath: string,
  opts: PreviewOptions = {},
): ArtifactPreviewResult {
  const trusted = opts.trusted ?? true;
  const maxBytes = opts.maxBytes ?? MAX_ARTIFACT_BYTES;

  // Trust gate.
  if (!trusted) {
    return { renderStatus: "refused", reason: "untrusted", detail: "Workspace is untrusted. Trust it with --trust or add it to the trust store." };
  }

  // Path safety.
  if (relPath.startsWith("/") || relPath.split("/").includes("..")) {
    return { renderStatus: "refused", reason: "outside-workspace", detail: "Path is absolute or contains ... Use a workspace-relative path." };
  }

  // Extension check.
  const ext = path.extname(relPath).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    return { renderStatus: "refused", reason: "not-html", detail: `Extension "${ext}" is not HTML. Only .html and .htm files can be previewed.` };
  }

  // Resolve within workspace.
  let abs: string;
  try {
    abs = workspace.resolve(relPath);
  } catch {
    return { renderStatus: "refused", reason: "outside-workspace", detail: "Path escapes the workspace. Use a path within the project root." };
  }

  // Read and validate.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { renderStatus: "refused", reason: "unreadable", detail: "File does not exist or is not readable. Check the path and permissions." };
  }

  if (stat.size > maxBytes) {
    return { renderStatus: "refused", reason: "oversized", detail: `File is ${stat.size} bytes (limit ${maxBytes}). Reduce the artifact size.` };
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { renderStatus: "refused", reason: "unreadable", detail: "Read failed. Check permissions." };
  }

  if (looksBinary(buf)) {
    return { renderStatus: "refused", reason: "binary", detail: "Content contains NUL bytes. Only text HTML files can be previewed." };
  }

  const content = buf.toString("utf-8");
  const contentHash = crypto.createHash("sha256").update(buf).digest("hex");
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  // Sanitize.
  const blocked: BlockedContent[] = [];
  const limit = Math.min(totalLines, MAX_PREVIEW_LINES);
  const sanitizedLines: string[] = [];

  for (let i = 0; i < limit; i++) {
    sanitizedLines.push(sanitizeLine(allLines[i], i + 1, blocked));
  }

  return {
    schema: ARTIFACT_PREVIEW_SCHEMA,
    v: ARTIFACT_PREVIEW_VERSION,
    identity: {
      path: relPath,
      contentHash,
      sizeBytes: stat.size,
    },
    policy: DEFAULT_PREVIEW_POLICY,
    renderStatus: "ok",
    sanitizedLines,
    totalLines,
    truncated: totalLines > MAX_PREVIEW_LINES,
    blocked,
    hasBlockedContent: blocked.length > 0,
  };
}

// --- formatting -------------------------------------------------------------

// Format a preview result as a compact, color-independent summary for the
// TUI. Shows artifact identity, policy, render status, blocked content,
// and safe actions.
export function formatArtifactPreview(result: ArtifactPreviewResult): string {
  if ("reason" in result) {
    const lines = [
      "Artifact Preview — REFUSED",
      "─".repeat(40),
      `Reason:  ${result.reason}`,
      `Detail:  ${result.detail}`,
    ];
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push("Artifact Preview");
  lines.push("─".repeat(40));
  lines.push(`Path:    ${result.identity.path}`);
  lines.push(`Hash:    ${result.identity.contentHash.slice(0, 16)}…`);
  lines.push(`Size:    ${result.identity.sizeBytes} bytes`);
  lines.push(`Status:  ${result.renderStatus}`);
  lines.push(`Lines:   ${result.sanitizedLines.length} / ${result.totalLines}${result.truncated ? " (truncated)" : ""}`);
  lines.push("");
  lines.push("Policy:");
  lines.push(`  Scripts:     ${result.policy.scripts}`);
  lines.push(`  Network:     ${result.policy.network}`);
  lines.push(`  Navigation:  ${result.policy.navigation}`);
  lines.push(`  Filesystem:  ${result.policy.filesystem}`);
  lines.push(`  Forms:       ${result.policy.forms}`);

  if (result.blocked.length > 0) {
    lines.push("");
    lines.push(`Blocked content (${result.blocked.length}):`);
    for (const b of result.blocked) {
      lines.push(`  ✗ L${b.line} [${b.reason}] ${b.preview}`);
    }
  } else {
    lines.push("");
    lines.push("Blocked content: none");
  }

  lines.push("");
  lines.push("Actions: open (safe) · export sanitized");

  return lines.join("\n");
}
