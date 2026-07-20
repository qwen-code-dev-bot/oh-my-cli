import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  GoalStore,
  parseGoalCommand,
  describeObjective,
  formatGoalStatus,
  runGoalCommand,
  GOAL_USAGE,
} from "../../src/goal.js";

const FIXED = new Date("2026-07-20T06:00:00.000Z");
const LATER = new Date("2026-07-20T07:30:00.000Z");

describe("parseGoalCommand", () => {
  it("treats empty input as help", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "help" });
    expect(parseGoalCommand("   ")).toEqual({ kind: "help" });
  });

  it("recognizes control subcommands case-insensitively", () => {
    expect(parseGoalCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("STATUS")).toEqual({ kind: "status" });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("help")).toEqual({ kind: "help" });
  });

  it("treats any other text as the objective, trimmed", () => {
    expect(parseGoalCommand("  Ship the release  ")).toEqual({
      kind: "set",
      objective: "Ship the release",
    });
  });

  it("does not let a reserved word swallow a longer objective", () => {
    // "status page" is an objective, not the status subcommand.
    expect(parseGoalCommand("status page")).toEqual({
      kind: "set",
      objective: "status page",
    });
    expect(parseGoalCommand("pause for thought")).toEqual({
      kind: "set",
      objective: "pause for thought",
    });
  });
});

describe("describeObjective (redaction + terminal safety)", () => {
  it("redacts secret-like values while keeping the surrounding text", () => {
    expect(describeObjective("deploy with --password=hunter2 now")).toBe(
      "deploy with --password=[REDACTED] now",
    );
  });

  it("neutralizes spoofing Unicode into a visible marker", () => {
    expect(describeObjective("a\u202Eb")).toBe("a[U+202E]b");
  });

  it("leaves ordinary text untouched", () => {
    expect(describeObjective("Refactor the session store")).toBe(
      "Refactor the session store",
    );
  });
});

describe("formatGoalStatus", () => {
  it("guides the user when there is no goal", () => {
    expect(formatGoalStatus(null)).toContain("No active goal");
    expect(formatGoalStatus(null)).toContain("/goal <objective>");
  });

  it("shows an active goal with its timestamps", () => {
    const out = formatGoalStatus({
      objective: "Ship it",
      status: "active",
      setAt: FIXED.toISOString(),
      updatedAt: FIXED.toISOString(),
      token: 1,
    });
    expect(out).toContain("Goal [active]: Ship it");
    expect(out).toContain(FIXED.toISOString());
    expect(out).not.toContain("resume");
  });

  it("flags a paused goal with a resume hint and redacts the objective", () => {
    const out = formatGoalStatus({
      objective: "use --token=supersecret",
      status: "paused",
      setAt: FIXED.toISOString(),
      updatedAt: LATER.toISOString(),
      token: 2,
    });
    expect(out).toContain("[paused]");
    expect(out).toContain("/goal resume");
    expect(out).toContain("--token=[REDACTED]");
    expect(out).not.toContain("supersecret");
  });
});

describe("GoalStore lifecycle", () => {
  let dir: string;
  let store: GoalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-goal-"));
    store = new GoalStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no goal is set", () => {
    expect(store.get("s1")).toBeNull();
  });

  it("sets an active goal and records setAt", () => {
    const g = store.set("s1", "Build the feature", FIXED);
    expect(g).toEqual({
      objective: "Build the feature",
      status: "active",
      setAt: FIXED.toISOString(),
      updatedAt: FIXED.toISOString(),
      token: 1,
    });
    expect(store.get("s1")).toEqual(g);
  });

  it("replaces an existing goal, bumping the token and resetting setAt", () => {
    store.set("s1", "First", FIXED);
    const g = store.set("s1", "Second", LATER);
    expect(g.objective).toBe("Second");
    expect(g.token).toBe(2);
    expect(g.setAt).toBe(LATER.toISOString());
  });

  it("pauses and resumes, bumping the token each transition", () => {
    store.set("s1", "Goal", FIXED);
    const paused = store.pause("s1", LATER)!;
    expect(paused.status).toBe("paused");
    expect(paused.token).toBe(2);
    expect(paused.setAt).toBe(FIXED.toISOString()); // setAt preserved
    expect(paused.updatedAt).toBe(LATER.toISOString());

    const resumed = store.resume("s1", LATER)!;
    expect(resumed.status).toBe("active");
    expect(resumed.token).toBe(3);
  });

  it("treats pause/resume as idempotent no-ops when already in that state", () => {
    store.set("s1", "Goal", FIXED);
    const paused = store.pause("s1", LATER)!;
    const pausedAgain = store.pause("s1", LATER)!;
    expect(pausedAgain).toEqual(paused); // no token bump

    const resumed = store.resume("s1")!;
    const resumedAgain = store.resume("s1")!;
    expect(resumedAgain).toEqual(resumed);
  });

  it("pause/resume return null when there is no goal", () => {
    expect(store.pause("s1")).toBeNull();
    expect(store.resume("s1")).toBeNull();
  });

  it("clears the goal so get returns null", () => {
    store.set("s1", "Goal", FIXED);
    store.clear("s1");
    expect(store.get("s1")).toBeNull();
    // Clearing again is safe.
    expect(() => store.clear("s1")).not.toThrow();
  });

  it("tolerates a corrupt sidecar by reporting no goal", () => {
    fs.writeFileSync(store.filePath("s1"), "{ not valid json", "utf-8");
    expect(store.get("s1")).toBeNull();
  });

  it("writes atomically, leaving no temp file behind", () => {
    store.set("s1", "Goal", FIXED);
    expect(fs.existsSync(store.filePath("s1"))).toBe(true);
    expect(fs.existsSync(store.filePath("s1") + ".tmp")).toBe(false);
  });
});

describe("GoalStore persistence and isolation (Issue #189 criteria 3 & 4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-goal-persist-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores the goal after a simulated restart (new store instance)", () => {
    new GoalStore(dir).set("s1", "Survive restart", FIXED);
    // A fresh process re-opens the same directory.
    const reopened = new GoalStore(dir);
    expect(reopened.get("s1")).toMatchObject({
      objective: "Survive restart",
      status: "active",
    });
  });

  it("does not inherit a goal across sessions", () => {
    const store = new GoalStore(dir);
    store.set("session-A", "A's goal", FIXED);
    expect(store.get("session-B")).toBeNull();
  });

  it("invalidates stale in-flight progress after pause, replace, and clear", () => {
    const store = new GoalStore(dir);
    const goal = store.set("s1", "Original", FIXED);
    const captured = goal.token;
    expect(store.isStale("s1", captured)).toBe(false);

    // Pausing advances the token: an older result is now stale.
    store.pause("s1", LATER);
    expect(store.isStale("s1", captured)).toBe(true);

    // Resuming then replacing also invalidates the original capture.
    store.resume("s1");
    store.set("s1", "Replaced", LATER);
    expect(store.isStale("s1", captured)).toBe(true);

    // Clearing is the strongest invalidation.
    store.clear("s1");
    expect(store.isStale("s1", captured)).toBe(true);
  });
});

describe("runGoalCommand feedback", () => {
  let dir: string;
  let store: GoalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-goal-run-"));
    store = new GoalStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a set goal", () => {
    const r = runGoalCommand(store, "s1", { kind: "set", objective: "Ship it" }, FIXED);
    expect(r.feedback).toBe("Goal set: Ship it");
    expect(r.goal?.objective).toBe("Ship it");
  });

  it("redacts a secret in the set feedback", () => {
    const r = runGoalCommand(
      store,
      "s1",
      { kind: "set", objective: "rotate --token=supersecret" },
      FIXED,
    );
    expect(r.feedback).toContain("--token=[REDACTED]");
    expect(r.feedback).not.toContain("supersecret");
  });

  it("shows usage for help and status when no goal exists", () => {
    expect(runGoalCommand(store, "s1", { kind: "help" }).feedback).toBe(GOAL_USAGE);
    expect(runGoalCommand(store, "s1", { kind: "status" }).feedback).toContain(
      "No active goal",
    );
  });

  it("guides the user when pausing/resuming with no goal", () => {
    expect(runGoalCommand(store, "s1", { kind: "pause" }).feedback).toContain(
      "No goal to pause",
    );
    expect(runGoalCommand(store, "s1", { kind: "resume" }).feedback).toContain(
      "No goal to resume",
    );
  });

  it("pauses, resumes, and clears an existing goal with feedback", () => {
    runGoalCommand(store, "s1", { kind: "set", objective: "Goal" }, FIXED);
    expect(runGoalCommand(store, "s1", { kind: "pause" }, LATER).feedback).toBe(
      "Goal paused: Goal",
    );
    expect(runGoalCommand(store, "s1", { kind: "resume" }, LATER).feedback).toBe(
      "Goal resumed: Goal",
    );
    const cleared = runGoalCommand(store, "s1", { kind: "clear" });
    expect(cleared.feedback).toContain("Goal cleared");
    expect(cleared.goal).toBeNull();
    expect(runGoalCommand(store, "s1", { kind: "clear" }).feedback).toContain(
      "No active goal to clear",
    );
  });
});
