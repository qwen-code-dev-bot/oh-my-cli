import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  loadTextAttachment,
  loadMixedAttachments,
  composeTextAttachmentSections,
  promptWithTextAttachments,
  MAX_TEXT_ATTACHMENT_BYTES,
} from "../../src/text-attachment.js";
import type { LoadedTextAttachment } from "../../src/text-attachment.js";

// A minimal valid 1x1 PNG (magic bytes + IHDR with dimensions), matching the
// fixture style used by the image-input tests.
function png(): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR chunk length
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1, 16); // width
  b.writeUInt32BE(1, 20); // height
  return b;
}

describe("text attachment loading (Issue #797)", () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-textattach-"));
    ws = new Workspace(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string | Buffer): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it("loads a UTF-8 text file verbatim with name, rawPath, and byte count", () => {
    write("notes.md", "line 1\nline 2 — 数据\n");
    const t = loadTextAttachment("notes.md", ws);
    expect(t.content).toBe("line 1\nline 2 — 数据\n");
    expect(t.name).toBe("notes.md");
    expect(t.rawPath).toBe("notes.md");
    expect(t.bytes).toBe(fs.statSync(path.join(dir, "notes.md")).size);
  });

  it("fails honestly on a missing file", () => {
    expect(() => loadTextAttachment("nope.txt", ws)).toThrow(/not found/i);
  });

  it("fails honestly on an empty file", () => {
    write("empty.txt", "");
    expect(() => loadTextAttachment("empty.txt", ws)).toThrow(/empty/i);
  });

  it("fails honestly beyond the size ceiling (no partial attachment)", () => {
    write("big.txt", "x".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1));
    expect(() => loadTextAttachment("big.txt", ws)).toThrow(
      new RegExp(`${MAX_TEXT_ATTACHMENT_BYTES}-byte`),
    );
  });

  it("accepts exactly the ceiling", () => {
    write("edge.txt", "x".repeat(MAX_TEXT_ATTACHMENT_BYTES));
    const t = loadTextAttachment("edge.txt", ws);
    expect(t.bytes).toBe(MAX_TEXT_ATTACHMENT_BYTES);
  });

  it("fails honestly on non-UTF-8 (binary) content", () => {
    write("bin.dat", Buffer.from([0xff, 0xfe, 0x00, 0x81, 0xc3, 0x28]));
    expect(() => loadTextAttachment("bin.dat", ws)).toThrow(/utf-8/i);
  });

  it("fails honestly on NUL bytes (binary masquerading as decodable UTF-8)", () => {
    write("nul.txt", Buffer.from("abc\u0000def", "utf8"));
    expect(() => loadTextAttachment("nul.txt", ws)).toThrow(/utf-8/i);
  });

  it("keeps attachment reads confined to the workspace", () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "secret");
    try {
      expect(() => loadTextAttachment(outside, ws)).toThrow(/escape|confined/i);
      expect(() => loadTextAttachment("../escape.txt", ws)).toThrow(/escape|confined|not found/i);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe("mixed attachment routing (Issue #797)", () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-mixattach-"));
    ws = new Workspace(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("routes images by magic bytes and text files by content", () => {
    fs.writeFileSync(path.join(dir, "pic.png"), png());
    fs.writeFileSync(path.join(dir, "notes.md"), "hello text");
    const mixed = loadMixedAttachments(["pic.png", "notes.md"], ws);
    expect(mixed.images.length).toBe(1);
    expect(mixed.images[0].name).toBe("pic.png");
    expect(mixed.images[0].mediaType).toBe("image/png");
    expect(mixed.texts.length).toBe(1);
    expect(mixed.texts[0].content).toBe("hello text");
  });

  it("routes a text-named PNG to the image path (magic beats extension)", () => {
    fs.writeFileSync(path.join(dir, "not-really.txt"), png());
    const mixed = loadMixedAttachments(["not-really.txt"], ws);
    expect(mixed.images.length).toBe(1);
    expect(mixed.texts.length).toBe(0);
  });

  it("fails honestly when one file is bad (nothing partial)", () => {
    fs.writeFileSync(path.join(dir, "ok.md"), "fine");
    fs.writeFileSync(path.join(dir, "bad.md"), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
    expect(() => loadMixedAttachments(["ok.md", "bad.md"], ws)).toThrow(/utf-8/i);
  });
});

describe("attachment section composition (Issue #797)", () => {
  const t = (content: string, rawPath = "src/foo.ts"): LoadedTextAttachment => ({
    name: path.basename(rawPath),
    rawPath,
    bytes: Buffer.byteLength(content),
    content,
  });

  it("returns the prompt byte-for-byte with no attachments", () => {
    expect(promptWithTextAttachments("do the thing", [])).toBe("do the thing");
  });

  it("appends delimited, path-labeled sections with verbatim content", () => {
    const out = promptWithTextAttachments("review this", [t("const x = 1;")]);
    expect(out.startsWith("review this\n\n")).toBe(true);
    expect(out).toContain('<attached-file path="src/foo.ts" name="foo.ts">');
    expect(out).toContain("const x = 1;");
    expect(out.endsWith("</attached-file>")).toBe(true);
  });

  it("guards the path attribute against quote breakout", () => {
    const out = composeTextAttachmentSections([t("body", 'evil".txt')]);
    expect(out).not.toContain('path="evil"');
    expect(out).toContain("path=\"evil'.txt\"");
  });

  it("guards the name attribute against quote breakout (Issue #872)", () => {
    const out = composeTextAttachmentSections([t("body", 'evil".txt')]);
    // The basename feeds the name attribute and must not break out either.
    expect(out).not.toContain('name="evil"');
    expect(out).toContain("name=\"evil'.txt\"");
  });

  it("joins multiple sections in order", () => {
    const out = composeTextAttachmentSections([t("first", "a.txt"), t("second", "b.txt")]);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
    expect(out.split("<attached-file").length - 1).toBe(2);
  });
});
