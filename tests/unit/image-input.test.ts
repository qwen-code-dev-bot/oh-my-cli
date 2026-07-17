import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  detectMediaType,
  readImageDimensions,
  loadImageAttachment,
  loadImageAttachments,
  imageRef,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGES_PER_MESSAGE,
} from "../../src/image-input.js";

// --- minimal valid image headers (magic bytes + dimension fields) -----------

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR chunk length
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpVp8l(): Buffer {
  // VP8L (lossless); packed bits zero ⇒ 1x1.
  const b = Buffer.alloc(25);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b[20] = 0x2f; // VP8L signature
  return b;
}

function jpeg(): Buffer {
  // SOI then a SOF0 segment carrying 32x16.
  const b = Buffer.alloc(20);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xc0; // SOF0
  b.writeUInt16BE(17, 4);
  b[6] = 8; // precision
  b.writeUInt16BE(16, 7); // height
  b.writeUInt16BE(32, 9); // width
  return b;
}

describe("detectMediaType", () => {
  it("sniffs each supported format from magic bytes", () => {
    expect(detectMediaType(png(1, 1))).toBe("image/png");
    expect(detectMediaType(gif(1, 1))).toBe("image/gif");
    expect(detectMediaType(webpVp8l())).toBe("image/webp");
    expect(detectMediaType(jpeg())).toBe("image/jpeg");
  });

  it("returns null for non-image bytes and a renamed extension cannot lie", () => {
    expect(detectMediaType(Buffer.from("this is plain text, not an image"))).toBeNull();
    expect(detectMediaType(Buffer.alloc(4))).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("parses dimensions per format", () => {
    expect(readImageDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(gif(300, 200), "image/gif")).toEqual({ width: 300, height: 200 });
    expect(readImageDimensions(jpeg(), "image/jpeg")).toEqual({ width: 32, height: 16 });
    expect(readImageDimensions(webpVp8l(), "image/webp")).toEqual({ width: 1, height: 1 });
  });

  it("returns null on a truncated header", () => {
    expect(readImageDimensions(png(1, 1).subarray(0, 12), "image/png")).toBeNull();
  });
});

describe("loadImageAttachment", () => {
  let dir: string;
  let outside: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-img-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "omc-img-out-"));
    ws = new Workspace(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("loads a supported image into a data URL and a non-secret reference", () => {
    fs.writeFileSync(path.join(dir, "shot.png"), png(8, 8));
    const img = loadImageAttachment("shot.png", ws);
    expect(img.name).toBe("shot.png");
    expect(img.mediaType).toBe("image/png");
    expect(img.bytes).toBe(24);
    expect(img.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    // The reference drops the data URL entirely.
    expect(imageRef(img)).toEqual({ name: "shot.png", mediaType: "image/png", bytes: 24 });
    expect(imageRef(img) as { dataUrl?: string }).not.toHaveProperty("dataUrl");
  });

  it("rejects a missing file with a clear error", () => {
    expect(() => loadImageAttachment("nope.png", ws)).toThrow(/Image not found/);
  });

  it("rejects an empty file", () => {
    fs.writeFileSync(path.join(dir, "empty.png"), Buffer.alloc(0));
    expect(() => loadImageAttachment("empty.png", ws)).toThrow(/Image is empty/);
  });

  it("rejects a directory (not a regular file)", () => {
    fs.mkdirSync(path.join(dir, "sub"));
    expect(() => loadImageAttachment("sub", ws)).toThrow(/not a regular file/);
  });

  it("rejects an unsupported type even with an image extension", () => {
    fs.writeFileSync(path.join(dir, "fake.png"), "definitely not a png");
    expect(() => loadImageAttachment("fake.png", ws)).toThrow(/Unsupported image type/);
  });

  it("rejects an oversized image by byte size before reading it all", () => {
    // A sparse file: the PNG signature is present but stat size exceeds the cap.
    const p = path.join(dir, "huge.png");
    fs.writeFileSync(p, png(1, 1).subarray(0, 8));
    fs.truncateSync(p, MAX_IMAGE_BYTES + 1);
    expect(() => loadImageAttachment("huge.png", ws)).toThrow(/exceeds the .*-byte limit/);
  });

  it("rejects an image whose dimensions exceed the pixel cap", () => {
    fs.writeFileSync(path.join(dir, "wide.png"), png(MAX_IMAGE_DIMENSION + 1, 10));
    expect(() => loadImageAttachment("wide.png", ws)).toThrow(/dimensions .* exceed/);
  });

  it("confines reads to the workspace (absolute escape rejected)", () => {
    const p = path.join(outside, "secret.png");
    fs.writeFileSync(p, png(2, 2));
    expect(() => loadImageAttachment(p, ws)).toThrow(/escape/i);
  });

  it("confines reads to the workspace (relative .. escape rejected)", () => {
    const p = path.join(outside, "secret.png");
    fs.writeFileSync(p, png(2, 2));
    const rel = path.relative(dir, p);
    expect(() => loadImageAttachment(rel, ws)).toThrow(/escape/i);
  });
});

describe("loadImageAttachments", () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-imgs-"));
    ws = new Workspace(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads several images", () => {
    fs.writeFileSync(path.join(dir, "a.png"), png(4, 4));
    fs.writeFileSync(path.join(dir, "b.gif"), gif(4, 4));
    const imgs = loadImageAttachments(["a.png", "b.gif"], ws);
    expect(imgs.map((i) => i.mediaType)).toEqual(["image/png", "image/gif"]);
  });

  it("enforces the per-message count cap", () => {
    const paths = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => `x${i}.png`);
    expect(() => loadImageAttachments(paths, ws)).toThrow(/Too many images/);
  });
});
