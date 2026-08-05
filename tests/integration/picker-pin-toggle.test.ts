import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { toggleSessionPin, collectSessionPickerRows } from "../../src/session-picker.js";

describe("Integration: picker pin toggle through the real store (Issue #620)", () => {
  let dir: string;
  let store: SessionStore;
  const NOW = 1_700_500_000_000;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-620i-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(dir, "sessions"), { recursive: true, force: true });
    store = new SessionStore(path.join(dir, "sessions"));
  });

  function seed(content: string, ageSeconds: number): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content }],
      { model: "fake-model", workspace: dir, createdAt: NOW - ageSeconds * 1000 },
    );
    const t = new Date(NOW - ageSeconds * 1000);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  it("toggling re-sorts the picker rows pinned-first and back to recency", () => {
    const older = seed("older mission", 3600);
    const newer = seed("fresh scratch", 10);

    // Pure recency before any pin.
    expect(collectSessionPickerRows(store).map((r) => r.id)).toEqual([newer, older]);

    // Toggle pins the older session: it moves into the pinned block.
    expect(toggleSessionPin(store, older, NOW)).toEqual({ ok: true, pinned: true });
    let rows = collectSessionPickerRows(store);
    expect(rows.map((r) => r.id)).toEqual([older, newer]);
    expect(rows[0].pinned).toBe(true);
    expect(rows[1].pinned).toBeUndefined();

    // Toggle again unpins: recency order is restored.
    expect(toggleSessionPin(store, older, NOW + 1)).toEqual({ ok: true, pinned: false });
    rows = collectSessionPickerRows(store);
    expect(rows.map((r) => r.id)).toEqual([newer, older]);
    expect(rows.every((r) => !r.pinned)).toBe(true);
  });

  it("toggle only adds/removes the pin marker file", () => {
    const id = seed("marker check", 60);
    const before = fs.readdirSync(path.join(dir, "sessions")).sort();
    expect(toggleSessionPin(store, id, NOW).ok).toBe(true);
    expect(fs.readdirSync(path.join(dir, "sessions")).sort()).toEqual(
      [...before, `${id}.pinned.json`].sort(),
    );
    expect(toggleSessionPin(store, id, NOW + 1).ok).toBe(true);
    expect(fs.readdirSync(path.join(dir, "sessions")).sort()).toEqual(before);
  });
});
