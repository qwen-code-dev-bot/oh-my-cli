import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import {
  GOAL_STATUS_SCHEMA,
  GOAL_STATUS_VERSION,
  buildGoalStatusRecord,
  formatGoalStatus,
} from "../../src/goal-status.js";

const ANSI = /\x1b\[/;
const NOW = 1_785_200_000_000;

describe("goal status record (Issue #578)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-578u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("renders an active goal with objective, ISO timestamps, and revision", () => {
    store.writeGoal(sessionId, {
      revision: 3,
      goal: { objective: "ship the widget", status: "active", createdAt: NOW, updatedAt: NOW + 1000 },
    });
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.schema).toBe(GOAL_STATUS_SCHEMA);
    expect(record.v).toBe(GOAL_STATUS_VERSION);
    expect(record.sessionId).toBe(sessionId);
    expect(record.hasGoal).toBe(true);
    expect(record.goal).toEqual({
      status: "active",
      objective: "ship the widget",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW + 1000).toISOString(),
      revision: 3,
    });
  });

  it("reports paused and achieved statuses as stored", () => {
    for (const status of ["paused", "achieved"] as const) {
      store.writeGoal(sessionId, {
        revision: 2,
        goal: { objective: "an objective", status, createdAt: NOW, updatedAt: NOW },
      });
      expect(buildGoalStatusRecord(store, sessionId).goal?.status).toBe(status);
    }
  });

  it("reports the honest no-goal state when no sidecar exists", () => {
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.hasGoal).toBe(false);
    expect(record.goal).toBeNull();
  });

  it("reports the honest no-goal state for a corrupt sidecar, preserving the bytes", () => {
    fs.writeFileSync(store.goalPath(sessionId), "{ not json");
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.hasGoal).toBe(false);
    expect(record.goal).toBeNull();
    expect(fs.readFileSync(store.goalPath(sessionId), "utf8")).toBe("{ not json");
  });

  it("redacts secret-shaped objectives at render time (defense in depth)", () => {
    const secret = ["ghp", "_", "g".repeat(24)].join("");
    // Write a raw sidecar bypassing safeObjective to prove render-time redaction.
    fs.writeFileSync(
      store.goalPath(sessionId),
      JSON.stringify({
        revision: 1,
        goal: { objective: `deploy with ${secret}`, status: "active", createdAt: NOW, updatedAt: NOW },
      }) + "\n",
    );
    const record = buildGoalStatusRecord(store, sessionId);
    expect(record.goal?.objective).not.toContain(secret);
    expect(record.goal?.objective).toContain("[REDACTED]");
    expect(formatGoalStatus(record).join("\n")).not.toContain(secret);
  });
});

describe("goal status rendering (Issue #578)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-578r-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("renders every goal field, ANSI-free and deterministically", () => {
    store.writeGoal(sessionId, {
      revision: 5,
      goal: { objective: "finish the migration", status: "active", createdAt: NOW, updatedAt: NOW + 500 },
    });
    const record = buildGoalStatusRecord(store, sessionId);
    const text = formatGoalStatus(record).join("\n");
    expect(text).toContain("Goal status");
    expect(text).toContain(sessionId.slice(0, 8));
    expect(text).toContain("status:    active");
    expect(text).toContain("objective: finish the migration");
    expect(text).toContain(`set:       ${new Date(NOW).toISOString()}`);
    expect(text).toContain(`updated:   ${new Date(NOW + 500).toISOString()}`);
    expect(text).toContain("revision:  5");
    expect(text).not.toMatch(ANSI);
    expect(formatGoalStatus(record).join("\n")).toBe(text);
  });

  it("renders the explicit no-goal state", () => {
    const text = formatGoalStatus(buildGoalStatusRecord(store, sessionId)).join("\n");
    expect(text).toContain("No goal recorded for this session.");
  });
});
