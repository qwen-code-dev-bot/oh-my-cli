import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  WORKSPACE_MEMORY_SCHEMA,
  WORKSPACE_MEMORY_VERSION,
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_TEXT_CHARS,
  addWorkspaceMemory,
  forgetWorkspaceMemory,
  loadWorkspaceMemory,
  buildMemoryListRecord,
  formatMemoryList,
  memoryFileName,
} from "../../src/workspace-memory.js";

const ANSI = /\x1b\[/;
const NOW = 1_785_000_000_000;
const keyOf = (p: string): string => p; // deterministic canonical identity
const opts = (memoryDir: string) => ({ memoryDir, keyOf, now: () => NOW });

describe("workspace memory store (Issue #570)", () => {
  let memoryDir: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570-mem-"));
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570-wsA-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570-wsB-"));
  });
  afterEach(() => {
    for (const d of [memoryDir, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("records a memory with provenance and reads it back", () => {
    const result = addWorkspaceMemory(wsA, "run tests with npm test before pushing", opts(memoryDir), {
      head: "abc1234def5678",
    });
    expect(result.ok).toBe(true);
    const load = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(load.corrupt).toBe(false);
    expect(load.entries).toHaveLength(1);
    const entry = load.entries[0];
    expect(entry.text).toBe("run tests with npm test before pushing");
    expect(entry.status).toBe("active");
    expect(entry.provenance.at).toBe(new Date(NOW).toISOString());
    expect(entry.provenance.head).toBe("abc1234def5678");
  });

  it("redacts secrets BEFORE persistence", () => {
    const secret = ["ghp", "_", "a".repeat(24)].join("");
    const result = addWorkspaceMemory(wsA, `token is ${secret} ok`, opts(memoryDir));
    expect(result.ok).toBe(true);
    const load = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(load.entries[0].text).not.toContain(secret);
    expect(load.entries[0].text).toContain("[REDACTED]");
    // The raw store file never contains the secret either.
    const raw = fs.readFileSync(load.filePath, "utf8");
    expect(raw).not.toContain(secret);
  });

  it("fails closed on empty input", () => {
    expect(addWorkspaceMemory(wsA, "   ", opts(memoryDir)).ok).toBe(false);
    expect(loadWorkspaceMemory(wsA, opts(memoryDir)).entries).toEqual([]);
  });

  it("scopes stores by canonical workspace identity (isolation)", () => {
    addWorkspaceMemory(wsA, "memory of A", opts(memoryDir));
    addWorkspaceMemory(wsB, "memory of B", opts(memoryDir));
    expect(loadWorkspaceMemory(wsA, opts(memoryDir)).entries.map((e) => e.text)).toEqual(["memory of A"]);
    expect(loadWorkspaceMemory(wsB, opts(memoryDir)).entries.map((e) => e.text)).toEqual(["memory of B"]);
  });

  it("shares one store across symlink aliases of the same workspace", () => {
    const alias = path.join(path.dirname(wsA), `${path.basename(wsA)}-alias`);
    fs.symlinkSync(wsA, alias);
    try {
      const aliasKey = { memoryDir, keyOf: (p: string) => (p === alias ? wsA : p), now: () => NOW };
      addWorkspaceMemory(alias, "recorded via alias", aliasKey);
      expect(loadWorkspaceMemory(wsA, opts(memoryDir)).entries.map((e) => e.text)).toEqual([
        "recorded via alias",
      ]);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it("maps a workspace key to a flat hash file name", () => {
    expect(memoryFileName("/srv/ws")).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("reads a missing store as empty (not corrupt)", () => {
    const load = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(load.entries).toEqual([]);
    expect(load.corrupt).toBe(false);
  });

  it("reads a corrupt store as empty + corrupt, preserving the bytes", () => {
    addWorkspaceMemory(wsA, "real memory", opts(memoryDir));
    const { filePath } = loadWorkspaceMemory(wsA, opts(memoryDir));
    fs.writeFileSync(filePath, "{ not json");
    const load = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(load.entries).toEqual([]);
    expect(load.corrupt).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("{ not json");
  });

  it("refuses to write against a corrupt store", () => {
    addWorkspaceMemory(wsA, "real memory", opts(memoryDir));
    const { filePath } = loadWorkspaceMemory(wsA, opts(memoryDir));
    fs.writeFileSync(filePath, "{ not json");
    const add = addWorkspaceMemory(wsA, "another", opts(memoryDir));
    expect(add.ok).toBe(false);
    const forget = forgetWorkspaceMemory(wsA, "whatever", opts(memoryDir));
    expect(forget.ok).toBe(false);
    // The corrupt bytes are preserved — never overwritten by a refused write.
    expect(fs.readFileSync(filePath, "utf8")).toBe("{ not json");
  });

  it("forgets by id as a soft delete and hides the tombstone from active reads", () => {
    const added = addWorkspaceMemory(wsA, "to be forgotten", opts(memoryDir));
    expect(added.ok).toBe(true);
    const id = added.entry!.id;
    const forget = forgetWorkspaceMemory(wsA, id, opts(memoryDir));
    expect(forget.ok).toBe(true);
    const load = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(load.entries).toHaveLength(1); // tombstone retained
    expect(load.entries[0].status).toBe("forgotten");
    expect(load.entries[0].forgottenAt).toBe(new Date(NOW).toISOString());
    // Active-only views hide it.
    expect(buildMemoryListRecord(wsA, opts(memoryDir)).entries).toEqual([]);
  });

  it("fails closed on forgetting an unknown id without touching other entries", () => {
    addWorkspaceMemory(wsA, "keeper", opts(memoryDir));
    const forget = forgetWorkspaceMemory(wsA, "nope1234", opts(memoryDir));
    expect(forget.ok).toBe(false);
    expect(loadWorkspaceMemory(wsA, opts(memoryDir)).entries[0].status).toBe("active");
  });

  it("truncates oversized text at the bound", () => {
    const big = "z".repeat(MEMORY_MAX_TEXT_CHARS + 500);
    const result = addWorkspaceMemory(wsA, big, opts(memoryDir));
    expect(result.ok).toBe(true);
    const text = loadWorkspaceMemory(wsA, opts(memoryDir)).entries[0].text;
    expect(text.length).toBeLessThanOrEqual(MEMORY_MAX_TEXT_CHARS + "… [truncated]".length);
    expect(text.endsWith("… [truncated]")).toBe(true);
  });

  it("fails closed when the store is full", () => {
    const entries = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, i) => ({
      id: `id${i}`,
      text: `m${i}`,
      status: "active" as const,
      provenance: { at: new Date(NOW).toISOString() },
    }));
    const { filePath } = loadWorkspaceMemory(wsA, opts(memoryDir));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schema: WORKSPACE_MEMORY_SCHEMA, v: WORKSPACE_MEMORY_VERSION, entries }) + "\n",
    );
    const result = addWorkspaceMemory(wsA, "one more", opts(memoryDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("full");
  });

  it("writes atomically with owner-only permissions and no stray temp", () => {
    addWorkspaceMemory(wsA, "private", opts(memoryDir));
    const { filePath } = loadWorkspaceMemory(wsA, opts(memoryDir));
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });
});

describe("workspace memory rendering (Issue #570)", () => {
  let memoryDir: string;
  let ws: string;

  beforeEach(() => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570r-mem-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570r-ws-"));
  });
  afterEach(() => {
    for (const d of [memoryDir, ws]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("renders the explicit empty state without ANSI", () => {
    const text = formatMemoryList(ws, opts(memoryDir)).join("\n");
    expect(text).toContain("No workspace memories recorded.");
    expect(text).not.toMatch(ANSI);
  });

  it("renders entries with provenance and hides forgotten ones with a count", () => {
    const a = addWorkspaceMemory(ws, "first convention", opts(memoryDir), { head: "abc1234def5678" });
    addWorkspaceMemory(ws, "second convention", opts(memoryDir));
    forgetWorkspaceMemory(ws, a.entry!.id, opts(memoryDir));
    const text = formatMemoryList(ws, { ...opts(memoryDir), now: () => NOW + 60_000 }).join("\n");
    expect(text).toContain("second convention");
    expect(text).toContain("no git head");
    expect(text).not.toContain("first convention");
    expect(text).toContain("1 forgotten entry hidden from this list.");
  });

  it("renders the corrupt warning", () => {
    addWorkspaceMemory(ws, "real", opts(memoryDir));
    const { filePath } = loadWorkspaceMemory(ws, opts(memoryDir));
    fs.writeFileSync(filePath, "{ not json");
    const text = formatMemoryList(ws, opts(memoryDir)).join("\n");
    expect(text).toContain("unreadable");
  });

  it("builds a versioned active-only JSON record", () => {
    addWorkspaceMemory(ws, "kept", opts(memoryDir), { head: "f".repeat(40) });
    const rec = buildMemoryListRecord(ws, opts(memoryDir));
    expect(rec.schema).toBe(WORKSPACE_MEMORY_SCHEMA);
    expect(rec.v).toBe(WORKSPACE_MEMORY_VERSION);
    expect(rec.corrupt).toBe(false);
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0].text).toBe("kept");
    expect(rec.entries[0].head).toBe("f".repeat(40));
    expect(rec.entries[0].recordedAt).toBe(new Date(NOW).toISOString());
  });

  it("does not orphan a surrogate when truncating stored memory text (Issue #868)", () => {
    const text = "a".repeat(MEMORY_MAX_TEXT_CHARS - 1) + "🚀 tail";
    const result = addWorkspaceMemory(ws, text, opts(memoryDir));
    expect(result.ok).toBe(true);
    const load = loadWorkspaceMemory(ws, opts(memoryDir));
    const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(load.entries[0].text).not.toMatch(LONE);
  });

  it("does not orphan a surrogate when truncating the displayed memory text (Issue #868)", () => {
    const text = "a".repeat(499) + "🚀" + "a".repeat(100);
    const result = addWorkspaceMemory(ws, text, opts(memoryDir));
    expect(result.ok).toBe(true);
    const rendered = formatMemoryList(ws, opts(memoryDir)).join("\n");
    const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(rendered).not.toMatch(LONE);
  });
});
