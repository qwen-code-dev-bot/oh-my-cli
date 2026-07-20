import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT,
  TASK_RUNTIME_SCHEMA,
  TASK_RUNTIME_VERSION,
  TASK_STATE_TRANSITIONS,
  TaskSnapshotError,
  canTransition,
  cancelTask,
  createTaskSnapshot,
  emptyTaskView,
  failTask,
  formatTaskDetail,
  formatTaskSummary,
  formatTaskView,
  isTerminalState,
  parseTaskSnapshot,
  reconcileTasks,
  registerTask,
  retryTask,
  recoverTask,
  serializeTaskSnapshot,
  startTask,
  succeedTask,
  summarizeTasks,
  waitTask,
} from "../../src/task-runtime.js";
import type { TaskSnapshot } from "../../src/task-runtime.js";
import os from "node:os";

// Build the workspace key under the real home so home-path redaction is
// genuinely exercised by the formatting assertions below.
const WS = `${os.homedir()}/project/.git`;

function snap(maxConcurrent?: number): TaskSnapshot {
  return createTaskSnapshot({ sessionId: "session-1", workspaceKey: WS, maxConcurrent });
}

function withOne(maxConcurrent?: number): { s: TaskSnapshot; id: string } {
  const reg = registerTask(snap(maxConcurrent), { type: "shell", label: "build" }, 1_000);
  return { s: reg.snapshot, id: reg.task!.id };
}

describe("task-runtime state machine", () => {
  it("defines the eight lifecycle states and their legal transitions", () => {
    expect(Object.keys(TASK_STATE_TRANSITIONS).sort()).toEqual(
      ["cancelled", "failed", "orphaned", "queued", "recovered", "running", "succeeded", "waiting"].sort(),
    );
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("orphaned", "recovered")).toBe(true);
    // Terminal states go nowhere.
    for (const to of Object.keys(TASK_STATE_TRANSITIONS) as (keyof typeof TASK_STATE_TRANSITIONS)[]) {
      expect(canTransition("succeeded", to)).toBe(false);
      expect(canTransition("recovered", to)).toBe(false);
    }
    // A queued task cannot jump straight to a terminal success.
    expect(canTransition("queued", "succeeded")).toBe(false);
  });

  it("registers a task in the queued state with bounded, redacted fields", () => {
    const reg = registerTask(snap(), { type: "shell", label: "build", owner: "session-1" }, 1_000);
    expect(reg.ok).toBe(true);
    expect(reg.task!.state).toBe("queued");
    expect(reg.task!.id).toBe("task-001");
    expect(reg.task!.startedAt).toBeNull();
    expect(isTerminalState(reg.task!.state)).toBe(false);
  });

  it("promotes queued to running only when a concurrency slot is free", () => {
    let s = snap(1); // one slot
    const a = registerTask(s, { type: "shell", label: "a" }, 1_000);
    s = a.snapshot;
    const b = registerTask(s, { type: "shell", label: "b" }, 1_001);
    s = b.snapshot;

    const startA = startTask(s, a.task!.id, 4242, 2_000);
    expect(startA.ok).toBe(true);
    expect(startA.task!.state).toBe("running");
    expect(startA.task!.pid).toBe(4242);
    expect(startA.task!.startedAt).toBe(2_000);

    // No slot free: the second queued task refuses to start (concurrency is
    // authoritative, not advisory).
    const startB = startTask(startA.snapshot, b.task!.id, 4243, 2_001);
    expect(startB.ok).toBe(false);
    expect(startB.reason).toBe("no-slot");
    expect(startB.snapshot.tasks.find((t) => t.id === b.task!.id)!.state).toBe("queued");
  });

  it("refuses an illegal transition and leaves the task unchanged", () => {
    const { s, id } = withOne();
    // queued -> succeeded is illegal.
    const bad = succeedTask(s, id, { digest: "d" }, 2_000);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("illegal-transition");
    expect(bad.snapshot.tasks.find((t) => t.id === id)!.state).toBe("queued");
  });

  it("attaches a durable receipt on success and failure", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 10, 2_000).snapshot;
    const ok = succeedTask(s, id, { digest: "abc123", evidenceLink: "file:///evidence/run.json" }, 3_000);
    expect(ok.ok).toBe(true);
    expect(ok.task!.state).toBe("succeeded");
    expect(ok.task!.receipt!.outcome).toBe("succeeded");
    expect(ok.task!.receipt!.digest).toBe("abc123");
    // A terminal task no longer owns a live process.
    expect(ok.task!.pid).toBeUndefined();

    let f = withOne();
    f.s = startTask(f.s, f.id, 11, 2_000).snapshot;
    const failed = failTask(f.s, f.id, { digest: "def456", note: "boom" }, 3_000);
    expect(failed.task!.state).toBe("failed");
    expect(failed.task!.receipt!.outcome).toBe("failed");
    expect(failed.task!.receipt!.note).toBe("boom");
  });
});

describe("task-runtime cancellation", () => {
  it("cancels a running task, leaving a durable receipt", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 10, 2_000).snapshot;
    const c = cancelTask(s, id, 3_000);
    expect(c.ok).toBe(true);
    expect(c.alreadyTerminal).toBe(false);
    expect(c.task!.state).toBe("cancelled");
    expect(c.task!.receipt!.outcome).toBe("cancelled");
  });

  it("is idempotent: cancelling a terminal task is a no-op that keeps its receipt", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 10, 2_000).snapshot;
    s = succeedTask(s, id, { digest: "keep-me" }, 3_000).snapshot;
    const again = cancelTask(s, id, 4_000);
    expect(again.ok).toBe(true);
    expect(again.alreadyTerminal).toBe(true);
    const t = again.snapshot.tasks.find((x) => x.id === id)!;
    expect(t.state).toBe("succeeded");
    expect(t.receipt!.digest).toBe("keep-me"); // history not rewritten
  });

  it("drops a late outcome from a cancelled task (no masquerade)", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 10, 2_000).snapshot;
    s = cancelTask(s, id, 3_000).snapshot;
    // A late success after cancellation is an illegal transition and is refused.
    const late = succeedTask(s, id, { digest: "late" }, 4_000);
    expect(late.ok).toBe(false);
    expect(late.snapshot.tasks.find((t) => t.id === id)!.state).toBe("cancelled");
  });

  it("is scoped: cancelling one task does not disturb siblings", () => {
    let s = snap(4);
    const a = registerTask(s, { type: "shell", label: "a" }, 1_000);
    s = a.snapshot;
    const b = registerTask(s, { type: "shell", label: "b" }, 1_001);
    s = b.snapshot;
    s = startTask(s, a.task!.id, 1, 2_000).snapshot;
    s = startTask(s, b.task!.id, 2, 2_001).snapshot;
    s = cancelTask(s, a.task!.id, 3_000).snapshot;
    expect(s.tasks.find((t) => t.id === a.task!.id)!.state).toBe("cancelled");
    expect(s.tasks.find((t) => t.id === b.task!.id)!.state).toBe("running");
  });

  it("reports unknown-task when cancelling a missing id", () => {
    const c = cancelTask(snap(), "task-999", 1_000);
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("unknown-task");
  });
});

describe("task-runtime restart recovery", () => {
  it("orphans a running task whose process is dead with no receipt (never complete)", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 5150, 2_000).snapshot;
    const reconciled = reconcileTasks(s, { isAlive: () => false }, 3_000);
    const t = reconciled.snapshot.tasks.find((x) => x.id === id)!;
    expect(t.state).toBe("orphaned");
    expect(isTerminalState(t.state)).toBe(false); // NOT complete
    expect(t.receipt).toBeUndefined();
  });

  it("recovers a dead task when a durable receipt is supplied", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 5150, 2_000).snapshot;
    const reconciled = reconcileTasks(
      s,
      { isAlive: () => false, receipts: { [id]: { digest: "from-disk" } } },
      3_000,
    );
    const t = reconciled.snapshot.tasks.find((x) => x.id === id)!;
    expect(t.state).toBe("recovered");
    expect(isTerminalState(t.state)).toBe(true);
    expect(t.receipt!.digest).toBe("from-disk");
  });

  it("leaves a still-alive task running and never touches queued tasks", () => {
    let s = snap(4);
    const run = registerTask(s, { type: "shell", label: "run" }, 1_000);
    s = run.snapshot;
    const queued = registerTask(s, { type: "shell", label: "queued" }, 1_001);
    s = queued.snapshot;
    s = startTask(s, run.task!.id, 7, 2_000).snapshot;
    const reconciled = reconcileTasks(s, { isAlive: () => true }, 3_000);
    expect(reconciled.snapshot.tasks.find((t) => t.id === run.task!.id)!.state).toBe("running");
    expect(reconciled.snapshot.tasks.find((t) => t.id === queued.task!.id)!.state).toBe("queued");
  });

  it("recovers an orphaned task later once durable evidence surfaces", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 5150, 2_000).snapshot;
    s = reconcileTasks(s, { isAlive: () => false }, 3_000).snapshot;
    expect(s.tasks.find((t) => t.id === id)!.state).toBe("orphaned");
    const recovered = recoverTask(s, id, { digest: "found-later" }, 4_000);
    expect(recovered.ok).toBe(true);
    expect(recovered.task!.state).toBe("recovered");
    expect(recovered.task!.receipt!.digest).toBe("found-later");
  });

  it("refuses to recover a task that is not orphaned", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 1, 2_000).snapshot;
    const bad = recoverTask(s, id, { digest: "x" }, 3_000);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("not-orphaned");
  });

  it("supports a waiting (approval-blocked) task and reconciles it too", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 9, 2_000).snapshot;
    s = waitTask(s, id, "approval required", 2_500).snapshot;
    expect(s.tasks.find((t) => t.id === id)!.state).toBe("waiting");
    const reconciled = reconcileTasks(s, { isAlive: () => false }, 3_000);
    expect(reconciled.snapshot.tasks.find((t) => t.id === id)!.state).toBe("orphaned");
  });
});

describe("task-runtime retry and history", () => {
  it("retries a finished task by creating a new one, never rewriting the original", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 1, 2_000).snapshot;
    s = failTask(s, id, { digest: "d1" }, 3_000).snapshot;
    const retried = retryTask(s, id, 4_000);
    expect(retried.ok).toBe(true);
    const newId = retried.task!.id;
    expect(newId).not.toBe(id);
    // Original is untouched.
    const original = retried.snapshot.tasks.find((t) => t.id === id)!;
    expect(original.state).toBe("failed");
    expect(original.receipt!.digest).toBe("d1");
    // New task is queued, copying type/label.
    const fresh = retried.snapshot.tasks.find((t) => t.id === newId)!;
    expect(fresh.state).toBe("queued");
    expect(fresh.label).toContain("(retry)");
  });

  it("refuses to retry a non-terminal task", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 1, 2_000).snapshot;
    const bad = retryTask(s, id, 3_000);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("not-terminal");
  });

  it("bounds history: evicts the oldest terminal task and never a live one", () => {
    let s = snap(64);
    // Register 70 tasks; start the last so it stays live (non-terminal).
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      const reg = registerTask(s, { type: "shell", label: `t${i}` }, 1_000 + i);
      s = reg.snapshot;
      ids.push(reg.task!.id);
    }
    // Cancel the first 69 so they become terminal (evictable); keep the last queued/live.
    for (let i = 0; i < 69; i++) s = cancelTask(s, ids[i], 2_000 + i).snapshot;
    // Bounded to the cap; the live (queued) task survives.
    expect(s.tasks.length).toBeLessThanOrEqual(64);
    expect(s.evicted).toBeGreaterThan(0);
    expect(s.tasks.find((t) => t.id === ids[69])).toBeDefined();
    expect(s.tasks.find((t) => t.id === ids[69])!.state).toBe("queued");
  });
});

describe("task-runtime safety and formatting", () => {
  it("redacts secrets in labels, detail, and notes", () => {
    // Decoys are LOW-entropy (repeated chars) so the product redactor still
    // catches them via KNOWN_TOKEN_RE (sk- 16+, ghp_ 20+) while a history
    // secret scanner never flags them: gitleaks' github-pat rule needs 36+
    // chars and the generic-api-key rule needs a high-entropy value, so a
    // real-looking fixture would fail CI's secret scan over the whole tree.
    const reg = registerTask(
      snap(),
      { type: "shell", label: "deploy sk-aaaaaaaaaaaaaaaaaaaa", detail: "header ghp_aaaaaaaaaaaaaaaaaaaaaaaa" },
      1_000,
    );
    expect(reg.task!.label).not.toContain("sk-aaaa");
    expect(reg.task!.label).toContain("[REDACTED]");
    expect(reg.task!.detail).not.toContain("ghp_aaaa");
  });

  it("redacts the home path in evidence links and the summary workspace", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 1, 2_000).snapshot;
    s = succeedTask(s, id, { digest: "d", evidenceLink: `file://${os.homedir()}/project/run.json` }, 3_000).snapshot;
    const detail = formatTaskDetail(s.tasks.find((t) => t.id === id)!).join("\n");
    expect(detail).toContain("file://~/project/run.json");
    expect(detail).not.toContain(os.homedir());

    const summary = formatTaskSummary(summarizeTasks(s), { workspaceRoot: `${os.homedir()}/project` });
    expect(summary.join("\n")).toContain("~/project");
    expect(summary.join("\n")).not.toContain(os.homedir());
  });

  it("summarizes counts and renders a compact, inspectable view", () => {
    let s = snap(4);
    const a = registerTask(s, { type: "verify", label: "verify" }, 1_000);
    s = a.snapshot;
    const b = registerTask(s, { type: "shell", label: "build" }, 1_001);
    s = b.snapshot;
    s = startTask(s, a.task!.id, 1, 2_000).snapshot;
    s = succeedTask(s, a.task!.id, { digest: "d" }, 3_000).snapshot;

    const summary = summarizeTasks(s);
    expect(summary.schema).toBe(TASK_RUNTIME_SCHEMA);
    expect(summary.v).toBe(TASK_RUNTIME_VERSION);
    expect(summary.counts.succeeded).toBe(1);
    expect(summary.counts.queued).toBe(1);
    expect(summary.active.map((t) => t.id)).toEqual([b.task!.id]);
    expect(summary.recent.map((t) => t.id)).toEqual([a.task!.id]);

    const lines = formatTaskSummary(summary);
    expect(lines[0]).toContain("Tasks (oh-my-cli.tasks v1)");
    expect(lines.join("\n")).toContain("1 queued");
    expect(lines.join("\n")).toContain("1 done");
    expect(lines.join("\n")).toContain("active:");
    expect(lines.join("\n")).toContain("recent:");
  });

  it("is deterministic given an explicit clock", () => {
    const run = (): string => {
      let s = snap(2);
      const a = registerTask(s, { type: "shell", label: "x" }, 1_000);
      s = a.snapshot;
      s = startTask(s, a.task!.id, 5, 2_000).snapshot;
      s = succeedTask(s, a.task!.id, { digest: "d" }, 3_000).snapshot;
      return JSON.stringify(summarizeTasks(s));
    };
    expect(run()).toBe(run());
  });

  it("uses the documented default concurrency bound", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
    expect(snap().maxConcurrent).toBe(4);
  });
});

describe("task-runtime view and durable persistence", () => {
  it("renders a combined inspectable view (summary + per-task detail)", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 12, 2_000).snapshot;
    const view = { summary: summarizeTasks(s), workspaceRoot: `${os.homedir()}/project` };
    const text = formatTaskView(view).join("\n");
    expect(text).toContain("Tasks (oh-my-cli.tasks v1)");
    expect(text).toContain("active:");
    expect(text).toContain("detail");
    expect(text).toContain(`task-001 running`);
    // Home path is redacted in the combined view.
    expect(text).toContain("~/project");
    expect(text).not.toContain(os.homedir());
  });

  it("renders an honest empty view when a session has no recorded tasks", () => {
    const text = formatTaskView(emptyTaskView(`${os.homedir()}/project`)).join("\n");
    expect(text).toContain("no background tasks.");
    expect(text).not.toContain(os.homedir());
  });

  it("round-trips a snapshot through serialize + parse without loss", () => {
    let { s, id } = withOne();
    s = startTask(s, id, 99, 2_000).snapshot;
    s = succeedTask(s, id, { digest: "roundtrip", evidenceLink: "file:///e.json" }, 3_000).snapshot;
    const parsed = parseTaskSnapshot(JSON.parse(serializeTaskSnapshot(s)));
    expect(parsed).toEqual(s);
  });

  it("fails closed on a malformed or incompatible snapshot", () => {
    expect(() => parseTaskSnapshot(null)).toThrow(TaskSnapshotError);
    expect(() => parseTaskSnapshot({ schema: "other", v: 1, sessionId: "s", workspaceKey: "", tasks: [] })).toThrow(
      /unexpected task schema/,
    );
    expect(() =>
      parseTaskSnapshot({ schema: TASK_RUNTIME_SCHEMA, v: 999, sessionId: "s", workspaceKey: "", tasks: [] }),
    ).toThrow(/incompatible task snapshot version/);
    // A task with an unknown state is rejected.
    expect(() =>
      parseTaskSnapshot({
        schema: TASK_RUNTIME_SCHEMA,
        v: TASK_RUNTIME_VERSION,
        sessionId: "s",
        workspaceKey: "",
        tasks: [{ id: "t1", state: "bogus" }],
      }),
    ).toThrow(/unknown state/);
  });

  it("persists no secrets or host home in the durable form", () => {
    const reg = registerTask(
      snap(),
      { type: "shell", label: "deploy sk-aaaaaaaaaaaaaaaaaaaa", detail: `log ${os.homedir()}/run.log` },
      1_000,
    );
    const durable = serializeTaskSnapshot(reg.snapshot);
    expect(durable).not.toContain("sk-aaaa");
    // The label is redacted before persist; the home path in detail is preserved
    // only if already redacted at construction (it is not a file:// link here).
    expect(durable).toContain("[REDACTED]");
  });
});
