import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";
import {
  GOAL_CONTROL_SCHEMA,
  GOAL_CONTROL_VERSION,
  runGoalControl,
} from "../../src/goal-control.js";

const NOW = 1_785_700_000_000;

describe("headless goal control (Issue #582)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-582u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("matches runGoalCommand output exactly for every subcommand", () => {
    const cases = ["land the feature", "status", "pause", "resume", "achieve", "clear", ""];
    const mirrorStore = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "omc-582m-")));
    const mirrorId = mirrorStore.newId();
    mirrorStore.writeMeta(mirrorId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    mirrorStore.append(mirrorId, { role: "user", content: "hi" });
    for (const args of cases) {
      const expected = runGoalCommand(mirrorStore, mirrorId, args, NOW);
      const record = runGoalControl(store, sessionId, args, NOW);
      expect(record.output).toBe(expected);
      expect(record.schema).toBe(GOAL_CONTROL_SCHEMA);
      expect(record.v).toBe(GOAL_CONTROL_VERSION);
      expect(record.sessionId).toBe(sessionId);
    }
  });

  it("appends the #580 history through headless transitions", () => {
    runGoalControl(store, sessionId, "an objective", NOW);
    runGoalControl(store, sessionId, "pause", NOW + 1000);
    runGoalControl(store, sessionId, "resume", NOW + 2000);
    runGoalControl(store, sessionId, "achieve", NOW + 3000);
    const final = runGoalControl(store, sessionId, "status", NOW + 4000);
    expect(final.checkpoint.hasGoal).toBe(true);
    expect(final.checkpoint.goal?.status).toBe("achieved");
    expect(final.checkpoint.history.map((h) => h.kind)).toEqual([
      "achieve",
      "resume",
      "pause",
      "set",
    ]);
    expect(final.checkpoint.history.map((h) => h.revision)).toEqual([4, 3, 2, 1]);
  });

  it("respects runGoalCommand guards through the headless surface", () => {
    expect(runGoalControl(store, sessionId, "pause", NOW).output).toBe("Goal: nothing to pause");
    expect(runGoalControl(store, sessionId, "resume", NOW).output).toBe("Goal: nothing to resume");
    expect(runGoalControl(store, sessionId, "achieve", NOW).output).toBe("Goal: nothing to achieve");
    runGoalControl(store, sessionId, "objective", NOW);
    runGoalControl(store, sessionId, "achieve", NOW + 1000);
    // Achieved goals are terminal until cleared or replaced.
    expect(runGoalControl(store, sessionId, "pause", NOW + 2000).output).toContain("Goal: achieved");
  });

  it("redacts secret-shaped objectives in both output and checkpoint", () => {
    const secret = ["ghp", "_", "j".repeat(24)].join("");
    const record = runGoalControl(store, sessionId, `deploy with ${secret}`, NOW);
    expect(record.output).not.toContain(secret);
    expect(record.checkpoint.goal?.objective).not.toContain(secret);
    expect(record.checkpoint.goal?.objective).toContain("[REDACTED]");
    expect(record.checkpoint.history[0].objective).not.toContain(secret);
  });

  it("reports the honest no-goal state through status on a corrupt sidecar", () => {
    fs.writeFileSync(store.goalPath(sessionId), "{ not json");
    const record = runGoalControl(store, sessionId, "status", NOW);
    expect(record.output).toContain("Goal: none (revision 0)");
    expect(record.checkpoint.hasGoal).toBe(false);
    // Bytes preserved.
    expect(fs.readFileSync(store.goalPath(sessionId), "utf8")).toBe("{ not json");
  });

  it("clear appends rather than erases through the headless surface", () => {
    runGoalControl(store, sessionId, "objective", NOW);
    runGoalControl(store, sessionId, "clear", NOW + 1000);
    const after = runGoalControl(store, sessionId, "status", NOW + 2000);
    expect(after.checkpoint.hasGoal).toBe(false);
    expect(after.checkpoint.history.map((h) => h.kind)).toEqual(["clear", "set"]);
  });
});
