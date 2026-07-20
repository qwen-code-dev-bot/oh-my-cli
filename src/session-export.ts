// Portable, privacy-safe local export of a single session.
//
// Copying terminal output to share a session loses structure and can leak
// credentials or local paths. This module renders a session's canonical record
// into a readable Markdown transcript plus a machine-readable JSON manifest,
// written next to each other in a chosen directory.
//
// Guarantees:
//   - Privacy: secrets, auth tokens, sensitive env values, and the host home
//     directory are redacted from every free-form value before a single byte is
//     written. Redaction is applied to the rendered text, not after the fact.
//   - Determinism: identical session input yields byte-identical output. The
//     manifest sorts keys, tool/attachment lists are ordered by name, and no
//     export-time wall clock is recorded (timestamps come from the session
//     record and its file mtime, both stable for unchanged input).
//   - Integrity: the manifest carries a sha256 of the source session file so the
//     export references its origin by checksum. Attachments are referenced by
//     name/type/size, never embedded.
//   - Safety: writes are atomic (temp + rename, temps cleaned up on failure) and
//     existing files are never overwritten without an explicit force flag. The
//     export is purely local — it performs no network or external-state action.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";
import type { SessionStore, SessionMessage } from "./session.js";

export const SESSION_EXPORT_SCHEMA = "oh-my-cli.session-export" as const;
export const SESSION_EXPORT_VERSION = 1 as const;

// Free-form transcript values are redacted and bounded so a single oversized
// message (e.g. a tool call carrying a whole file) cannot bloat the export.
const MAX_CONTENT = 8000;
const MAX_ARGS = 2000;

export type SessionExportIntegrity = "ok" | "partial" | "corrupt";

export interface SessionExportToolStat {
  name: string;
  calls: number;
  results: number;
}

export interface SessionExportAttachmentRef {
  name: string;
  mediaType: string;
  bytes: number;
}

export interface SessionExportCounts {
  messages: number;
  user: number;
  assistant: number;
  system: number;
  tool: number;
  toolCalls: number;
  toolResults: number;
  attachments: number;
}

export interface SessionExportManifest {
  schema: typeof SESSION_EXPORT_SCHEMA;
  v: typeof SESSION_EXPORT_VERSION;
  sessionId: string;
  /** Redacted (home collapsed to ~); null when the session recorded none. */
  workspace: string | null;
  /** Redacted; null when the session recorded none. */
  model: string | null;
  /** Epoch ms from the session meta; null when absent. */
  createdAt: number | null;
  /** Epoch ms of the source session file (stable for unchanged input). */
  lastModified: number;
  integrity: SessionExportIntegrity;
  counts: SessionExportCounts;
  /** Per-tool call/result tallies, ordered by name. */
  tools: SessionExportToolStat[];
  /** Attachment references (never embedded), ordered by name. */
  attachments: SessionExportAttachmentRef[];
  /** sha256 of the raw source session file — the evidence reference. */
  digest: string;
}

export interface SessionExportOptions {
  outDir: string;
  /** Overwrite existing output files. Without this, a collision fails closed. */
  force?: boolean;
}

export interface SessionExportResult {
  markdownPath: string;
  manifestPath: string;
  manifest: SessionExportManifest;
}

/** Thrown when a session cannot be exported (missing, collision, write error). */
export class SessionExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExportError";
  }
}

// --- primitives --------------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Redact secrets, then collapse the host home directory wherever it appears so a
// configured private path never reaches the export. Applied to every free-form
// value before it is rendered or serialized.
function redact(text: string): string {
  const secretless = redactSecrets(text).text;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && home.length > 0) {
    return secretless.split(home).join("~");
  }
  return secretless;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …[+${text.length - max} chars truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deterministic JSON: object keys sorted recursively, arrays preserved in order.
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

// --- build -------------------------------------------------------------------

/**
 * Build the export manifest and the redacted message list for a session.
 * Returns an error string (not throwing) when the session is missing so the CLI
 * can map it to a meaningful exit status. Reading never mutates the session.
 */
export function buildSessionManifest(
  store: SessionStore,
  id: string,
): { manifest: SessionExportManifest; messages: SessionMessage[] } | { error: string } {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") {
    return { error: `no such session "${id}"` };
  }

  const fp = store.filePath(id);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(fp, "utf8");
    mtimeMs = fs.statSync(fp).mtimeMs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `cannot read session "${id}": ${msg}` };
  }

  const diag = store.loadWithDiagnostics(id);
  const messages = diag.messages;
  const meta = diag.meta;

  const counts: SessionExportCounts = {
    messages: messages.length,
    user: 0,
    assistant: 0,
    system: 0,
    tool: 0,
    toolCalls: 0,
    toolResults: 0,
    attachments: 0,
  };

  const toolByName = new Map<string, SessionExportToolStat>();
  const callNameById = new Map<string, string>();
  const attachments: SessionExportAttachmentRef[] = [];

  const bumpTool = (name: string): SessionExportToolStat => {
    let stat = toolByName.get(name);
    if (!stat) {
      stat = { name, calls: 0, results: 0 };
      toolByName.set(name, stat);
    }
    return stat;
  };

  for (const m of messages) {
    switch (m.role) {
      case "user": counts.user++; break;
      case "assistant": counts.assistant++; break;
      case "system": counts.system++; break;
      case "tool": counts.tool++; break;
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        counts.toolCalls++;
        const name = redact(tc.function?.name || "(unknown)");
        callNameById.set(tc.id, name);
        bumpTool(name).calls++;
      }
    }
    if (m.role === "tool" && m.tool_call_id) {
      counts.toolResults++;
      const name = callNameById.get(m.tool_call_id) ?? "(unknown)";
      bumpTool(name).results++;
    }
    if (m.images) {
      for (const img of m.images) {
        counts.attachments++;
        attachments.push({
          name: redact(img.name || "(unnamed)"),
          mediaType: redact(img.mediaType || "application/octet-stream"),
          bytes: Math.max(0, Math.trunc(img.bytes)),
        });
      }
    }
  }

  const tools = [...toolByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  attachments.sort((a, b) => a.name.localeCompare(b.name));

  const manifest: SessionExportManifest = {
    schema: SESSION_EXPORT_SCHEMA,
    v: SESSION_EXPORT_VERSION,
    sessionId: id,
    workspace: meta?.workspace ? redact(meta.workspace) : null,
    model: meta?.model ? redact(meta.model) : null,
    createdAt: typeof meta?.createdAt === "number" ? meta.createdAt : null,
    lastModified: Math.floor(mtimeMs),
    integrity: integrity.status as SessionExportIntegrity,
    counts,
    tools,
    attachments,
    digest: sha256(raw),
  };

  return { manifest, messages };
}

// --- render ------------------------------------------------------------------

/** Render the readable Markdown transcript. Redaction is applied here. */
export function renderSessionMarkdown(
  manifest: SessionExportManifest,
  messages: SessionMessage[],
): string {
  const c = manifest.counts;
  const lines: string[] = [];
  lines.push(`# Session export ${manifest.sessionId}`);
  lines.push("");
  lines.push(`- Schema: ${manifest.schema} v${manifest.v}`);
  lines.push(`- Workspace: ${manifest.workspace ?? "(unknown)"}`);
  lines.push(`- Model: ${manifest.model ?? "(unknown)"}`);
  lines.push(`- Created: ${manifest.createdAt ?? "(unknown)"}`);
  lines.push(`- Last modified: ${manifest.lastModified}`);
  lines.push(`- Integrity: ${manifest.integrity}`);
  lines.push(`- Source digest (sha256): ${manifest.digest}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `- Messages: ${c.messages} (user ${c.user}, assistant ${c.assistant}, system ${c.system}, tool ${c.tool})`,
  );
  lines.push(`- Tool calls: ${c.toolCalls}, tool results: ${c.toolResults}`);
  lines.push(`- Attachments: ${c.attachments}`);

  if (manifest.tools.length > 0) {
    lines.push("");
    lines.push("### Tools");
    lines.push("");
    for (const t of manifest.tools) {
      lines.push(`- ${t.name}: ${t.calls} call(s), ${t.results} result(s)`);
    }
  }

  if (manifest.attachments.length > 0) {
    lines.push("");
    lines.push("### Attachments (referenced, not embedded)");
    lines.push("");
    for (const a of manifest.attachments) {
      lines.push(`- ${a.name} (${a.mediaType}, ${a.bytes} bytes)`);
    }
  }

  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  if (messages.length === 0) {
    lines.push("_(no messages)_");
  }
  for (const m of messages) {
    lines.push(`### ${m.role}`);
    lines.push("");
    if (m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        const name = redact(tc.function?.name || "(unknown)");
        const args = clamp(redact(tc.function?.arguments ?? ""), MAX_ARGS);
        lines.push(`- tool call \`${name}\`: ${args}`);
      }
      lines.push("");
    }
    if (typeof m.content === "string" && m.content.length > 0) {
      lines.push(clamp(redact(m.content), MAX_CONTENT));
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// --- write -------------------------------------------------------------------

/**
 * Export a session to `outDir` as `<id>.session-export.md` and
 * `<id>.session-export.manifest.json`. Redaction happens before any bytes are
 * written; writes are atomic and existing files are not overwritten unless
 * `force` is set. Throws {@link SessionExportError} on any failure.
 */
export function exportSession(
  store: SessionStore,
  id: string,
  opts: SessionExportOptions,
): SessionExportResult {
  const built = buildSessionManifest(store, id);
  if ("error" in built) {
    throw new SessionExportError(built.error);
  }
  const { manifest, messages } = built;
  const markdown = renderSessionMarkdown(manifest, messages);
  const manifestText = canonicalize(manifest) + "\n";

  fs.mkdirSync(opts.outDir, { recursive: true });
  const markdownPath = path.join(opts.outDir, `${id}.session-export.md`);
  const manifestPath = path.join(opts.outDir, `${id}.session-export.manifest.json`);

  if (!opts.force) {
    const existing = [markdownPath, manifestPath]
      .filter((p) => fs.existsSync(p))
      .map((p) => path.basename(p));
    if (existing.length > 0) {
      throw new SessionExportError(
        `refusing to overwrite existing file(s): ${existing.join(", ")} (use --force)`,
      );
    }
  }

  const markdownTmp = `${markdownPath}.tmp`;
  const manifestTmp = `${manifestPath}.tmp`;
  try {
    fs.writeFileSync(markdownTmp, markdown, "utf8");
    fs.writeFileSync(manifestTmp, manifestText, "utf8");
    fs.renameSync(markdownTmp, markdownPath);
    fs.renameSync(manifestTmp, manifestPath);
  } catch (err) {
    for (const t of [markdownTmp, manifestTmp]) {
      try {
        fs.rmSync(t, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SessionExportError(`failed to write export: ${msg}`);
  }

  return { markdownPath, manifestPath, manifest };
}

// --- formatting --------------------------------------------------------------

/** Concise human rendering of an export result for CLI output. */
export function formatSessionExport(result: SessionExportResult): string {
  const m = result.manifest;
  const lines: string[] = [];
  lines.push(`Exported session ${m.sessionId} (${m.integrity})`);
  lines.push("─".repeat(40));
  lines.push(`markdown: ${result.markdownPath}`);
  lines.push(`manifest: ${result.manifestPath}`);
  lines.push(`messages: ${m.counts.messages}, tool calls: ${m.counts.toolCalls}, attachments: ${m.counts.attachments}`);
  lines.push(`digest:   ${m.digest}`);
  return lines.join("\n");
}
