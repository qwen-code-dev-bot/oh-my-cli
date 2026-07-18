import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SubagentManager,
  formatSubagentView,
  countByState,
  TERMINAL_SUBAGENT_STATES,
  SharedWorkspaceLaunchError,
  SubagentSpawnCapError,
} from "../../src/subagents.js";
import type { SubagentRecord } from "../../src/subagents.js";

// A deferred promise: lets a test hold a worker in the running state until the
// test chooses to resolve or reject it, so races are deterministic without
// real timers.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let any already-resolved promise callbacks (the settle .then) run.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SubagentManager: state transitions", () => {
  it("runs a worker to completion", async () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => "done");
    // Promoted to running synchronously on spawn.
    expect(mgr.get(id)?.state).toBe("running");
    await flush();
    const rec = mgr.get(id)!;
    expect(rec.state).toBe("completed");
    expect(rec.result).toBe("done");
    expect(rec.startedAt).not.toBeNull();
    expect(rec.finishedAt).not.toBeNull();
  });

  it("captures a worker failure without throwing", async () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => {
      throw new Error("boom");
    });
    await flush();
    const rec = mgr.get(id)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toBe("boom");
    expect(rec.result).toBeUndefined();
  });

  it("normalizes a non-Error rejection to a string message", async () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => {
      throw "stringly-typed";
    });
    await flush();
    expect(mgr.get(id)?.error).toBe("stringly-typed");
  });

  it("cancels a queued child before it ever runs", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 1 });
    const blocker = deferred<string>();
    const first = mgr.spawn(() => blocker.promise);
    let ran = false;
    const second = mgr.spawn(async () => {
      ran = true;
      return "should not happen";
    });
    // First occupies the only slot; second is queued.
    expect(mgr.get(first)?.state).toBe("running");
    expect(mgr.get(second)?.state).toBe("queued");

    expect(mgr.cancel(second)).toBe(true);
    expect(mgr.get(second)?.state).toBe("cancelled");

    // Free the slot; the cancelled child must not be promoted.
    blocker.resolve("ok");
    await flush();
    expect(ran).toBe(false);
    expect(mgr.get(second)?.state).toBe("cancelled");
    expect(mgr.get(first)?.state).toBe("completed");
  });

  it("cancels a running child and fires its abort signal", async () => {
    const mgr = new SubagentManager();
    let aborted = false;
    const d = deferred<string>();
    const id = mgr.spawn((signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return d.promise;
    });
    expect(mgr.get(id)?.state).toBe("running");

    expect(mgr.cancel(id)).toBe(true);
    expect(aborted).toBe(true);
    expect(mgr.get(id)?.state).toBe("cancelled");
  });

  it("drops late output from a cancelled running child", async () => {
    const mgr = new SubagentManager();
    const d = deferred<string>();
    const id = mgr.spawn(() => d.promise);
    expect(mgr.get(id)?.state).toBe("running");

    mgr.cancel(id);
    expect(mgr.get(id)?.state).toBe("cancelled");

    // The worker resolves AFTER cancellation; the result must be dropped.
    d.resolve("late result");
    await flush();
    const rec = mgr.get(id)!;
    expect(rec.state).toBe("cancelled");
    expect(rec.result).toBeUndefined();
  });

  it("drops a late failure from a cancelled running child", async () => {
    const mgr = new SubagentManager();
    const d = deferred<string>();
    const id = mgr.spawn(() => d.promise);
    mgr.cancel(id);
    d.reject(new Error("late failure"));
    await flush();
    const rec = mgr.get(id)!;
    expect(rec.state).toBe("cancelled");
    expect(rec.error).toBeUndefined();
  });

  it("returns false when cancelling an unknown or terminal id", async () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => "done");
    await flush();
    expect(mgr.get(id)?.state).toBe("completed");
    expect(mgr.cancel(id)).toBe(false);
    expect(mgr.cancel("sub-999")).toBe(false);
  });
});

describe("SubagentManager: bounded concurrency", () => {
  it("keeps children queued until a slot frees, then promotes in order", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 1 });
    const a = deferred<string>();
    const b = deferred<string>();
    const idA = mgr.spawn(() => a.promise, { label: "A" });
    const idB = mgr.spawn(() => b.promise, { label: "B" });
    const idC = mgr.spawn(async () => "C", { label: "C" });

    expect(mgr.get(idA)?.state).toBe("running");
    expect(mgr.get(idB)?.state).toBe("queued");
    expect(mgr.get(idC)?.state).toBe("queued");

    // Free A → B (next in insertion order) is promoted, not C.
    a.resolve("A done");
    await flush();
    expect(mgr.get(idA)?.state).toBe("completed");
    expect(mgr.get(idB)?.state).toBe("running");
    expect(mgr.get(idC)?.state).toBe("queued");

    // Free B → C runs and completes.
    b.resolve("B done");
    await flush();
    expect(mgr.get(idB)?.state).toBe("completed");
    expect(mgr.get(idC)?.state).toBe("completed");
  });

  it("promotes a queued child when a running sibling is cancelled", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 1 });
    const a = deferred<string>();
    const idA = mgr.spawn(() => a.promise);
    const idB = mgr.spawn(async () => "B");
    expect(mgr.get(idB)?.state).toBe("queued");

    mgr.cancel(idA);
    await flush();
    expect(mgr.get(idA)?.state).toBe("cancelled");
    expect(mgr.get(idB)?.state).toBe("completed");
  });

  it("runs up to maxConcurrent children at once", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 2 });
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d3 = deferred<string>();
    const id1 = mgr.spawn(() => d1.promise);
    const id2 = mgr.spawn(() => d2.promise);
    const id3 = mgr.spawn(() => d3.promise);

    expect(mgr.get(id1)?.state).toBe("running");
    expect(mgr.get(id2)?.state).toBe("running");
    expect(mgr.get(id3)?.state).toBe("queued");
    expect(mgr.counts().running).toBe(2);

    d1.resolve("1");
    d2.resolve("2");
    d3.resolve("3");
    await flush();
    expect(mgr.counts().completed).toBe(3);
  });
});

describe("SubagentManager: ids and validation", () => {
  it("assigns stable, sequential ids and preserves them across reads", () => {
    const mgr = new SubagentManager({ maxConcurrent: 1 });
    const d = deferred<string>();
    const id1 = mgr.spawn(() => d.promise);
    const id2 = mgr.spawn(async () => "x");
    expect(id1).toBe("sub-001");
    expect(id2).toBe("sub-002");
    // Id is stable regardless of state churn.
    expect(mgr.get(id1)?.id).toBe("sub-001");
    d.resolve("done");
  });

  it("falls back to the id as label when none is given", () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => "x");
    expect(mgr.get(id)?.label).toBe(id);
  });

  it("throws on a non-positive maxConcurrent", () => {
    expect(() => new SubagentManager({ maxConcurrent: 0 })).toThrow(/positive integer/);
    expect(() => new SubagentManager({ maxConcurrent: -1 })).toThrow(/positive integer/);
    expect(() => new SubagentManager({ maxConcurrent: 1.5 })).toThrow(/positive integer/);
  });

  it("throws when spawn is given a non-function worker", () => {
    const mgr = new SubagentManager();
    // Intentional misuse to verify the guard.
    expect(() => mgr.spawn(undefined as never)).toThrow(/worker must be a function/);
  });
});

describe("formatSubagentView", () => {
  it("renders an empty view", () => {
    const out = formatSubagentView([]);
    expect(out).toContain("Subagents");
    expect(out).toContain("No active or recent subagents.");
  });

  it("renders each state with its symbol and a summary line", () => {
    const records: SubagentRecord[] = [
      { id: "sub-001", label: "alpha", state: "running", startedAt: 0, finishedAt: null },
      { id: "sub-002", label: "beta", state: "queued", startedAt: null, finishedAt: null },
      { id: "sub-003", label: "gamma", state: "completed", startedAt: 0, finishedAt: 1500, result: "ok" },
      { id: "sub-004", label: "delta", state: "failed", startedAt: 0, finishedAt: 2000, error: "bad" },
      { id: "sub-005", label: "epsilon", state: "cancelled", startedAt: 0, finishedAt: 500 },
    ];
    const out = formatSubagentView(records);
    expect(out).toContain("⟳ sub-001 running alpha");
    expect(out).toContain("… sub-002 queued beta");
    expect(out).toContain("✓ sub-003 completed gamma — ok (1.5s)");
    expect(out).toContain("✗ sub-004 failed delta — bad (2.0s)");
    expect(out).toContain("⊘ sub-005 cancelled epsilon (0.5s)");
    expect(out).toMatch(/Summary: 1 running, 1 queued, 1 completed, 1 failed, 1 cancelled \(5 total\)/);
  });

  it("shows only the first line of a multi-line result", () => {
    const records: SubagentRecord[] = [
      { id: "sub-001", label: "x", state: "completed", startedAt: 0, finishedAt: 10, result: "first\nsecond\nthird" },
    ];
    const out = formatSubagentView(records);
    expect(out).toContain("— first");
    expect(out).not.toContain("second");
  });

  it("redacts secret-like values in labels and results", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const records: SubagentRecord[] = [
      { id: "sub-001", label: `deploy ${token}`, state: "completed", startedAt: 0, finishedAt: 10, result: `token=${token}` },
    ];
    const out = formatSubagentView(records);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts secret-like error messages", () => {
    const password = ["super", "secret", "pw"].join("");
    const records: SubagentRecord[] = [
      { id: "sub-001", label: "x", state: "failed", startedAt: 0, finishedAt: 10, error: `--password ${password}` },
    ];
    const out = formatSubagentView(records);
    expect(out).not.toContain(password);
    expect(out).toContain("[REDACTED]");
  });
});

describe("countByState", () => {
  it("counts records by state and exposes every state key", () => {
    const records: SubagentRecord[] = [
      { id: "a", label: "a", state: "running", startedAt: 0, finishedAt: null },
      { id: "b", label: "b", state: "running", startedAt: 0, finishedAt: null },
      { id: "c", label: "c", state: "completed", startedAt: 0, finishedAt: 1 },
    ];
    const counts = countByState(records);
    expect(counts.running).toBe(2);
    expect(counts.completed).toBe(1);
    expect(counts.queued).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.cancelled).toBe(0);
  });

  it("treats an empty list as all-zero counts", () => {
    const counts = countByState([]);
    for (const state of ["queued", "running", "completed", "failed", "cancelled"] as const) {
      expect(counts[state]).toBe(0);
    }
  });
});

describe("TERMINAL_SUBAGENT_STATES", () => {
  it("contains exactly the three terminal states", () => {
    expect([...TERMINAL_SUBAGENT_STATES].sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});

describe("SubagentManager: shared-workspace guard", () => {
  const dirs: string[] = [];
  const ws = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sub-ws-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("does nothing when no parent workspace is configured (backward compatible)", async () => {
    const mgr = new SubagentManager();
    const id = mgr.spawn(async () => "ok", { mode: "mutating", workspace: ws() });
    await flush();
    expect(mgr.get(id)?.state).toBe("completed");
  });

  it("refuses a mutating child that shares the parent workspace before its worker runs", () => {
    const parent = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent });
    let ran = false;
    expect(() =>
      mgr.spawn(
        async () => {
          ran = true;
          return "x";
        },
        { mode: "mutating", workspace: parent },
      ),
    ).toThrow(SharedWorkspaceLaunchError);
    expect(ran).toBe(false);
    // The launch was refused: no child was ever registered.
    expect(mgr.list()).toHaveLength(0);
  });

  it("defaults an unspecified child to mutating and refuses it in the shared workspace", () => {
    const parent = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent });
    // No mode/workspace ⇒ inherits the parent workspace and defaults to mutating.
    expect(() => mgr.spawn(async () => "x")).toThrow(/Refusing to launch a mutating delegated agent/);
  });

  it("allows a read-only child in the shared workspace and reports its mode", async () => {
    const parent = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent });
    const id = mgr.spawn(async () => "inspected", {
      mode: "read-only",
      workspace: parent,
      label: "scan",
    });
    await flush();
    const rec = mgr.get(id)!;
    expect(rec.state).toBe("completed");
    expect(rec.mode).toBe("read-only");
    expect(formatSubagentView(mgr.list())).toContain("[read-only] scan");
  });

  it("allows a mutating child in a genuinely different workspace", async () => {
    const parent = ws();
    const other = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent });
    const id = mgr.spawn(async () => "wrote", { mode: "mutating", workspace: other });
    await flush();
    expect(mgr.get(id)?.state).toBe("completed");
  });

  it("refuses two simultaneous mutating launches into the parent workspace", () => {
    const parent = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent, maxConcurrent: 2 });
    expect(() => mgr.spawn(async () => "a", { mode: "mutating", workspace: parent })).toThrow(
      SharedWorkspaceLaunchError,
    );
    expect(() => mgr.spawn(async () => "b", { mode: "mutating", workspace: parent })).toThrow(
      SharedWorkspaceLaunchError,
    );
    expect(mgr.list()).toHaveLength(0);
  });

  it("keeps cancellation working for an allowed read-only child", () => {
    const parent = ws();
    const mgr = new SubagentManager({ parentWorkspace: parent });
    const d = deferred<string>();
    const id = mgr.spawn(() => d.promise, { mode: "read-only", workspace: parent });
    expect(mgr.get(id)?.state).toBe("running");
    expect(mgr.cancel(id)).toBe(true);
    expect(mgr.get(id)?.state).toBe("cancelled");
  });
});

describe("SubagentManager: spawn cap", () => {
  it("spawns up to the ceiling then refuses the next", () => {
    const mgr = new SubagentManager({ maxConcurrent: 8, maxTotalSpawns: 3 });
    const ids = [
      mgr.spawn(() => deferred<string>().promise),
      mgr.spawn(() => deferred<string>().promise),
      mgr.spawn(() => deferred<string>().promise),
    ];
    expect(ids).toEqual(["sub-001", "sub-002", "sub-003"]);
    expect(() => mgr.spawn(() => deferred<string>().promise)).toThrow(SubagentSpawnCapError);
    // The refused spawn registered no child.
    expect(mgr.list()).toHaveLength(3);
  });

  it("an override raises the ceiling", () => {
    const mgr = new SubagentManager({ maxConcurrent: 16, maxTotalSpawns: 5 });
    for (let i = 0; i < 5; i++) mgr.spawn(() => deferred<string>().promise);
    expect(mgr.list()).toHaveLength(5);
    expect(() => mgr.spawn(() => deferred<string>().promise)).toThrow(SubagentSpawnCapError);
  });

  it("uses a high default ceiling that does not interfere with ordinary runs", () => {
    const mgr = new SubagentManager({ maxConcurrent: 64 });
    for (let i = 0; i < 50; i++) mgr.spawn(() => deferred<string>().promise);
    expect(mgr.list()).toHaveLength(50);
  });

  it("throws on a non-positive or non-integer maxTotalSpawns", () => {
    expect(() => new SubagentManager({ maxTotalSpawns: 0 })).toThrow(/positive integer/);
    expect(() => new SubagentManager({ maxTotalSpawns: -1 })).toThrow(/positive integer/);
    expect(() => new SubagentManager({ maxTotalSpawns: 1.5 })).toThrow(/positive integer/);
  });

  it("counts terminal children toward the ceiling (completed, failed, cancelled)", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 4, maxTotalSpawns: 3 });
    const ok = mgr.spawn(async () => "done");
    const bad = mgr.spawn(async () => {
      throw new Error("boom");
    });
    const cancelId = mgr.spawn(() => deferred<string>().promise);
    await flush();
    expect(mgr.get(ok)?.state).toBe("completed");
    expect(mgr.get(bad)?.state).toBe("failed");
    expect(mgr.cancel(cancelId)).toBe(true);
    // All three slots are consumed by terminal children; churn cannot evade it.
    expect(() => mgr.spawn(() => deferred<string>().promise)).toThrow(SubagentSpawnCapError);
    expect(mgr.list()).toHaveLength(3);
  });

  it("counts queued children too, independent of the concurrency bound", () => {
    const mgr = new SubagentManager({ maxConcurrent: 1, maxTotalSpawns: 3 });
    const a = mgr.spawn(() => deferred<string>().promise);
    const b = mgr.spawn(() => deferred<string>().promise);
    const c = mgr.spawn(() => deferred<string>().promise);
    expect(mgr.get(a)?.state).toBe("running");
    expect(mgr.get(b)?.state).toBe("queued");
    expect(mgr.get(c)?.state).toBe("queued");
    expect(() => mgr.spawn(() => deferred<string>().promise)).toThrow(SubagentSpawnCapError);
  });

  it("refuses with a deterministic, content-free reason (no secret/host/label leak)", () => {
    const mgr = new SubagentManager({ maxTotalSpawns: 1 });
    mgr.spawn(() => deferred<string>().promise, { label: "SECRET=abc123 /home/user/keys" });
    let err: unknown;
    try {
      mgr.spawn(() => deferred<string>().promise, { label: "leak this label" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SubagentSpawnCapError);
    expect((err as SubagentSpawnCapError).reason).toBe("spawn_cap");
    const msg = (err as Error).message;
    expect(msg).toContain("session subagent cap of 1 reached");
    expect(msg).not.toContain("leak this label");
    expect(msg).not.toContain("SECRET");
    expect(msg).not.toContain("/home/user");
  });
});
