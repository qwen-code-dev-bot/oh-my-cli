import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { GoalStore } from "../../src/goal.js";

// The goal is "persisted with the session" (Issue #189, criterion 3): its
// sidecar must live in the same sessions directory as the JSONL checkpoint, be
// restored when a session is reopened, stay isolated per session, and never leak
// into session enumeration. This exercises a real SessionStore and GoalStore
// sharing one directory across a simulated process restart.
describe("Integration: goal sidecar co-located with the session store", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-goal-int-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists beside the checkpoint, restores on reopen, and stays isolated", () => {
    const sessions = new SessionStore(dir);
    const goals = new GoalStore(dir);

    const id = sessions.newId();
    sessions.writeMeta(id, { model: "fake-model", workspace: "/tmp/ws", createdAt: 1 });
    sessions.append(id, { role: "user", content: "hello" });
    goals.set(id, "Land the goal");

    // The goal sidecar lives in the sessions directory but is not a session.
    expect(fs.existsSync(goals.filePath(id))).toBe(true);
    expect(path.dirname(goals.filePath(id))).toBe(path.dirname(sessions.filePath(id)));
    expect(sessions.listIds()).toEqual([id]); // *.goal.json excluded

    // Simulate a restart: brand-new store instances over the same directory.
    const reopenedSessions = new SessionStore(dir);
    const reopenedGoals = new GoalStore(dir);
    const messages = reopenedSessions.load(id).filter((m) => m.role !== "system");
    expect(messages.some((m) => m.content === "hello")).toBe(true);
    expect(reopenedGoals.get(id)).toMatchObject({
      objective: "Land the goal",
      status: "active",
    });

    // A different session does not inherit the goal.
    const other = reopenedSessions.newId();
    expect(reopenedGoals.get(other)).toBeNull();

    // Clearing removes the sidecar without disturbing the session checkpoint.
    reopenedGoals.clear(id);
    expect(reopenedGoals.get(id)).toBeNull();
    expect(reopenedSessions.load(id).length).toBeGreaterThan(0);
  });
});
