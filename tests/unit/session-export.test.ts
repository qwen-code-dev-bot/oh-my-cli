import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSessionManifest,
  renderSessionMarkdown,
  exportSession,
  formatSessionExport,
  SessionExportError,
  SESSION_EXPORT_SCHEMA,
  SESSION_EXPORT_VERSION,
} from "../../src/session-export.js";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage, SessionMeta } from "../../src/session.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sx-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
const HOME = "/home/tester";
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.HOME;
  process.env.HOME = HOME;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function store(): { store: SessionStore; dir: string } {
  const dir = tmp();
  return { store: new SessionStore(dir), dir };
}

const meta: SessionMeta = {
  meta: true,
  model: "fake-model",
  workspace: `${HOME}/projects/demo`,
  createdAt: 1_700_000_000_000,
};

function seed(s: SessionStore, id: string, messages: SessionMessage[], m: SessionMeta | null = meta): void {
  s.checkpoint(id, messages, m);
}

describe("buildSessionManifest", () => {
  it("returns an error for a missing session", () => {
    const { store: s } = store();
    const result = buildSessionManifest(s, "does-not-exist");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("no such session");
  });

  it("tallies roles, tool calls, and tool results", () => {
    const { store: s } = store();
    const id = "sess-1";
    seed(s, id, [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "edit", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "file body" },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "assistant", content: "done" },
    ]);
    const built = buildSessionManifest(s, id);
    expect("error" in built).toBe(false);
    if ("error" in built) return;
    const { manifest } = built;
    expect(manifest.counts).toEqual({
      messages: 5,
      user: 1,
      assistant: 2,
      system: 0,
      tool: 2,
      toolCalls: 2,
      toolResults: 2,
      attachments: 0,
    });
    expect(manifest.tools).toEqual([
      { name: "edit", calls: 1, results: 1 },
      { name: "read_file", calls: 1, results: 1 },
    ]);
  });

  it("references attachments by name/type/size without embedding bytes", () => {
    const { store: s } = store();
    const id = "sess-att";
    seed(s, id, [
      {
        role: "user",
        content: "see image",
        images: [{ name: "shot.png", mediaType: "image/png", bytes: 2048 }],
      },
    ]);
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    expect(built.manifest.counts.attachments).toBe(1);
    expect(built.manifest.attachments).toEqual([
      { name: "shot.png", mediaType: "image/png", bytes: 2048 },
    ]);
  });

  it("flags a corrupt session but still exports recoverable content", () => {
    const { store: s, dir } = store();
    const id = "sess-corrupt";
    // A bad line in the middle (not a trailing incomplete line) is corrupt.
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify(meta)}\n{not json}\n${JSON.stringify({ role: "user", content: "hi" })}\n`,
    );
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    expect(built.manifest.integrity).toBe("corrupt");
    expect(built.manifest.counts.messages).toBe(1);
  });

  it("digests the raw source file and records redacted metadata", () => {
    const { store: s } = store();
    const id = "sess-digest";
    seed(s, id, [{ role: "user", content: "hi" }]);
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    const raw = fs.readFileSync(s.filePath(id), "utf8");
    expect(built.manifest.digest).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(built.manifest.workspace).toBe("~/projects/demo");
    expect(built.manifest.model).toBe("fake-model");
    expect(built.manifest.createdAt).toBe(meta.createdAt);
    expect(built.manifest.schema).toBe(SESSION_EXPORT_SCHEMA);
    expect(built.manifest.v).toBe(SESSION_EXPORT_VERSION);
  });
});

describe("redaction", () => {
  it("redacts secrets, auth, env values, and the home path before rendering", () => {
    const { store: s } = store();
    const id = "sess-redact";
    seed(s, id, [
      { role: "user", content: `token ${SECRET} and Bearer zzzzzzzzzzzzzzzzzzzz` },
      { role: "user", content: `set API_KEY=hunter2 in ${HOME}/.env` },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell", arguments: `--password ${SECRET}` } },
        ],
      },
    ]);
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    const md = renderSessionMarkdown(built.manifest, built.messages);

    expect(md).not.toContain(SECRET);
    expect(md).not.toContain("hunter2");
    expect(md).not.toContain(HOME);
    expect(md).toContain("[REDACTED]");
    expect(md).toContain("~/.env");
  });

  it("never leaks the secret into the manifest", () => {
    const { store: s } = store();
    const id = "sess-manifest-noleak";
    seed(s, id, [{ role: "user", content: SECRET }]);
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    expect(JSON.stringify(built.manifest)).not.toContain(SECRET);
  });
});

describe("renderSessionMarkdown", () => {
  it("is deterministic for identical input", () => {
    const { store: s } = store();
    const id = "sess-md";
    seed(s, id, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    const built = buildSessionManifest(s, id);
    if ("error" in built) throw new Error(built.error);
    const a = renderSessionMarkdown(built.manifest, built.messages);
    const b = renderSessionMarkdown(built.manifest, built.messages);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });
});

describe("exportSession", () => {
  it("writes both files atomically with no leftover temp files", () => {
    const { store: s } = store();
    const id = "sess-write";
    seed(s, id, [{ role: "user", content: "hi" }]);
    const out = tmp();
    const result = exportSession(s, id, { outDir: out });
    expect(fs.existsSync(result.markdownPath)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(fs.readdirSync(out).some((f) => f.endsWith(".tmp"))).toBe(false);
    // Manifest file is valid, sorted-key JSON with a trailing newline.
    const text = fs.readFileSync(result.manifestPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).schema).toBe(SESSION_EXPORT_SCHEMA);
  });

  it("produces byte-identical manifest bytes for repeated exports", () => {
    const { store: s } = store();
    const id = "sess-determinism";
    seed(s, id, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    const a = exportSession(s, id, { outDir: tmp() });
    const b = exportSession(s, id, { outDir: tmp() });
    expect(fs.readFileSync(a.manifestPath, "utf8")).toBe(fs.readFileSync(b.manifestPath, "utf8"));
    expect(fs.readFileSync(a.markdownPath, "utf8")).toBe(fs.readFileSync(b.markdownPath, "utf8"));
  });

  it("fails closed on a collision without --force and overwrites with it", () => {
    const { store: s } = store();
    const id = "sess-collision";
    seed(s, id, [{ role: "user", content: "hi" }]);
    const out = tmp();
    exportSession(s, id, { outDir: out });
    expect(() => exportSession(s, id, { outDir: out })).toThrowError(SessionExportError);
    // With force it succeeds and leaves no temp residue.
    const result = exportSession(s, id, { outDir: out, force: true });
    expect(fs.existsSync(result.markdownPath)).toBe(true);
    expect(fs.readdirSync(out).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("throws for a missing session", () => {
    const { store: s } = store();
    expect(() => exportSession(s, "nope", { outDir: tmp() })).toThrowError(/no such session/);
  });

  it("does not modify the source session file", () => {
    const { store: s } = store();
    const id = "sess-readonly";
    seed(s, id, [{ role: "user", content: "hi" }]);
    const before = fs.readFileSync(s.filePath(id), "utf8");
    const beforeMtime = fs.statSync(s.filePath(id)).mtimeMs;
    exportSession(s, id, { outDir: tmp() });
    expect(fs.readFileSync(s.filePath(id), "utf8")).toBe(before);
    expect(fs.statSync(s.filePath(id)).mtimeMs).toBe(beforeMtime);
  });
});

describe("formatSessionExport", () => {
  it("summarizes the export with paths and digest", () => {
    const { store: s } = store();
    const id = "sess-fmt";
    seed(s, id, [{ role: "user", content: "hi" }]);
    const result = exportSession(s, id, { outDir: tmp() });
    const text = formatSessionExport(result);
    expect(text).toContain(id);
    expect(text).toContain(result.markdownPath);
    expect(text).toContain(result.manifest.digest);
  });
});
