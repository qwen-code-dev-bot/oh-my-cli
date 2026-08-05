import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import type { SessionPickerRow } from "../../src/session-picker.js";
import {
  orderSessionRows,
  projectSessionRow,
  filterSessionRows,
  collectSessionPickerRows,
  renderSessionPickerLines,
} from "../../src/session-picker.js";

describe("picker pin ordering (Issue #612)", () => {
  const row = (id: string, over: Partial<SessionPickerRow> = {}): SessionPickerRow => ({
    id,
    shortId: id.slice(0, 8),
    title: `Session ${id.slice(0, 8)}`,
    workspace: "/srv/ws",
    model: "fake-model",
    ageLabel: "1m ago",
    lastModified: 0,
    state: "ok",
    ...over,
  });

  it("orders pinned rows first, recency within each block", () => {
    const rows = [
      row("b-newest", { lastModified: 300 }),
      row("a-old-pinned", { lastModified: 100, pinned: true }),
      row("c-middle", { lastModified: 200 }),
      row("d-old-pinned", { lastModified: 50, pinned: true }),
    ];
    expect(orderSessionRows(rows).map((r) => r.id)).toEqual([
      "a-old-pinned",
      "d-old-pinned",
      "b-newest",
      "c-middle",
    ]);
  });

  it("keeps pure recency order when nothing is pinned", () => {
    const rows = [
      row("a", { lastModified: 100 }),
      row("b", { lastModified: 300 }),
      row("c", { lastModified: 200 }),
    ];
    expect(orderSessionRows(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps pinned matches first after the search filter narrows", () => {
    // filterSessionRows preserves input order, and its input is pinned-first —
    // so a query matching both blocks still lists pinned matches first.
    const rows = orderSessionRows([
      row("fresh-match", { lastModified: 300, title: "migration notes" }),
      row("pinned-match", { lastModified: 100, pinned: true, title: "migration plan" }),
      row("pinned-nomatch", { lastModified: 50, pinned: true, title: "other work" }),
    ]);
    const filtered = filterSessionRows(rows, "migration");
    expect(filtered.map((r) => r.id)).toEqual(["pinned-match", "fresh-match"]);
  });

  it("renders a visible (pinned) flag only on pinned rows", () => {
    const rows = [
      row("aaaaaaaa", { pinned: true, title: "important work" }),
      row("bbbbbbbb", { title: "scratch work" }),
    ];
    const lines = renderSessionPickerLines(
      rows,
      { query: "", selected: 0, error: null },
      { bold: "", dim: "", reset: "", clearLine: "" },
    ).join("\n");
    expect(lines).toContain("important work  (pinned)");
    expect(lines).not.toContain("scratch work  (pinned)");
  });
});

describe("collectSessionPickerRows pin awareness (Issue #612)", () => {
  let dir: string;
  let store: SessionStore;
  let ws: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-612u-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "omc-612u-ws-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  function seed(): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "hi" }], {
      model: "fake-model",
      workspace: ws,
      createdAt: 1,
    });
    return id;
  }

  it("projects pins from the store and lists them first with the flag", () => {
    const older = seed();
    const newer = seed();
    // Deterministic ages: `older` is an hour back, `newer` ten seconds.
    const tOld = new Date(Date.now() / 1000 - 3600);
    const tNew = new Date(Date.now() / 1000 - 10);
    fs.utimesSync(path.join(dir, `${older}.jsonl`), tOld, tOld);
    fs.utimesSync(path.join(dir, `${newer}.jsonl`), tNew, tNew);

    // Without a pin: pure recency.
    const recency = collectSessionPickerRows(store).map((r) => r.id);
    expect(recency).toEqual([newer, older]);

    store.writePinned(older, 1_786_700_000_000);
    const rows = collectSessionPickerRows(store);
    expect(rows.map((r) => r.id)).toEqual([older, newer]);
    expect(rows[0].pinned).toBe(true);
    expect(rows[1].pinned).toBeUndefined();
  });

  it("carries pins through projectSessionRow", () => {
    const pinned = projectSessionRow(
      {
        id: "cccccccc-0000-0000-0000-000000000000",
        messageCount: 1,
        userTurns: 1,
        assistantTurns: 0,
        toolCalls: 0,
        totalChars: 2,
        approxTokens: 1,
        createdAt: 1,
        lastModified: 1,
        ageMs: 0,
        corrupt: false,
        archived: false,
        pinned: true,
        pinnedAt: 5,
      },
      { state: "ok" },
    );
    expect(pinned.pinned).toBe(true);

    const unpinned = projectSessionRow(
      {
        id: "dddddddd-0000-0000-0000-000000000000",
        messageCount: 1,
        userTurns: 1,
        assistantTurns: 0,
        toolCalls: 0,
        totalChars: 2,
        approxTokens: 1,
        createdAt: 1,
        lastModified: 1,
        ageMs: 0,
        corrupt: false,
        archived: false,
        pinned: false,
      },
      { state: "ok" },
    );
    expect(unpinned.pinned).toBeUndefined();
  });
});
