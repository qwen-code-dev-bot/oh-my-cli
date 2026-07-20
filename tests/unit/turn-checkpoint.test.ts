import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TurnImageCollector,
  buildTurnCheckpoint,
  loadTurnLog,
  appendCheckpoint,
  latestCheckpoint,
  planUndo,
  planRedo,
  applyUndo,
  applyRedo,
  formatTurnPlan,
} from "../../src/turn-checkpoint.js";
import { Workspace } from "../../src/workspace.js";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage, SessionMeta } from "../../src/session.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const sys: SessionMessage = { role: "system", content: "sys" };
const user: SessionMessage = { role: "user", content: "do it" };
const assistant = (text: string): SessionMessage => ({ role: "assistant", content: text });
const META: SessionMeta = { meta: true, model: "m", workspace: "/unused", createdAt: 1 };

function setup(): { ws: Workspace; store: SessionStore; wsDir: string; sessDir: string } {
  const wsDir = tmp();
  const sessDir = tmp();
  return { ws: new Workspace(wsDir), store: new SessionStore(sessDir), wsDir, sessDir };
}

// Simulate one completed agent turn end-to-end: seed the session with the
// pre-turn transcript plus the turn's messages, capture each file's pre-image
// before mutating it (as the agent loop does), then build and persist the
// checkpoint exactly like index.ts.
function runTurn(opts: {
  ws: Workspace;
  store: SessionStore;
  sessionId: string;
  before: SessionMessage[];
  turn: SessionMessage[];
  mutate: (collector: TurnImageCollector) => void;
  head?: string | null;
}): void {
  const { ws, store, sessionId, before, turn, mutate, head = null } = opts;
  store.checkpoint(sessionId, [...before, ...turn], { ...META, workspace: ws.root });
  const collector = new TurnImageCollector();
  mutate(collector);
  const log = loadTurnLog(store, sessionId);
  const cp = buildTurnCheckpoint(collector, {
    workspace: ws,
    sessionId,
    turnIndex: log.checkpoints.length,
    messageCountBefore: before.length,
    messages: turn,
    head,
  });
  if (cp) appendCheckpoint(store, sessionId, cp);
}

describe("turn-checkpoint engine", () => {
  it("undo removes a turn-created file and its messages; redo restores them", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-clean";
    const file = path.join(wsDir, "new.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("done")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "hello");
      },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("hello");

    // Planning is non-destructive (preview before confirmation).
    const dryPlan = planUndo(loadTurnLog(store, id), store, ws);
    expect(dryPlan.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("hello");

    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load(id)).toEqual([sys, user]);
    expect(undo.receipt?.op).toBe("undo");

    // Idempotent: re-undoing an undone turn fails closed and changes nothing.
    const again = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(again.ok).toBe(false);
    expect(store.load(id)).toEqual([sys, user]);

    const redo = applyRedo(loadTurnLog(store, id), store, ws, id);
    expect(redo.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(store.load(id)).toEqual([sys, user, assistant("done")]);
  });

  it("undo restores a pre-existing file's content, preserving user work (dirty-before-turn)", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-dirty";
    const file = path.join(wsDir, "config.txt");
    fs.writeFileSync(file, "user-original");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("edited")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "agent-overwrite");
      },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("agent-overwrite");
    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.ok).toBe(true);
    // Restored to the user's pre-image, not deleted.
    expect(fs.readFileSync(file, "utf8")).toBe("user-original");
  });

  it("undo restores a file the turn deleted", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-deleted";
    const file = path.join(wsDir, "gone.txt");
    fs.writeFileSync(file, "precious");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("deleted it")],
      mutate: (c) => {
        c.capture(file);
        fs.rmSync(file);
      },
    });
    expect(fs.existsSync(file)).toBe(false);
    const plan = planUndo(loadTurnLog(store, id), store, ws);
    expect(plan.ok).toBe(true);
    expect(plan.fileOps[0]?.action).toBe("restore");
    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("precious");
  });

  it("fails closed when a turn-owned file diverged, leaving workspace AND transcript unchanged", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-diverge";
    const file = path.join(wsDir, "f.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "after");
      },
    });
    fs.writeFileSync(file, "external-change");
    const transcriptBefore = store.load(id);
    const plan = planUndo(loadTurnLog(store, id), store, ws);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/diverged/);
    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("external-change");
    expect(store.load(id)).toEqual(transcriptBefore);
  });

  it("fails closed when a turn-owned file is in a conflicted state", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-conflict";
    const file = path.join(wsDir, "merge.txt");
    const conflict = "line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, conflict);
      },
    });
    const plan = planUndo(loadTurnLog(store, id), store, ws);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/conflict/i);
  });

  it("works without Git (head recorded as null)", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-nogit";
    const file = path.join(wsDir, "n.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v");
      },
      head: null,
    });
    expect(latestCheckpoint(loadTurnLog(store, id))?.head).toBeNull();
    expect(applyUndo(loadTurnLog(store, id), store, ws, id).ok).toBe(true);
  });

  it("persists the checkpoint durably so undo works after a restart", () => {
    const { ws, store, wsDir, sessDir } = setup();
    const id = "sess-restart";
    const file = path.join(wsDir, "r.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v1");
      },
    });
    // A brand-new store over the same sessions directory (simulated restart).
    const store2 = new SessionStore(sessDir);
    const log = loadTurnLog(store2, id);
    expect(log.checkpoints).toHaveLength(1);
    const undo = applyUndo(log, store2, ws, id);
    expect(undo.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("redo fails closed when the turn is not undone", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-redo-notundone";
    const file = path.join(wsDir, "z.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v");
      },
    });
    const redo = applyRedo(loadTurnLog(store, id), store, ws, id);
    expect(redo.ok).toBe(false);
    expect(redo.reason).toMatch(/not undone/);
  });

  it("redo fails closed when the workspace diverged after undo", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-redo-diverge";
    const file = path.join(wsDir, "rd.txt");
    fs.writeFileSync(file, "before-content");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "after-content");
      },
    });
    expect(applyUndo(loadTurnLog(store, id), store, ws, id).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("before-content");
    fs.writeFileSync(file, "someone-else");
    const redo = applyRedo(loadTurnLog(store, id), store, ws, id);
    expect(redo.ok).toBe(false);
    expect(redo.reason).toMatch(/diverged/);
    expect(fs.readFileSync(file, "utf8")).toBe("someone-else");
  });

  it("fails closed when there is no turn to undo", () => {
    const { ws, store } = setup();
    const plan = planUndo(loadTurnLog(store, "empty"), store, ws);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/no turn/);
  });

  it("returns null for a turn that changed nothing", () => {
    const { ws, store } = setup();
    const cp = buildTurnCheckpoint(new TurnImageCollector(), {
      workspace: ws,
      sessionId: "x",
      turnIndex: 0,
      messageCountBefore: 0,
      messages: [],
      head: null,
    });
    expect(cp).toBeNull();
  });

  it("does not record a file the turn touched but did not change", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-unchanged";
    const file = path.join(wsDir, "same.txt");
    fs.writeFileSync(file, "same");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
      },
    });
    const cp = latestCheckpoint(loadTurnLog(store, id));
    expect(cp).not.toBeNull();
    expect(cp?.files).toHaveLength(0);
  });

  it("undo of the first turn empties the session (system seed included)", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-first";
    const file = path.join(wsDir, "first.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [],
      turn: [sys, user, assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v");
      },
    });
    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.ok).toBe(true);
    expect(store.load(id)).toEqual([]);
  });

  it("records a receipt tied to the exact checkpoint digest", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-receipt";
    const file = path.join(wsDir, "rec.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v");
      },
    });
    const cp = latestCheckpoint(loadTurnLog(store, id));
    const undo = applyUndo(loadTurnLog(store, id), store, ws, id);
    expect(undo.receipt?.digest).toBe(cp?.digest);
    expect(undo.receipt?.turnIndex).toBe(cp?.turnIndex);
    const log = loadTurnLog(store, id);
    expect(log.receipts).toHaveLength(1);
    expect(log.undoneTurnIndex).toBe(cp?.turnIndex);
  });

  it("formats a human-readable undo preview", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-fmt";
    const file = path.join(wsDir, "a.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x"), assistant("y")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "v");
      },
    });
    const text = formatTurnPlan(planUndo(loadTurnLog(store, id), store, ws));
    expect(text).toContain("Undo turn #0");
    expect(text).toContain("a.txt");
    expect(text).toContain("remove 2 message(s)");
  });

  it("formats the fail-closed reason for a diverged turn", () => {
    const { ws, store, wsDir } = setup();
    const id = "sess-fmt-fail";
    const file = path.join(wsDir, "b.txt");
    runTurn({
      ws,
      store,
      sessionId: id,
      before: [sys, user],
      turn: [assistant("x")],
      mutate: (c) => {
        c.capture(file);
        fs.writeFileSync(file, "after");
      },
    });
    fs.writeFileSync(file, "changed");
    const text = formatTurnPlan(planUndo(loadTurnLog(store, id), store, ws));
    expect(text).toContain("Cannot undo");
  });
});
