import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";
import { buildGoalStatusRecord, formatGoalStatus } from "../../src/goal-status.js";

const NOW = 1_785_950_000_000;

describe("--goal-status text history ordering (Issue #588)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-588u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("renders newest-first with a single current marker on the newest entry", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    runGoalCommand(store, sessionId, "title Label", NOW + 1000);
    runGoalCommand(store, sessionId, "pause", NOW + 2000);

    const record = buildGoalStatusRecord(store, sessionId);
    // The JSON record ordering is unchanged: newest first.
    expect(record.history.map((h) => h.kind)).toEqual(["pause", "title", "set"]);

    const text = formatGoalStatus(record).join("\n");
    const entryLines = text.split("\n").filter((l) => l.trimStart().startsWith("rev "));
    expect(entryLines).toHaveLength(3);
    expect(entryLines[0]).toContain("rev 2 · pause");
    expect(entryLines[1]).toContain("rev 1 · title · Label");
    expect(entryLines[2]).toContain("rev 1 · set");
    // Exactly one current marker, on the newest entry.
    expect(text.match(/\(current\)/g)).toHaveLength(1);
    expect(entryLines[0]).toContain("(current)");
    expect(entryLines[2]).not.toContain("(current)");
  });

  it("matches the TUI /goal status ordering for the same checkpoint", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    runGoalCommand(store, sessionId, "title Label", NOW + 1000);
    const tui = runGoalCommand(store, sessionId, "status", NOW + 2000);
    const headless = formatGoalStatus(buildGoalStatusRecord(store, sessionId)).join("\n");
    const entriesOf = (s: string) =>
      s
        .split("\n")
        .filter((l) => l.trimStart().startsWith("rev "))
        .map((l) => l.trim());
    expect(entriesOf(headless)).toEqual(entriesOf(tui));
  });
});
