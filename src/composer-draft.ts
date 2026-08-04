// Durable, workspace-scoped composer drafts (Issue #556). Unsent composer
// text otherwise dies on exit, crash, or a recoverable restart; this store
// makes the draft durable state keyed by the canonical workspace identity —
// the same `workspaceTrustKey` folder trust, --continue, and the #554 resume
// guard use — so symlink aliases and linked worktrees of one repository share
// one draft while different workspaces never see each other's. Drafts are
// private user content (possibly secret-bearing): owner-only files under the
// user's config directory, bounded in size, never part of session transcripts
// or telemetry, and disposable by design — a corrupt record fails closed to
// an empty draft instead of blocking the composer.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceTrustKey } from "./folder-trust.js";

// Bound a durable draft so a runaway composer cannot grow the file without
// limit; oversized drafts are truncated rather than refused (the alternative
// loses user text).
export const COMPOSER_DRAFT_MAX_CHARS = 32_768;

export type ComposerDraftLoad =
  | { status: "none" }
  | { status: "restored"; text: string }
  // The record exists but cannot be trusted; the caller starts empty and may
  // surface a bounded notice. The file is preserved, never deleted here.
  | { status: "corrupt" };

export interface ComposerDraftStore {
  // The workspace-scoped draft file (diagnostics and tests).
  readonly filePath: string;
  load(): ComposerDraftLoad;
  // Persist the draft; empty/whitespace-only text clears the durable copy.
  // Atomic (write temp + rename) so a crash never leaves a torn record.
  save(text: string): void;
}

// Mirrors the session store's HOME convention so an isolated test HOME (or a
// relocated user home) scopes drafts the same way sessions are scoped.
export function defaultDraftsDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.HOME ?? "/root", ".oh-my-cli", "drafts");
}

// The canonical workspace key is an absolute path; hash it to a flat,
// collision-resistant file name so no path separator or alias can escape the
// drafts directory.
export function draftFileName(workspaceKey: string): string {
  return crypto.createHash("sha256").update(workspaceKey).digest("hex") + ".json";
}

export interface OpenComposerDraftStoreOptions {
  workspacePath: string;
  draftsDir?: string;
  // Injectable canonical-key function for deterministic tests; defaults to the
  // folder-trust workspace key (same identity as --continue and #554).
  keyOf?: (workspacePath: string) => string;
}

export function openComposerDraftStore(opts: OpenComposerDraftStoreOptions): ComposerDraftStore {
  const key = (opts.keyOf ?? workspaceTrustKey)(opts.workspacePath);
  const filePath = path.join(opts.draftsDir ?? defaultDraftsDir(), draftFileName(key));

  const load = (): ComposerDraftLoad => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return { status: "none" };
    }
    let parsed: { text?: unknown };
    try {
      parsed = JSON.parse(raw) as { text?: unknown };
    } catch {
      return { status: "corrupt" };
    }
    if (typeof parsed.text !== "string") return { status: "corrupt" };
    const text =
      parsed.text.length > COMPOSER_DRAFT_MAX_CHARS
        ? parsed.text.slice(0, COMPOSER_DRAFT_MAX_CHARS)
        : parsed.text;
    if (text.trim() === "") return { status: "none" };
    return { status: "restored", text };
  };

  const save = (text: string): void => {
    if (text.trim() === "") {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* absent is already clear */
      }
      return;
    }
    const bounded =
      text.length > COMPOSER_DRAFT_MAX_CHARS ? text.slice(0, COMPOSER_DRAFT_MAX_CHARS) : text;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Owner-only regardless of umask: drafts are private user content.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort containment */
    }
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ text: bounded, savedAt: Date.now() }), "utf8");
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  };

  return { filePath, load, save };
}
