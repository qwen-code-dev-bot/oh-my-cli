import { describe, it, expect } from "vitest";
import {
  SubagentManager,
  formatSubagentView,
  SubagentSpawnCapError,
  SubagentBudgetError,
} from "../../src/subagents.js";

// End-to-end lifecycle scenarios that exercise the manager the way a parent
// agent would: spawn several bounded children, observe them, cancel one, and
// confirm the parent and siblings are unaffected. All timing is driven by
// deferred promises (no real timers) so races are deterministic.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Integration: subagent lifecycle dogfood", () => {
  it("cancels one child while its sibling and the parent finish normally", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 4 });
    const keep = deferred<string>();
    const drop = deferred<string>();

    const keeper = mgr.spawn(() => keep.promise, { label: "keeper" });
    const victim = mgr.spawn(() => drop.promise, { label: "victim" });

    expect(mgr.get(keeper)?.state).toBe("running");
    expect(mgr.get(victim)?.state).toBe("running");

    // Cancel only the victim; the keeper keeps running.
    expect(mgr.cancel(victim)).toBe(true);
    expect(mgr.get(victim)?.state).toBe("cancelled");
    expect(mgr.get(keeper)?.state).toBe("running");

    // The victim's worker still resolves late — output must be dropped.
    drop.resolve("victim late output");
    // The keeper resolves for real — it must complete.
    keep.resolve("keeper result");
    await flush();

    expect(mgr.get(victim)?.state).toBe("cancelled");
    expect(mgr.get(victim)?.result).toBeUndefined();
    expect(mgr.get(keeper)?.state).toBe("completed");
    expect(mgr.get(keeper)?.result).toBe("keeper result");

    const counts = mgr.counts();
    expect(counts.completed).toBe(1);
    expect(counts.cancelled).toBe(1);
    expect(counts.running).toBe(0);

    const view = formatSubagentView(mgr.list());
    expect(view).toContain("✓ sub-001 completed keeper — keeper result");
    expect(view).toContain("⊘ sub-002 cancelled victim");
  });

  it("propagates the abort signal so a cooperative worker stops early", async () => {
    const mgr = new SubagentManager();
    const events: string[] = [];
    const gate = deferred<string>();

    const id = mgr.spawn(async (signal) => {
      events.push("started");
      // A cooperative worker races its real work against the abort signal.
      const abort = new Promise<"aborted">((resolve) => {
        if (signal.aborted) resolve("aborted");
        else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const winner = await Promise.race([gate.promise, abort]);
      events.push(winner);
      return winner;
    }, { label: "cooperative" });

    expect(mgr.get(id)?.state).toBe("running");
    mgr.cancel(id);
    // Let the abort listener and the race settle.
    await flush();

    expect(events).toEqual(["started", "aborted"]);
    expect(mgr.get(id)?.state).toBe("cancelled");

    // Even if the real work later resolves, the settled guard keeps it dropped.
    gate.resolve("work finished");
    await flush();
    expect(mgr.get(id)?.state).toBe("cancelled");
    expect(mgr.get(id)?.result).toBeUndefined();
  });

  it("drains a backlog through a single slot, cancelling a middle child", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 1 });
    const a = deferred<string>();
    const order: string[] = [];

    const idA = mgr.spawn(() => a.promise, { label: "A" });
    const idB = mgr.spawn(async () => {
      order.push("B");
      return "B";
    }, { label: "B" });
    const idC = mgr.spawn(async () => {
      order.push("C");
      return "C";
    }, { label: "C" });

    expect(mgr.get(idA)?.state).toBe("running");
    expect(mgr.get(idB)?.state).toBe("queued");
    expect(mgr.get(idC)?.state).toBe("queued");

    // Cancel the middle queued child before A finishes.
    expect(mgr.cancel(idB)).toBe(true);
    expect(mgr.get(idB)?.state).toBe("cancelled");

    // Finish A; C should be promoted (B was cancelled and must never run).
    a.resolve("A");
    await flush();

    expect(mgr.get(idA)?.state).toBe("completed");
    expect(mgr.get(idB)?.state).toBe("cancelled");
    expect(mgr.get(idC)?.state).toBe("completed");
    expect(order).toEqual(["C"]); // B never ran

    const counts = mgr.counts();
    expect(counts.completed).toBe(2);
    expect(counts.cancelled).toBe(1);
  });

  it("isolates a failing child from a healthy sibling", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 2 });
    const ok = deferred<string>();
    const bad = deferred<string>();

    const goodId = mgr.spawn(() => ok.promise, { label: "good" });
    const badId = mgr.spawn(() => bad.promise, { label: "bad" });

    bad.reject(new Error("child crashed"));
    ok.resolve("child ok");
    await flush();

    expect(mgr.get(badId)?.state).toBe("failed");
    expect(mgr.get(badId)?.error).toBe("child crashed");
    expect(mgr.get(goodId)?.state).toBe("completed");
    expect(mgr.get(goodId)?.result).toBe("child ok");
  });
});

describe("Integration: subagent spawn cap dogfood", () => {
  it("a run within the ceiling completes unchanged", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 4, maxTotalSpawns: 3 });
    const a = deferred<string>();
    const b = deferred<string>();
    const idA = mgr.spawn(() => a.promise, { label: "alpha" });
    const idB = mgr.spawn(() => b.promise, { label: "beta" });

    a.resolve("alpha done");
    b.resolve("beta done");
    await flush();

    expect(mgr.get(idA)?.state).toBe("completed");
    expect(mgr.get(idB)?.state).toBe("completed");
    expect(mgr.counts().completed).toBe(2);
  });

  it("fails closed at the ceiling and reports a bounded, content-free reason", async () => {
    const mgr = new SubagentManager({ maxConcurrent: 2, maxTotalSpawns: 2 });
    const a = deferred<string>();
    const b = deferred<string>();
    mgr.spawn(() => a.promise, { label: "alpha" });
    mgr.spawn(() => b.promise, { label: "beta" });

    // A runaway delegation attempt beyond the ceiling fails closed.
    let err: unknown;
    try {
      mgr.spawn(() => deferred<string>().promise, {
        label: "SECRET=abc123 /home/user run rm",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SubagentSpawnCapError);
    expect((err as SubagentSpawnCapError).reason).toBe("spawn_cap");

    // The bounded reason a headless run would report: deterministic, and free
    // of the spawn attempt's label, secrets, or host paths.
    const reason = (err as Error).message;
    expect(reason).toContain("session subagent cap of 2 reached");
    expect(reason).not.toContain("SECRET");
    expect(reason).not.toContain("/home/user");
    expect(reason).not.toContain("run rm");

    // The summary surface shows only the two registered children — the refused
    // spawn added nothing and leaked nothing.
    a.resolve("alpha done");
    b.resolve("beta done");
    await flush();
    const view = formatSubagentView(mgr.list());
    expect(view).toContain("alpha");
    expect(view).toContain("beta");
    expect(view).not.toContain("SECRET");
    expect(view).toMatch(/2 total/);
  });

  it("enforces a shared cost budget across delegated children, failing closed once exhausted", async () => {
    // A parent delegates research children that each report a cost. The shared
    // budget bounds their aggregate cost; once exhausted, further delegation is
    // refused fail-closed even though the spawn-count ceiling is nowhere near.
    const mgr = new SubagentManager({ maxConcurrent: 4, maxTotalSpawns: 100, maxTotalCost: 1.0 });

    const a = deferred<string>();
    const b = deferred<string>();
    mgr.spawn(() => a.promise, { label: "researcher-1", mode: "read-only" });
    mgr.spawn(() => b.promise, { label: "researcher-2", mode: "read-only" });

    // Both children complete and report their cost (0.6 + 0.4 = 1.0).
    a.resolve("found X");
    b.resolve("found Y");
    await flush();
    mgr.addCost(0.6);
    mgr.addCost(0.4);
    expect(mgr.costUsage()).toEqual({ cumulativeCost: 1.0, maxTotalCost: 1.0, remaining: 0 });

    // The next delegation is refused fail-closed by the shared budget — even
    // though only 2 of 100 spawns are used.
    let err: unknown;
    try {
      mgr.spawn(() => deferred<string>().promise, { label: "researcher-3", mode: "read-only" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SubagentBudgetError);
    expect((err as SubagentBudgetError).reason).toBe("shared_budget");
    const reason = (err as Error).message;
    expect(reason).toContain("shared cost budget of 1 exhausted");
    expect(reason).not.toContain("researcher-3");

    // The parent and its completed children are unaffected; the refused spawn
    // registered nothing.
    expect(mgr.list()).toHaveLength(2);
    expect(mgr.get("sub-001")?.state).toBe("completed");
    expect(mgr.get("sub-002")?.state).toBe("completed");
  });
});
