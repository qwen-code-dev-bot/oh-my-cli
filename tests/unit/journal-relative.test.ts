import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionJournal,
  formatRelativeAge,
  formatSessionJournal,
} from "../../src/session-journal.js";
import { buildWorkspaceJournal, formatWorkspaceJournal } from "../../src/workspace-journal.js";
import { appendSessionNote } from "../../src/session-notes.js";

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed reference instant for bucket tests

describe("formatRelativeAge (Issue #650)", () => {
  it("renders just now under 60 seconds", () => {
    expect(formatRelativeAge(NOW, NOW)).toBe("just now");
    expect(formatRelativeAge(NOW - 59_000, NOW)).toBe("just now");
  });

  it("renders minute buckets from 60s up to 60m", () => {
    expect(formatRelativeAge(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatRelativeAge(NOW - 59 * MIN - 59_000, NOW)).toBe("59m ago");
  });

  it("renders hour buckets from 60m up to 24h", () => {
    expect(formatRelativeAge(NOW - HOUR, NOW)).toBe("1h ago");
    expect(formatRelativeAge(NOW - 23 * HOUR - 59 * MIN - 59_000, NOW)).toBe("23h ago");
  });

  it("renders day buckets from 24h up to 30d", () => {
    expect(formatRelativeAge(NOW - DAY, NOW)).toBe("1d ago");
    expect(formatRelativeAge(NOW - 29 * DAY - 23 * HOUR, NOW)).toBe("29d ago");
  });

  it("falls back to the absolute UTC date at and beyond 30d", () => {
    const at = NOW - 30 * DAY;
    expect(formatRelativeAge(at, NOW)).toBe(new Date(at).toISOString().slice(0, 10));
    expect(formatRelativeAge(NOW - 400 * DAY, NOW)).toBe(
      new Date(NOW - 400 * DAY).toISOString().slice(0, 10),
    );
  });

  it("clamps future timestamps (clock drift) to just now", () => {
    expect(formatRelativeAge(NOW + HOUR, NOW)).toBe("just now");
    expect(formatRelativeAge(NOW + 1, NOW)).toBe("just now");
  });
});

describe("journal relative rendering (Issue #650)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;
  // Read-time reference: two days after the seeded history. The live
  // transcript mtime (~today) is therefore in the FUTURE relative to this
  // instant — exercising the clamp through the real wiring.
  const READ_AT = CREATED_AT + 2 * DAY;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-650u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "relative fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: CREATED_AT,
    });
    for (let i = 0; i < 2; i++) {
      expect(appendSessionNote(store, id, `note ${i}`, CREATED_AT + 200 + i * 10).ok).toBe(true);
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function sessionRecord() {
    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    return built.journal;
  }

  it("renders ages in the session surface with the same kept set", () => {
    const record = sessionRecord();
    const plain = formatSessionJournal(record);
    const relative = formatSessionJournal(record, { relative: true, now: READ_AT });

    // Same line count, same kept set — only the timestamp column differs.
    expect(relative.length).toBe(plain.length);
    expect(relative.filter((l) => l.includes("· note ·")).length).toBe(2);

    // created is exactly 2d old at READ_AT; notes are 2d minus ms → 1d.
    expect(relative.some((l) => l.includes("2d ago · created"))).toBe(true);
    expect(relative.some((l) => l.includes("1d ago · note"))).toBe(true);
    // Live last-activity mtime is in the future of READ_AT → clamped.
    expect(relative.some((l) => l.includes("just now · last-activity"))).toBe(true);
    // No ISO timestamps in relative mode.
    expect(relative.join("\n")).not.toContain("T10:40:00");
    // Plain mode unchanged: ISO present.
    expect(plain.join("\n")).toContain("T10:40:00");
  });

  it("renders ages in the workspace surface with the same kept set", () => {
    const record = buildWorkspaceJournal(store, { workspace: "/srv/ws" });
    const plain = formatWorkspaceJournal(record);
    const relative = formatWorkspaceJournal(record, { relative: true, now: READ_AT });

    expect(relative.length).toBe(plain.length);
    expect(relative.some((l) => l.includes("2d ago") && l.includes("created"))).toBe(true);
    expect(relative.some((l) => l.includes("1d ago") && l.includes("note"))).toBe(true);
    expect(relative.some((l) => l.includes("just now") && l.includes("last-activity"))).toBe(true);
    expect(relative.join("\n")).not.toContain("T10:40:00");
    expect(plain.join("\n")).toContain("T10:40:00");
  });

  it("keeps the store byte-identical through relative reads", () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snapshot.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    const record = sessionRecord();
    formatSessionJournal(record, { relative: true, now: READ_AT });
    buildWorkspaceJournal(store, { workspace: "/srv/ws" });
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(dir, f), "utf-8")).toBe(content);
    }
  });
});
