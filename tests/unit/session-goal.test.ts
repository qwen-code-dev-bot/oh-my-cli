import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGoalRevisionCurrent, runGoalCommand } from "../../src/session-goal.js";
import { SessionStore } from "../../src/session.js";

describe("session goal", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-goal-test-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sets, reports, pauses, resumes, and clears one durable goal", () => {
    expect(runGoalCommand(store, "a", "ship the release", 1000)).toBe(
      "Goal active (revision 1): ship the release",
    );
    expect(runGoalCommand(store, "a", "status", 1100)).toContain("objective: ship the release");
    expect(runGoalCommand(store, "a", "pause", 1200)).toBe(
      "Goal paused (revision 2): ship the release",
    );
    expect(runGoalCommand(store, "a", "resume", 1300)).toBe(
      "Goal resumed (revision 3): ship the release",
    );
    expect(runGoalCommand(store, "a", "clear", 1400)).toBe("Goal cleared (revision 4)");
    expect(new SessionStore(dir).readGoal("a")).toEqual({ revision: 4, goal: null });
  });

  it("replaces an objective while preserving session isolation", () => {
    runGoalCommand(store, "a", "first", 1000);
    runGoalCommand(store, "a", "second", 2000);
    expect(store.readGoal("a").goal?.objective).toBe("second");
    expect(store.readGoal("a").revision).toBe(2);
    expect(store.readGoal("b")).toEqual({ revision: 0, goal: null });
  });

  it("redacts secrets and removes terminal control input before persistence", () => {
    runGoalCommand(store, "a", "deploy\u001b[31m sk-123456789012345678901234567890", 1000);
    const objective = store.readGoal("a").goal?.objective ?? "";
    expect(objective).not.toContain("\u001b");
    expect(objective).not.toContain("sk-123456789012345678901234567890");
  });

  it("invalidates stale work when paused, cleared, or replaced", () => {
    runGoalCommand(store, "a", "first", 1000);
    expect(isGoalRevisionCurrent(store, "a", 1)).toBe(true);
    runGoalCommand(store, "a", "pause", 1100);
    expect(isGoalRevisionCurrent(store, "a", 1)).toBe(false);
    expect(isGoalRevisionCurrent(store, "a", 2)).toBe(false);
    runGoalCommand(store, "a", "resume", 1200);
    expect(isGoalRevisionCurrent(store, "a", 3)).toBe(true);
    runGoalCommand(store, "a", "clear", 1300);
    expect(isGoalRevisionCurrent(store, "a", 3)).toBe(false);
    runGoalCommand(store, "a", "second", 1400);
    expect(isGoalRevisionCurrent(store, "a", 4)).toBe(false);
    expect(isGoalRevisionCurrent(store, "a", 5)).toBe(true);
  });
});
