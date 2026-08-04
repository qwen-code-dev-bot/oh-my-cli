import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import type { SessionGoalCheckpoint } from "../../src/session.js";
import {
  runGoalCommand,
  goalHistoryForDisplay,
  formatGoalHistoryLines,
  GOAL_HISTORY_RENDER_LIMIT,
} from "../../src/session-goal.js";
import { buildGoalStatusRecord, formatGoalStatus } from "../../src/goal-status.js";

const NOW = 1_785_300_000_000;

describe("goal revision history (Issue #580)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-580u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("appends one immutable entry per transition with monotonic revisions", () => {
    runGoalCommand(store, sessionId, "ship the feature", NOW);
    runGoalCommand(store, sessionId, "pause", NOW + 1000);
    runGoalCommand(store, sessionId, "resume", NOW + 2000);
    runGoalCommand(store, sessionId, "achieve", NOW + 3000);
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint.revision).toBe(4);
    const history = checkpoint.history ?? [];
    expect(history.map((e) => e.kind)).toEqual(["set", "pause", "resume", "achieve"]);
    expect(history.map((e) => e.revision)).toEqual([1, 2, 3, 4]);
    expect(history.map((e) => e.status)).toEqual(["active", "paused", "active", "achieved"]);
    expect(history.every((e) => e.objective === "ship the feature")).toBe(true);
    expect(history.map((e) => e.at)).toEqual([NOW, NOW + 1000, NOW + 2000, NOW + 3000]);
  });

  it("clear appends a clear entry with null objective and preserves the past", () => {
    runGoalCommand(store, sessionId, "first objective", NOW);
    runGoalCommand(store, sessionId, "clear", NOW + 1000);
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint.goal).toBeNull();
    const history = checkpoint.history ?? [];
    expect(history.map((e) => e.kind)).toEqual(["set", "clear"]);
    expect(history[0].objective).toBe("first objective");
    expect(history[1].objective).toBeNull();
    expect(history[1].status).toBeNull();
    // Setting a new goal keeps the entire prior history.
    runGoalCommand(store, sessionId, "second objective", NOW + 2000);
    const after = store.readGoal(sessionId);
    expect((after.history ?? []).map((e) => e.kind)).toEqual(["set", "clear", "set"]);
    expect((after.history ?? [])[0].objective).toBe("first objective");
  });

  it("never mutates prior entries when new transitions append", () => {
    runGoalCommand(store, sessionId, "objective one", NOW);
    const beforeRaw = fs.readFileSync(store.goalPath(sessionId), "utf8");
    const beforeHistory = (JSON.parse(beforeRaw) as SessionGoalCheckpoint).history ?? [];
    runGoalCommand(store, sessionId, "pause", NOW + 1000);
    const afterHistory = (JSON.parse(fs.readFileSync(store.goalPath(sessionId), "utf8")) as SessionGoalCheckpoint).history ?? [];
    expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
    expect(afterHistory.length).toBe(beforeHistory.length + 1);
  });

  it("synthesizes a legacy display entry for pre-history sidecars without writing it back", () => {
    store.writeGoal(sessionId, {
      revision: 7,
      goal: { objective: "legacy objective", status: "paused", createdAt: NOW, updatedAt: NOW + 5 },
    });
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint.history).toBeUndefined();
    const display = goalHistoryForDisplay(checkpoint);
    expect(display).toEqual([
      { revision: 7, kind: "legacy", objective: "legacy objective", status: "paused", at: NOW + 5 },
    ]);
    // No write-back without a real transition.
    expect((JSON.parse(fs.readFileSync(store.goalPath(sessionId), "utf8")) as SessionGoalCheckpoint).history).toBeUndefined();
    // A real transition persists the legacy basis plus the new entry.
    runGoalCommand(store, sessionId, "resume", NOW + 100);
    const after = store.readGoal(sessionId);
    expect((after.history ?? []).map((e) => e.kind)).toEqual(["legacy", "resume"]);
    expect((after.history ?? [])[0].revision).toBe(7);
    expect((after.history ?? [])[1].revision).toBe(8);
  });

  it("fails closed on a corrupt history array, preserving the bytes", () => {
    fs.writeFileSync(
      store.goalPath(sessionId),
      JSON.stringify({
        revision: 2,
        goal: { objective: "readable goal", status: "active", createdAt: NOW, updatedAt: NOW },
        history: [{ revision: 1, kind: "bogus-kind", objective: null, status: null, at: NOW }],
      }) + "\n",
    );
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint).toEqual({ revision: 0, goal: null });
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.hasGoal).toBe(false);
    expect(formatGoalStatus(record).join("\n")).toContain("No goal recorded for this session.");
    // Bytes preserved.
    expect(fs.readFileSync(store.goalPath(sessionId), "utf8")).toContain("bogus-kind");
  });

  it("bounds rendered history to the limit with an elision count", () => {
    const entries = Array.from({ length: GOAL_HISTORY_RENDER_LIMIT + 3 }, (_, i) => ({
      revision: i + 1,
      kind: "set" as const,
      objective: `objective ${i + 1}`,
      status: "active" as const,
      at: NOW + i,
    }));
    const lines = formatGoalHistoryLines(entries, GOAL_HISTORY_RENDER_LIMIT + 3);
    const entryLines = lines.filter((l) => l.includes("rev "));
    expect(entryLines.length).toBe(GOAL_HISTORY_RENDER_LIMIT);
    // Newest first.
    expect(entryLines[0]).toContain(`rev ${GOAL_HISTORY_RENDER_LIMIT + 3}`);
    expect(lines.join("\n")).toContain("+3 earlier transition(s) not shown");

    const checkpoint: SessionGoalCheckpoint = {
      revision: GOAL_HISTORY_RENDER_LIMIT + 3,
      goal: { objective: "objective 13", status: "active", createdAt: NOW, updatedAt: NOW + 12 },
      history: entries,
    };
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.elidedHistory).toBe(0); // store has no history yet
    fs.writeFileSync(store.goalPath(sessionId), JSON.stringify(checkpoint) + "\n");
    const stored = buildGoalStatusRecord(store, sessionId);
    expect(stored.history.length).toBe(GOAL_HISTORY_RENDER_LIMIT);
    expect(stored.elidedHistory).toBe(3);
    const text = formatGoalStatus(stored).join("\n");
    expect(text).toContain("+3 earlier transition(s) not shown");
    expect(text).toContain(`rev ${GOAL_HISTORY_RENDER_LIMIT + 3}`);
    expect(text).toContain("(current)");
  });

  it("marks the current revision and never marks legacy entries current", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    const checkpoint = store.readGoal(sessionId);
    const lines = formatGoalHistoryLines(goalHistoryForDisplay(checkpoint), checkpoint.revision);
    expect(lines.join("\n")).toContain("rev 1 · set · objective");
    expect(lines.join("\n")).toContain("(current)");

    store.writeGoal(sessionId, {
      revision: 3,
      goal: { objective: "legacy", status: "active", createdAt: NOW, updatedAt: NOW },
    });
    const legacy = store.readGoal(sessionId);
    const legacyLines = formatGoalHistoryLines(goalHistoryForDisplay(legacy), legacy.revision);
    expect(legacyLines.join("\n")).toContain("legacy");
    expect(legacyLines.join("\n")).not.toContain("(current)");
  });

  it("redacts secret-shaped objectives in history at render time", () => {
    const secret = ["ghp", "_", "h".repeat(24)].join("");
    const checkpoint: SessionGoalCheckpoint = {
      revision: 1,
      goal: { objective: `deploy with ${secret}`, status: "active", createdAt: NOW, updatedAt: NOW },
      history: [
        { revision: 1, kind: "set", objective: `deploy with ${secret}`, status: "active", at: NOW },
      ],
    };
    fs.writeFileSync(store.goalPath(sessionId), JSON.stringify(checkpoint) + "\n");
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.history[0].objective).not.toContain(secret);
    expect(record.history[0].objective).toContain("[REDACTED]");
    expect(formatGoalStatus(record).join("\n")).not.toContain(secret);
  });

  it("renders history in /goal status output after the current goal", () => {
    runGoalCommand(store, sessionId, "an objective", NOW);
    runGoalCommand(store, sessionId, "pause", NOW + 1000);
    const status = runGoalCommand(store, sessionId, "status", NOW + 2000);
    expect(status).toContain("Goal: paused");
    expect(status).toContain("history (newest first):");
    expect(status).toContain("rev 2 · pause");
    expect(status).toContain("rev 1 · set");
    expect(status).toContain("(current)");
  });

  it("shows history after clear in both surfaces", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    runGoalCommand(store, sessionId, "clear", NOW + 1000);
    const status = runGoalCommand(store, sessionId, "status", NOW + 2000);
    expect(status).toContain("Goal: none (revision 2)");
    expect(status).toContain("rev 2 · clear · (cleared)");
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.hasGoal).toBe(false);
    expect(record.history.map((h) => h.kind)).toEqual(["clear", "set"]);
    expect(record.history[0].objective).toBeNull();
  });
});
