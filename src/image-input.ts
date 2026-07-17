// Multimodal image attachments for vision-capable models. An attachment is read
// from a file path confined to the workspace, sniffed by magic bytes (never the
// file extension) to a supported media type, bounded by size and pixel
// dimensions, and encoded as a base64 data URL for the provider. Only a
// non-secret reference (name, media type, size) is ever persisted to the session
// log — the raw bytes (the data URL) live only in the in-memory transcript that
// is sent to the provider.

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";

// A privacy-safe reference recorded in the session log and run summary. It names
// the attachment without carrying any image bytes.
export interface ImageRef {
  name: string;
  mediaType: string;
  bytes: number;
}

// An in-memory attachment carrying the data URL sent to the provider. It is a
// superset of ImageRef; the dataUrl is stripped before persistence.
export interface LoadedImage extends ImageRef {
  dataUrl: string;
}

// Limits enforced before an image is ever sent, so a runaway or hostile
// attachment cannot inflate the request, the in-memory context, or the run.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB (provider high-detail cap)
export const MAX_IMAGE_DIMENSION = 16384; // px on either axis
export const MAX_IMAGES_PER_MESSAGE = 8;

// Detect a media type from the file's leading bytes. Returns null for anything
// that is not one of the supported raster formats. The extension is ignored on
// purpose: a renamed file must not be accepted as a type it is not.
export function detectMediaType(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF87a") {
    return "image/gif";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF89a") {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// Parse pixel dimensions from a supported image header. Returns null when the
// header is truncated or a format variant we do not decode; callers then fall
// back to the byte-size limit alone rather than rejecting a valid image.
export function readImageDimensions(
  buf: Buffer,
  mediaType: string,
): { width: number; height: number } | null {
  switch (mediaType) {
    case "image/png": {
      // IHDR begins at byte 8: 4-byte length, "IHDR", then width@16, height@20.
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    case "image/gif": {
      // Logical screen descriptor: width@6, height@8 (little-endian).
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    case "image/webp":
      return readWebpDimensions(buf);
    case "image/jpeg":
      return readJpegDimensions(buf);
    default:
      return null;
  }
}

function readWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 16) return null;
  const fourCC = buf.toString("ascii", 12, 16);
  if (fourCC === "VP8 " && buf.length >= 30) {
    // Lossy: sync code at 23, then 14-bit width@26 and height@28 (LE).
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourCC === "VP8L" && buf.length >= 25) {
    // Lossless: signature 0x2f@20, then packed 14-bit (w-1) and (h-1).
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (fourCC === "VP8X" && buf.length >= 30) {
    // Extended: 24-bit (canvas width-1)@24 and (height-1)@27 (LE).
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  return null;
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // Walk segment markers until a Start-of-Frame (SOFn) marker, which carries the
  // frame dimensions. DHT/DAC/JPG markers are skipped (they are not SOF).
  let offset = 2; // after the SOI (FF D8)
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // Standalone markers (RSTn, SOI, EOI) carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSOF) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

// Read, validate, and encode a single image attachment. Throws a clear Error on
// any failure (missing, not a file, oversized, unsupported, dimension overflow,
// or workspace-confinement escape) so callers can surface it without crashing.
export function loadImageAttachment(rawPath: string, workspace: Workspace): LoadedImage {
  // Confinement + symlink-escape protection: resolveSafe keeps the read inside
  // the workspace root and rejects any path (including absolute ones) that lands
  // outside it.
  const abs = workspace.resolveSafe(rawPath);

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`Image not found: ${rawPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`Image path is not a regular file: ${rawPath}`);
  }
  if (st.size === 0) {
    throw new Error(`Image is empty: ${rawPath}`);
  }
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image exceeds the ${MAX_IMAGE_BYTES}-byte limit (${st.size} bytes): ${rawPath}`,
    );
  }

  const buf = fs.readFileSync(abs);
  const mediaType = detectMediaType(buf);
  if (!mediaType) {
    throw new Error(`Unsupported image type (expected PNG, JPEG, GIF, or WebP): ${rawPath}`);
  }

  const dims = readImageDimensions(buf, mediaType);
  if (dims && (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION)) {
    throw new Error(
      `Image dimensions ${dims.width}x${dims.height} exceed the ${MAX_IMAGE_DIMENSION}px limit: ${rawPath}`,
    );
  }

  const dataUrl = `data:${mediaType};base64,${buf.toString("base64")}`;
  return { name: path.basename(abs), mediaType, bytes: buf.length, dataUrl };
}

// Load several attachments, enforcing the per-message count cap up front.
export function loadImageAttachments(paths: string[], workspace: Workspace): LoadedImage[] {
  if (paths.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(
      `Too many images: ${paths.length} provided, limit is ${MAX_IMAGES_PER_MESSAGE}`,
    );
  }
  return paths.map((p) => loadImageAttachment(p, workspace));
}

// Strip the data URL, leaving only the non-secret reference safe to persist and
// to print in the run summary.
export function imageRef(img: LoadedImage): ImageRef {
  return { name: img.name, mediaType: img.mediaType, bytes: img.bytes };
}
