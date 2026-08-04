import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import {
  runGoalCommand,
  goalExecutionRequest,
  goalHistoryForDisplay,
  formatGoalHistoryLines,
  GOAL_TITLE_MAX_CHARS,
} from "../../src/session-goal.js";
import { buildGoalStatusRecord, formatGoalStatus, resumeGoalSummaryLine } from "../../src/goal-status.js";

const NOW = 1_785_800_000_000;

describe("goal title (Issue #586)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-586u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("sets a title without bumping the revision or changing the status", () => {
    expect(runGoalCommand(store, sessionId, "ship the migration", NOW)).toContain("Goal set (revision 1)");
    const out = runGoalCommand(store, sessionId, "title Migration push", NOW + 1000);
    expect(out).toBe("Goal titled (revision 1): Migration push");
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint.revision).toBe(1);
    expect(checkpoint.goal?.title).toBe("Migration push");
    expect(checkpoint.goal?.status).toBe("active");
    expect(checkpoint.goal?.objective).toBe("ship the migration");
  });

  it("clears a title with bare `title` and refuses without a goal", () => {
    expect(runGoalCommand(store, sessionId, "title", NOW)).toBe("Goal: nothing to title");
    expect(runGoalCommand(store, sessionId, "title Anything", NOW)).toBe("Goal: nothing to title");

    runGoalCommand(store, sessionId, "objective", NOW);
    runGoalCommand(store, sessionId, "title A label", NOW + 1000);
    const cleared = runGoalCommand(store, sessionId, "title", NOW + 2000);
    expect(cleared).toBe("Goal title cleared (revision 1)");
    expect(store.readGoal(sessionId).goal?.title).toBeUndefined();
    // Clearing again is a no-op.
    expect(runGoalCommand(store, sessionId, "title", NOW + 3000)).toContain("Goal: active");
  });

  it("appends title history entries at the same revision without bumping it", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    runGoalCommand(store, sessionId, "title A label", NOW + 1000);
    runGoalCommand(store, sessionId, "title", NOW + 2000);
    const history = goalHistoryForDisplay(store.readGoal(sessionId));
    expect(history.map((e) => e.kind)).toEqual(["set", "title", "title"]);
    expect(history.map((e) => e.revision)).toEqual([1, 1, 1]);
    expect(history[1].objective).toBe("A label");
    expect(history[2].objective).toBeNull();
    // The newest entry is marked current even though revisions are shared.
    const lines = formatGoalHistoryLines(history, 1).join("\n");
    expect(lines.match(/\(current\)/g)).toHaveLength(1);
    expect(lines.split("\n")[1]).toContain("(current)");
  });

  it("bounds titles to the cap with a truncation marker", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    const long = "t".repeat(GOAL_TITLE_MAX_CHARS + 50);
    runGoalCommand(store, sessionId, `title ${long}`, NOW + 1000);
    const title = store.readGoal(sessionId).goal?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(GOAL_TITLE_MAX_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  it("redacts secret-shaped titles at write time", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    const secret = ["ghp", "_", "m".repeat(24)].join("");
    runGoalCommand(store, sessionId, `title ${secret}`, NOW + 1000);
    const title = store.readGoal(sessionId).goal?.title ?? "";
    expect(title).not.toContain(secret);
    expect(title).toContain("[REDACTED]");
  });

  it("loads legacy sidecars without a title unchanged", () => {
    store.writeGoal(sessionId, {
      revision: 4,
      goal: { objective: "legacy", status: "active", createdAt: NOW, updatedAt: NOW },
    });
    const checkpoint = store.readGoal(sessionId);
    expect(checkpoint.goal?.title).toBeUndefined();
    expect(checkpoint.revision).toBe(4);
  });

  it("never executes a title command as an objective", () => {
    runGoalCommand(store, sessionId, "objective", NOW);
    expect(goalExecutionRequest("title A label", store.readGoal(sessionId))).toBeNull();
    expect(goalExecutionRequest("title", store.readGoal(sessionId))).toBeNull();
    // Ordinary objectives still execute.
    expect(goalExecutionRequest("objective", store.readGoal(sessionId))).toEqual({
      prompt: "objective",
      revision: 1,
    });
  });

  it("renders the title in /goal status output and goal-status surfaces", () => {
    runGoalCommand(store, sessionId, "a long objective for the migration", NOW);
    runGoalCommand(store, sessionId, "title Migration", NOW + 1000);
    const status = runGoalCommand(store, sessionId, "status", NOW + 2000);
    expect(status).toContain("title: Migration");
    expect(status).toContain("objective: a long objective for the migration");

    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.goal?.title).toBe("Migration");
    expect(formatGoalStatus(record).join("\n")).toContain("title:     Migration");
  });

  it("renders the resume summary title-first", () => {
    runGoalCommand(store, sessionId, "objective text", NOW);
    runGoalCommand(store, sessionId, "title Short label", NOW + 1000);
    const line = resumeGoalSummaryLine(store, sessionId, NOW + 2000);
    expect(line).toBe("Goal: active (Short label) · objective text · rev 1 · updated 1s ago");

    runGoalCommand(store, sessionId, "title", NOW + 3000);
    expect(resumeGoalSummaryLine(store, sessionId, NOW + 4000)).toBe(
      "Goal: active · objective text · rev 1 · updated 1s ago",
    );
  });
});
