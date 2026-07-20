import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import type { SessionSummary } from "../../src/session-summary.js";
import {
  shortSessionId,
  projectSessionRow,
  orderSessionRows,
  filterSessionRows,
  resolveResumeTarget,
  collectSessionPickerRows,
  renderSessionPickerLines,
  runSessionPicker,
} from "../../src/session-picker.js";
import type {
  SessionPickerRow,
  SessionPickerState,
  SessionPickerStyle,
  SessionPickerSelection,
} from "../../src/session-picker.js";

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  id: "01234567-89ab-cdef-0123-456789abcdef",
  messageCount: 4,
  userTurns: 2,
  assistantTurns: 2,
  toolCalls: 1,
  totalChars: 40,
  approxTokens: 10,
  model: "fake-model",
  workspace: "/srv/proj",
  createdAt: 0,
  lastModified: 0,
  ageMs: 5000,
  corrupt: false,
  ...over,
});

const row = (over: Partial<SessionPickerRow>): SessionPickerRow => ({
  id: "01234567-89ab-cdef-0123-456789abcdef",
  shortId: "01234567",
  title: "Fix the login bug",
  workspace: "/srv/proj",
  model: "fake-model",
  ageLabel: "5s ago",
  lastModified: 0,
  state: "ok",
  ...over,
});

const NO_COLOR_STYLE: SessionPickerStyle = {
  bold: "",
  dim: "",
  reset: "",
  danger: "",
  clearLine: "",
};

const COLOR_STYLE: SessionPickerStyle = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  danger: "\x1b[31m",
  clearLine: "\x1b[2K",
};

describe("session picker: shortSessionId", () => {
  it("takes the first uuid segment, capped at 8 chars", () => {
    expect(shortSessionId("01234567-89ab-cdef-0123-456789abcdef")).toBe("01234567");
  });

  it("handles non-uuid ids", () => {
    expect(shortSessionId("older-session")).toBe("older");
    expect(shortSessionId("good")).toBe("good");
  });

  it("caps a long single segment", () => {
    expect(shortSessionId("abcdefghijklmnop")).toBe("abcdefgh");
  });
});

describe("session picker: projectSessionRow", () => {
  it("uses the goal title when present", () => {
    const r = projectSessionRow(summary({ id: "abc-1", ageMs: 5000 }), {
      title: "Refactor the parser",
      state: "ok",
    });
    expect(r.title).toBe("Refactor the parser");
    expect(r.shortId).toBe("abc");
    expect(r.ageLabel).toBe("5s ago");
    expect(r.state).toBe("ok");
  });

  it("falls back to a neutral, non-leaking label without a goal", () => {
    const r = projectSessionRow(summary({ id: "abcdef12-xx" }), { title: undefined, state: "ok" });
    expect(r.title).toBe("Session abcdef12");
  });

  it("clamps an over-long title with an ellipsis", () => {
    const long = "x".repeat(120);
    const r = projectSessionRow(summary(), { title: long, state: "ok" });
    expect(r.title.length).toBeLessThanOrEqual(60);
    expect(r.title.endsWith("…")).toBe(true);
  });

  it("collapses newlines/whitespace in the title to one line", () => {
    const r = projectSessionRow(summary(), { title: "multi\n  line\t objective", state: "ok" });
    expect(r.title).toBe("multi line objective");
  });

  it("redacts secret-like values in title, model, and workspace", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const r = projectSessionRow(summary({ model: `m ${token}`, workspace: `/srv/${token}` }), {
      title: `objective ${token}`,
      state: "ok",
    });
    expect(r.title).not.toContain(token);
    expect(r.model).not.toContain(token);
    expect(r.workspace).not.toContain(token);
    expect(r.title).toContain("[REDACTED]");
  });

  it("collapses the home prefix in the workspace", () => {
    const home = process.env.HOME ?? "/root";
    const r = projectSessionRow(summary({ workspace: `${home}/proj` }), {
      title: undefined,
      state: "ok",
    });
    expect(r.workspace).toBe("~/proj");
  });

  it("renders unknown for missing model and workspace", () => {
    const r = projectSessionRow(summary({ model: undefined, workspace: undefined }), {
      title: undefined,
      state: "ok",
    });
    expect(r.model).toBe("unknown");
    expect(r.workspace).toBe("unknown");
  });
});

describe("session picker: orderSessionRows", () => {
  it("orders most-recently-active first", () => {
    const ordered = orderSessionRows([
      row({ id: "old", lastModified: 100 }),
      row({ id: "new", lastModified: 300 }),
      row({ id: "mid", lastModified: 200 }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks mtime ties deterministically by id", () => {
    const ordered = orderSessionRows([
      row({ id: "zebra", lastModified: 100 }),
      row({ id: "alpha", lastModified: 100 }),
      row({ id: "mango", lastModified: 100 }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("does not mutate the input array", () => {
    const input = [row({ id: "b", lastModified: 1 }), row({ id: "a", lastModified: 2 })];
    orderSessionRows(input);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("session picker: filterSessionRows", () => {
  const rows = [
    row({ id: "aaaa1111", shortId: "aaaa1111", title: "Fix login", workspace: "/srv/web", model: "fake-model" }),
    row({ id: "bbbb2222", shortId: "bbbb2222", title: "Add metrics", workspace: "/srv/api", model: "other-model" }),
  ];

  it("returns all rows (a copy) for an empty query", () => {
    const out = filterSessionRows(rows, "");
    expect(out.map((r) => r.id)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(out).not.toBe(rows);
  });

  it("matches the title case-insensitively", () => {
    expect(filterSessionRows(rows, "LOGIN").map((r) => r.id)).toEqual(["aaaa1111"]);
  });

  it("matches the workspace and model", () => {
    expect(filterSessionRows(rows, "api").map((r) => r.id)).toEqual(["bbbb2222"]);
    expect(filterSessionRows(rows, "other-model").map((r) => r.id)).toEqual(["bbbb2222"]);
  });

  it("matches the short id", () => {
    expect(filterSessionRows(rows, "aaaa").map((r) => r.id)).toEqual(["aaaa1111"]);
  });

  it("preserves order and returns nothing when unmatched", () => {
    expect(filterSessionRows(rows, "zzzz")).toEqual([]);
  });
});

describe("session picker: renderSessionPickerLines", () => {
  it("renders the header, query line, and a selected row with the ◆ marker", () => {
    const lines = renderSessionPickerLines([row({ title: "Fix login" })], { query: "fix", selected: 0 }, NO_COLOR_STYLE);
    const joined = lines.join("\n");
    expect(joined).toContain("Sessions");
    expect(joined).toContain("Enter resume · Esc cancel");
    expect(joined).toContain("> fix");
    expect(joined).toContain("◆ Fix login");
  });

  it("marks only the selected row and shows state metadata", () => {
    const lines = renderSessionPickerLines(
      [row({ id: "a", title: "Alpha", shortId: "aaaaaaaa", state: "ok" }), row({ id: "b", title: "Beta", shortId: "bbbbbbbb", state: "ok" })],
      { query: "", selected: 1 },
      NO_COLOR_STYLE,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("◆ Beta");
    expect(joined).toContain("  Alpha");
    expect(joined).toContain("✓ bbbbbbbb");
  });

  it("annotates corrupt, stale, and partial rows", () => {
    const corrupt = renderSessionPickerLines([row({ state: "corrupt" })], { query: "", selected: 0 }, NO_COLOR_STYLE).join("\n");
    expect(corrupt).toContain("✗");
    expect(corrupt).toContain("(corrupt)");

    const stale = renderSessionPickerLines([row({ state: "stale" })], { query: "", selected: 0 }, NO_COLOR_STYLE).join("\n");
    expect(stale).toContain("(workspace missing)");

    const partial = renderSessionPickerLines([row({ state: "partial" })], { query: "", selected: 0 }, NO_COLOR_STYLE).join("\n");
    expect(partial).toContain("(partial)");
  });

  it("shows an empty-store message and a no-match message", () => {
    expect(renderSessionPickerLines([], { query: "", selected: 0 }, NO_COLOR_STYLE).join("\n")).toContain(
      "No resumable sessions",
    );
    expect(renderSessionPickerLines([], { query: "zzz", selected: 0 }, NO_COLOR_STYLE).join("\n")).toContain(
      "No matching sessions",
    );
  });

  it("windows the list and counts the overflow", () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ id: `id${i}`, title: `Title ${i}`, lastModified: 100 - i }));
    const lines = renderSessionPickerLines(many, { query: "", selected: 0, maxVisible: 4 }, NO_COLOR_STYLE);
    const joined = lines.join("\n");
    expect(joined).toContain("Title 0");
    expect(joined).toContain("Title 3");
    expect(joined).not.toContain("Title 4");
    expect(joined).toContain("… and 6 more");
  });

  it("renders an error line when present", () => {
    const lines = renderSessionPickerLines([row()], { query: "", selected: 0, error: "Cannot resume: session is corrupt" }, NO_COLOR_STYLE);
    expect(lines.join("\n")).toContain("Cannot resume: session is corrupt");
  });

  it("emits no ANSI codes under NO_COLOR but keeps the literal glyphs", () => {
    const lines = renderSessionPickerLines([row({ state: "ok" })], { query: "", selected: 0 }, NO_COLOR_STYLE);
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/\x1b\[/);
    expect(joined).toContain("◆");
    expect(joined).toContain("✓");
  });

  it("includes ANSI styling when color is enabled", () => {
    const lines = renderSessionPickerLines([row()], { query: "", selected: 0 }, COLOR_STYLE);
    expect(lines.join("\n")).toContain("\x1b[1m");
  });
});

describe("session picker: resolveResumeTarget", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-picker-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a healthy session to its exact id and workspace", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "m", workspace: tmpDir, createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    const t = resolveResumeTarget(id, store);
    expect(t.ok).toBe(true);
    expect(t.sessionId).toBe(id);
    expect(t.workspace).toBe(tmpDir);
  });

  it("resolves a legacy session with no declared workspace", () => {
    const id = store.newId();
    store.append(id, { role: "user", content: "legacy" });
    const t = resolveResumeTarget(id, store);
    expect(t.ok).toBe(true);
    expect(t.workspace).toBeUndefined();
  });

  it("fails closed for a missing session", () => {
    const t = resolveResumeTarget("does-not-exist", store);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain("was not found");
  });

  it("fails closed for a corrupt checkpoint", () => {
    const id = "corrupt-1";
    fs.writeFileSync(path.join(tmpDir, `${id}.jsonl`), "{bad}\n{worse}\n");
    const t = resolveResumeTarget(id, store);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain("corrupt");
  });

  it("fails closed when the declared workspace no longer exists", () => {
    const id = store.newId();
    store.writeMeta(id, { model: "m", workspace: "/no/such/workspace/here", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    const t = resolveResumeTarget(id, store);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain("no longer exists");
  });

  it("rejects an empty id", () => {
    const t = resolveResumeTarget("   ", store);
    expect(t.ok).toBe(false);
    expect(t.reason).toContain("no session id");
  });
});

describe("session picker: collectSessionPickerRows", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-picker-rows-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads the goal title and classifies corrupt and stale sessions", () => {
    const healthy = store.newId();
    store.writeMeta(healthy, { model: "m", workspace: tmpDir, createdAt: 1 });
    store.append(healthy, { role: "user", content: "hi" });
    store.writeGoal(healthy, { revision: 1, goal: { objective: "Ship the picker", status: "active", createdAt: 1, updatedAt: 1 } });

    const stale = store.newId();
    store.writeMeta(stale, { model: "m", workspace: "/gone/workspace", createdAt: 1 });
    store.append(stale, { role: "user", content: "hi" });

    const corrupt = "corrupt-row";
    fs.writeFileSync(path.join(tmpDir, `${corrupt}.jsonl`), "{bad}\n{bad}\n");

    const rows = collectSessionPickerRows(store, { now: () => 1_000_000 });
    const byTitle = new Map(rows.map((r) => [r.id, r]));
    expect(byTitle.get(healthy)?.title).toBe("Ship the picker");
    expect(byTitle.get(healthy)?.state).toBe("ok");
    expect(byTitle.get(stale)?.state).toBe("stale");
    expect(byTitle.get(corrupt)?.state).toBe("corrupt");
  });

  it("is deterministic across repeated calls", () => {
    const a = store.newId();
    const b = store.newId();
    for (const id of [a, b]) {
      store.writeMeta(id, { model: "m", workspace: tmpDir, createdAt: 1 });
      store.append(id, { role: "user", content: "hi" });
    }
    const fp = (id: string) => path.join(tmpDir, `${id}.jsonl`);
    const t = new Date(1_000_000);
    fs.utimesSync(fp(a), t, t);
    fs.utimesSync(fp(b), t, t);

    const first = collectSessionPickerRows(store, { now: () => 2_000_000 }).map((r) => r.id);
    const second = collectSessionPickerRows(store, { now: () => 2_000_000 }).map((r) => r.id);
    expect(first).toEqual(second);
    expect(first).toEqual([a, b].sort());
  });
});

// Drive the raw-mode picker with synthetic key bytes through a fake stream, so
// browse/search/cancel/resume/failure are exercised without a real TTY.
function drivePicker(
  store: SessionStore,
  keys: Array<Buffer | string>,
  opts: { color?: boolean } = {},
): Promise<{ result: SessionPickerSelection | null; out: string }> {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    setRawMode: (m: boolean) => void;
    emit: (e: string, d: Buffer) => boolean;
  };
  stdin.setRawMode = () => {};
  let out = "";
  const stdout = {
    write: (s: string) => {
      out += s;
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const promise = runSessionPicker(store, stdin, stdout, opts);
  return new Promise((resolve) => {
    setImmediate(() => {
      for (const k of keys) {
        // A string is printable text: emit one keystroke per character, as a
        // real terminal does. Control sequences are passed as a single Buffer.
        if (typeof k === "string") {
          for (const ch of k) stdin.emit("data", Buffer.from(ch));
        } else {
          stdin.emit("data", k);
        }
      }
      promise.then((result) => resolve({ result, out }));
    });
  });
}

describe("session picker: runSessionPicker driver", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-picker-drive-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedHealthy(objective: string): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: tmpDir, createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    store.writeGoal(id, { revision: 1, goal: { objective, status: "active", createdAt: 1, updatedAt: 1 } });
    return id;
  }

  it("resumes the selected session on Enter (exact id + workspace)", async () => {
    const id = seedHealthy("Only session");
    const { result } = await drivePicker(store, [Buffer.from("\r")], { color: false });
    expect(result).toEqual({ sessionId: id, workspace: tmpDir });
  });

  it("cancels on Esc without resuming", async () => {
    seedHealthy("Only session");
    const { result } = await drivePicker(store, [Buffer.from("\x1b")], { color: false });
    expect(result).toBeNull();
  });

  it("filters by typing, then resumes the matched selection", async () => {
    seedHealthy("Alpha objective");
    const beta = seedHealthy("Beta objective");
    // Typing "alpha" narrows the list to the Alpha row, which Enter resumes.
    const { result } = await drivePicker(store, ["alpha", Buffer.from("\r")], { color: false });
    expect(result?.sessionId).not.toBe(beta);
    expect(result?.workspace).toBe(tmpDir);
  });

  it("navigates with ArrowDown then resumes the second row", async () => {
    const a = seedHealthy("Alpha");
    const b = seedHealthy("Beta");
    // Pin equal mtimes so the order is the deterministic id-ascending tiebreak;
    // ArrowDown then moves from row 0 to row 1.
    const t = new Date(1_000_000);
    for (const id of [a, b]) fs.utimesSync(store.filePath(id), t, t);
    const ordered = [a, b].sort();
    const { result } = await drivePicker(store, [Buffer.from("\x1b[B"), Buffer.from("\r")], { color: false });
    expect(result?.sessionId).toBe(ordered[1]);
  });

  it("fails closed on a stale session and keeps the picker open until Esc", async () => {
    const id = store.newId();
    store.writeMeta(id, { model: "m", workspace: "/gone/workspace", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    const { result, out } = await drivePicker(store, [Buffer.from("\r"), Buffer.from("\x1b")], { color: false });
    expect(result).toBeNull();
    expect(out).toContain("Cannot resume");
    expect(out).toContain("no longer exists");
  });
});
