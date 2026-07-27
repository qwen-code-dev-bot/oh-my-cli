import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeSessionName,
  sessionDisplayTitle,
  MAX_SESSION_NAME_LENGTH,
} from "../../src/session-name.js";
import { SessionStore } from "../../src/session.js";
import {
  projectSessionRow,
  collectSessionPickerRows,
  filterSessionRows,
} from "../../src/session-picker.js";
import type { SessionSummary } from "../../src/session-summary.js";

const SECRET = ["ghp", "_", "a".repeat(24)].join("");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeStore(): SessionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-name-"));
  tmpDirs.push(dir);
  return new SessionStore(dir);
}

describe("normalizeSessionName (#249)", () => {
  it("trims and returns a valid name", () => {
    expect(normalizeSessionName("  refactor auth  ")).toEqual({ ok: true, name: "refactor auth" });
  });

  it("treats empty/whitespace as a clear (null)", () => {
    expect(normalizeSessionName("")).toEqual({ ok: true, name: null });
    expect(normalizeSessionName("   \t  ")).toEqual({ ok: true, name: null });
  });

  it("rejects control characters and terminal escapes", () => {
    expect(normalizeSessionName("bad\u0000name").ok).toBe(false);
    expect(normalizeSessionName("spoof\u001b[2J").ok).toBe(false);
    expect(normalizeSessionName("nl\nname").ok).toBe(false);
  });

  it("rejects secret-like content", () => {
    const res = normalizeSessionName(`key ${SECRET}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("secret");
  });

  it("rejects overlong names but accepts the bound", () => {
    expect(normalizeSessionName("x".repeat(MAX_SESSION_NAME_LENGTH + 1)).ok).toBe(false);
    expect(normalizeSessionName("x".repeat(MAX_SESSION_NAME_LENGTH))).toEqual({
      ok: true,
      name: "x".repeat(MAX_SESSION_NAME_LENGTH),
    });
  });
});

describe("sessionDisplayTitle (#249)", () => {
  it("prefers the explicit name, then goal, then the id label", () => {
    expect(sessionDisplayTitle({ name: "My Name", goalTitle: "Goal", shortId: "abc" })).toBe("My Name");
    expect(sessionDisplayTitle({ name: null, goalTitle: "Goal", shortId: "abc" })).toBe("Goal");
    expect(sessionDisplayTitle({ name: "  ", goalTitle: "  ", shortId: "abc" })).toBe("Session abc");
    expect(sessionDisplayTitle({ shortId: "abc" })).toBe("Session abc");
  });
});

describe("SessionStore name sidecar (#249)", () => {
  it("round-trips a name and clears it with null", () => {
    const store = makeStore();
    const id = store.newId();
    store.append(id, { role: "user", content: "hi" });
    expect(store.readName(id)).toBeNull();
    store.writeName(id, "release prep");
    expect(store.readName(id)).toBe("release prep");
    store.writeName(id, null);
    expect(store.readName(id)).toBeNull();
  });

  it("does not list the name sidecar as a session and leaves transcript bytes unchanged", () => {
    const store = makeStore();
    const id = store.newId();
    store.append(id, { role: "user", content: "first" });
    const before = fs.readFileSync(store.filePath(id), "utf-8");
    store.writeName(id, "named");
    const after = fs.readFileSync(store.filePath(id), "utf-8");
    expect(after).toBe(before); // transcript untouched
    expect(store.listIds()).toEqual([id]); // sidecar not listed
  });

  it("reads null for a missing/unreadable sidecar", () => {
    const store = makeStore();
    expect(store.readName("no-such-id")).toBeNull();
  });
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    messageCount: 2,
    userTurns: 1,
    assistantTurns: 1,
    toolCalls: 0,
    totalChars: 100,
    approxTokens: 25,
    model: "fake-model",
    workspace: "/ws",
    createdAt: 1000,
    lastModified: 2000,
    ageMs: 0,
    corrupt: false,
    ...overrides,
  };
}

describe("picker display precedence + search (#249)", () => {
  it("prefers the explicit name in the projected row title and exposes it for search", () => {
    const row = projectSessionRow(summary("aaaaaaaa-1111"), {
      name: "Auth Refactor",
      title: "goal objective",
      state: "ok",
    });
    expect(row.title).toBe("Auth Refactor");
    expect(row.name).toBe("Auth Refactor");
  });

  it("matches the explicit name case-insensitively without changing recency order", () => {
    const store = makeStore();
    const older = store.newId();
    const newer = store.newId();
    store.append(older, { role: "user", content: "old" });
    store.append(newer, { role: "user", content: "new" });
    // Distinct mtimes so recency is deterministic (newer lastModified first).
    fs.utimesSync(store.filePath(older), new Date(1000), new Date(1000));
    fs.utimesSync(store.filePath(newer), new Date(2000), new Date(2000));
    store.writeName(older, "Zebra Project");
    store.writeName(newer, "Alpha Project");

    const rows = collectSessionPickerRows(store);
    // Recency order is preserved (newer first) regardless of the assigned names.
    expect(rows[0].id).toBe(newer);
    expect(rows[1].id).toBe(older);

    // Name search is case-insensitive and selects the right session.
    const matched = filterSessionRows(rows, "zebra project");
    expect(matched.length).toBe(1);
    expect(matched[0].id).toBe(older);
  });
});
