import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { toggleSessionPin, renderSessionPickerLines } from "../../src/session-picker.js";
import type { SessionPickerRow } from "../../src/session-picker.js";

const NOW = 1_700_400_000_000;

describe("toggleSessionPin (Issue #620)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-620u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "toggle fodder" }],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pins an unpinned session and unpins it again", () => {
    const pinned = toggleSessionPin(store, id, NOW);
    expect(pinned).toEqual({ ok: true, pinned: true });
    expect(store.readPinned(id)).toEqual({ pinned: true, at: NOW });

    const unpinned = toggleSessionPin(store, id, NOW + 1000);
    expect(unpinned).toEqual({ ok: true, pinned: false });
    expect(store.readPinned(id)).toBeNull();
    expect(fs.existsSync(store.pinnedPath(id))).toBe(false);
  });

  it("touches only the pin marker; every other file stays byte-identical", () => {
    store.writeName(id, "toggle work");
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    expect(toggleSessionPin(store, id, NOW).ok).toBe(true);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
    // Exactly one new file: the pin marker.
    const added = fs.readdirSync(dir).filter((f) => !snapshot.has(f));
    expect(added).toEqual([`${id}.pinned.json`]);
  });

  it("reports a write failure instead of throwing", () => {
    const failing = {
      readPinned: () => null,
      clearPinned: () => undefined,
      writePinned: () => {
        throw new Error("disk on fire");
      },
    } as unknown as SessionStore;
    const result = toggleSessionPin(failing, "any", NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("disk on fire");
  });
});

describe("picker pin-toggle rendering (Issue #620)", () => {
  const row = (over: Partial<SessionPickerRow> = {}): SessionPickerRow => ({
    id: "x",
    shortId: "abcdef12",
    title: "Session abcdef12",
    workspace: "/srv/ws",
    model: "m",
    ageLabel: "1m ago",
    lastModified: 0,
    state: "ok",
    ...over,
  });
  const style = { bold: "", dim: "", reset: "", clearLine: "" };

  it("advertises the pin binding in the header", () => {
    const lines = renderSessionPickerLines([row()], { query: "", selected: 0 }, style);
    expect(lines[0]).toContain("Ctrl-P pin");
  });

  it("renders the confirmation note and yields to errors", () => {
    const noted = renderSessionPickerLines(
      [row()],
      { query: "", selected: 0, note: "Pinned abcdef12" },
      style,
    );
    expect(noted.join("\n")).toContain("Pinned abcdef12");

    const errored = renderSessionPickerLines(
      [row()],
      { query: "", selected: 0, note: "Pinned abcdef12", error: "Cannot toggle pin: disk on fire" },
      style,
    );
    const text = errored.join("\n");
    expect(text).toContain("Cannot toggle pin: disk on fire");
    expect(text).not.toContain("Pinned abcdef12");
  });
});
