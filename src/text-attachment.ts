// Text-file attachments (Issue #797): pin a file's content into the next turn
// deterministically, like aider's /add and the @-references in coding CLIs.
// An attachment is read from a file path confined to the workspace (the same
// resolveSafe confinement images use), bounded by size, validated as UTF-8,
// and carried verbatim — the user authored the act of attaching, so the
// content rides as data at the same trust level as pasting it. Images keep
// their own path untouched; the mixed router sniffs magic bytes (never the
// extension) so a renamed file is still routed by what it actually is.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";
import {
  detectMediaType,
  loadImageAttachment,
  MAX_IMAGES_PER_MESSAGE,
} from "./image-input.js";
import type { LoadedImage } from "./image-input.js";

// A loaded text attachment: the verbatim content plus the non-secret facts
// that describe it.
export interface LoadedTextAttachment {
  name: string;
  // The path exactly as the user typed it — used in the label so the turn
  // reads the way the user asked for it.
  rawPath: string;
  bytes: number;
  content: string;
}

// Limits enforced before anything is attached, so a runaway or hostile file
// cannot inflate the request or the in-memory context. The byte ceiling keeps
// one attachment bounded relative to the context budget; the count ceiling
// matches the image cap so a mixed bundle stays bounded as a whole.
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024; // 256 KiB per file

// Load and validate a single text attachment. Throws a clear Error on any
// failure (missing, not a file, empty, oversized, non-UTF-8, or
// workspace-confinement escape) so callers can surface it without crashing.
export function loadTextAttachment(
  rawPath: string,
  workspace: Workspace,
): LoadedTextAttachment {
  // Confinement + symlink-escape protection: resolveSafe keeps the read inside
  // the workspace root and rejects any path (including absolute ones) that lands
  // outside it — the same contract image attachments use.
  const abs = workspace.resolveSafe(rawPath);

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`Attachment not found: ${rawPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`Attachment path is not a regular file: ${rawPath}`);
  }
  if (st.size === 0) {
    throw new Error(`Attachment is empty: ${rawPath}`);
  }
  if (st.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment exceeds the ${MAX_TEXT_ATTACHMENT_BYTES}-byte text limit (${st.size} bytes): ${rawPath}`,
    );
  }

  const buf = fs.readFileSync(abs);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`Attachment is not valid UTF-8 text (binary file?): ${rawPath}`);
  }
  // NUL bytes never belong in attached text; catch binary content that happens
  // to decode.
  if (content.includes("\u0000")) {
    throw new Error(`Attachment is not valid UTF-8 text (binary file?): ${rawPath}`);
  }

  return { name: path.basename(abs), rawPath, bytes: buf.length, content };
}

// Route a mixed attachment list: each file is sniffed by magic bytes — a
// supported raster image goes through the existing image path (all of its
// validations included); anything else is loaded as text. Throws up front on
// the count cap and propagates every per-file error untouched, so failures
// stay honest and nothing partial is attached.
export function loadMixedAttachments(
  paths: string[],
  workspace: Workspace,
): { images: LoadedImage[]; texts: LoadedTextAttachment[] } {
  if (paths.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(
      `Too many attachments: ${paths.length} provided, limit is ${MAX_IMAGES_PER_MESSAGE}`,
    );
  }
  const images: LoadedImage[] = [];
  const texts: LoadedTextAttachment[] = [];
  for (const rawPath of paths) {
    const abs = workspace.resolveSafe(rawPath);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`Attachment not found: ${rawPath}`);
    }
    if (!st.isFile()) {
      throw new Error(`Attachment path is not a regular file: ${rawPath}`);
    }
    if (st.size === 0) {
      throw new Error(`Attachment is empty: ${rawPath}`);
    }
    // Magic-byte sniff decides the route; the extension is ignored on purpose.
    const head = fs.readFileSync(abs).subarray(0, 16);
    if (detectMediaType(head) !== null) {
      // The image path re-reads and re-validates everything image-side
      // (size, dimensions, full-header media type).
      images.push(loadImageAttachment(rawPath, workspace));
    } else {
      texts.push(loadTextAttachment(rawPath, workspace));
    }
  }
  return { images, texts };
}

// Compose the delimited, path-labeled sections that carry attached text into
// the next turn's user message. The content is attached verbatim; only the
// path attribute is guarded (quotes collapsed) so a hostile path cannot break
// out of the label.
export function composeTextAttachmentSections(
  texts: readonly LoadedTextAttachment[],
): string {
  return texts
    .map((t) => {
      const label = t.rawPath.replace(/"/g, "'");
      return `<attached-file path="${label}" name="${t.name}">\n${t.content}\n</attached-file>`;
    })
    .join("\n\n");
}

// The user message content for a turn with text attachments: the prompt
// followed by the labeled sections. With no attachments the prompt is
// returned unchanged (byte-for-byte).
export function promptWithTextAttachments(
  prompt: string,
  texts: readonly LoadedTextAttachment[],
): string {
  if (texts.length === 0) return prompt;
  return `${prompt}\n\n${composeTextAttachmentSections(texts)}`;
}
