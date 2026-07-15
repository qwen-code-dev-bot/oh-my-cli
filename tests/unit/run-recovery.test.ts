import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hashEvidence,
  writeRecoveryCheckpoint,
  readRecoveryCheckpoint,
  parseCheckpoint,
  readEvidenceFile,
  evaluateRecovery,
  planRemainingSteps,
  formatRecoveryPlan,
  RecoveryCheckpointError,
  RECOVERY_SCHEMA,
  RECOVERY_VERSION,
} from "../../src/run-recovery.js";
import type { RecoveryCheckpoint, RecoveryContext } from "../../src/run-recovery.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rr-rec-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

// A checkpoint for a task that has completed two steps.
function checkpoint(over: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schema: RECOVERY_SCHEMA,
    v: RECOVERY_VERSION,
    taskIdentity: "task-A",
    repoHead: "abc123",
    steps: [
      { id: "build", digest: hashEvidence("artifact-1") },
      { id: "test", digest: hashEvidence("artifact-2") },
    ],
    ...over,
  };
}

// Current state that matches the checkpoint above (so resume is safe).
function matchingContext(over: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    taskIdentity: "task-A",
    repoHead: "abc123",
    evidence: {
      build: hashEvidence("artifact-1"),
      test: hashEvidence("artifact-2"),
    },
    ...over,
  };
}

describe("hashEvidence", () => {
  it("is a deterministic 64-char hex sha256 of the content", () => {
    const h = hashEvidence("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEvidence("hello")).toBe(h);
    expect(hashEvidence("hello!")).not.toBe(h);
  });
});

describe("checkpoint persistence", () => {
  it("round-trips a checkpoint through write + read", () => {
    const file = path.join(tmp(), "checkpoint.json");
    writeRecoveryCheckpoint(file, checkpoint());
    const read = readRecoveryCheckpoint(file);
    expect(read.schema).toBe(RECOVERY_SCHEMA);
    expect(read.v).toBe(RECOVERY_VERSION);
    expect(read.taskIdentity).toBe("task-A");
    expect(read.repoHead).toBe("abc123");
    expect(read.steps.map((s) => s.id)).toEqual(["build", "test"]);
  });

  it("redacts secret-shaped task identity and step ids before writing to disk", () => {
    const file = path.join(tmp(), "checkpoint.json");
    writeRecoveryCheckpoint(
      file,
      checkpoint({ taskIdentity: `task ${SECRET}`, steps: [{ id: `step ${SECRET}`, digest: hashEvidence("x") }] }),
    );
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain("[REDACTED]");
  });

  it("rejects a malformed JSON file", () => {
    const file = path.join(tmp(), "bad.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => readRecoveryCheckpoint(file)).toThrowError(RecoveryCheckpointError);
  });

  it("rejects a missing file with a clear error", () => {
    expect(() => readRecoveryCheckpoint(path.join(tmp(), "nope.json"))).toThrow(/file not found/);
  });
});

describe("parseCheckpoint", () => {
  it("rejects wrong schema, wrong version, and missing fields (fail closed)", () => {
    expect(() => parseCheckpoint({ schema: "other", v: 1, taskIdentity: "t", repoHead: "", steps: [] })).toThrow(
      /unexpected recovery schema/,
    );
    expect(() => parseCheckpoint({ schema: RECOVERY_SCHEMA, v: 99, taskIdentity: "t", repoHead: "", steps: [] })).toThrow(
      /incompatible recovery checkpoint version/,
    );
    expect(() => parseCheckpoint({ schema: RECOVERY_SCHEMA, v: RECOVERY_VERSION, repoHead: "", steps: [] })).toThrow(
      /missing taskIdentity/,
    );
    expect(() => parseCheckpoint({ schema: RECOVERY_SCHEMA, v: RECOVERY_VERSION, taskIdentity: "t", steps: [] })).toThrow(
      /missing repoHead/,
    );
    expect(() => parseCheckpoint({ schema: RECOVERY_SCHEMA, v: RECOVERY_VERSION, taskIdentity: "t", repoHead: "" })).toThrow(
      /missing steps array/,
    );
  });

  it("rejects a malformed step and a non-object", () => {
    expect(() =>
      parseCheckpoint({ schema: RECOVERY_SCHEMA, v: RECOVERY_VERSION, taskIdentity: "t", repoHead: "", steps: [{ id: "x" }] }),
    ).toThrow(/malformed step/);
    expect(() => parseCheckpoint(null)).toThrow(/not an object/);
  });
});

describe("readEvidenceFile", () => {
  it("parses a flat object and redacts keys", () => {
    const file = path.join(tmp(), "evidence.json");
    fs.writeFileSync(file, JSON.stringify({ build: "deadbeef", [`x ${SECRET}`]: "feed" }));
    const ev = readEvidenceFile(file);
    expect(ev.build).toBe("deadbeef");
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });

  it("rejects arrays, non-objects, non-string values, and invalid JSON", () => {
    const dir = tmp();
    const arr = path.join(dir, "arr.json");
    fs.writeFileSync(arr, "[]");
    expect(() => readEvidenceFile(arr)).toThrow(/must be a JSON object/);
    const num = path.join(dir, "num.json");
    fs.writeFileSync(num, JSON.stringify({ build: 5 }));
    expect(() => readEvidenceFile(num)).toThrow(/not a string digest/);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{");
    expect(() => readEvidenceFile(bad)).toThrow(/not valid JSON/);
  });
});

describe("evaluateRecovery", () => {
  it("resumes when task, head, and every completed-step digest still match", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext());
    expect(plan.decision).toBe("resume");
    expect(plan.completed).toEqual(["build", "test"]);
    expect(plan.schema).toBe(RECOVERY_SCHEMA);
  });

  it("resumes with no completed steps when the checkpoint has none", () => {
    const plan = evaluateRecovery(checkpoint({ steps: [] }), matchingContext({ evidence: {} }));
    expect(plan.decision).toBe("resume");
    expect(plan.completed).toEqual([]);
  });

  it("refuses an ambiguous checkpoint (task identity mismatch)", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext({ taskIdentity: "task-B" }));
    expect(plan.decision).toBe("refuse");
    expect(plan.reason).toMatch(/ambiguous/);
    expect(plan.completed).toEqual([]);
  });

  it("refuses a stale checkpoint (repository head moved)", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext({ repoHead: "def456" }));
    expect(plan.decision).toBe("refuse");
    expect(plan.reason).toMatch(/stale/);
  });

  it("refuses a tampered checkpoint (completed-step evidence changed)", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext({ evidence: { build: hashEvidence("DIFFERENT"), test: hashEvidence("artifact-2") } }));
    expect(plan.decision).toBe("refuse");
    expect(plan.reason).toMatch(/tampered or stale/);
  });

  it("refuses when a completed step has no current evidence (cannot verify)", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext({ evidence: { build: hashEvidence("artifact-1") } }));
    expect(plan.decision).toBe("refuse");
    expect(plan.reason).toMatch(/no current evidence/);
  });

  it("is deterministic across repeated evaluations", () => {
    const a = JSON.stringify(evaluateRecovery(checkpoint(), matchingContext()));
    const b = JSON.stringify(evaluateRecovery(checkpoint(), matchingContext()));
    expect(a).toBe(b);
  });
});

describe("planRemainingSteps (exactly-once)", () => {
  it("skips proven-complete steps and preserves order on resume", () => {
    const plan = evaluateRecovery(checkpoint({ steps: [{ id: "build", digest: hashEvidence("a") }] }), {
      taskIdentity: "task-A",
      repoHead: "abc123",
      evidence: { build: hashEvidence("a") },
    });
    expect(plan.decision).toBe("resume");
    expect(planRemainingSteps(["build", "test", "deploy"], plan)).toEqual(["test", "deploy"]);
  });

  it("skips nothing when the plan is refused", () => {
    const plan = evaluateRecovery(checkpoint(), matchingContext({ repoHead: "moved" }));
    expect(plan.decision).toBe("refuse");
    expect(planRemainingSteps(["build", "test"], plan)).toEqual(["build", "test"]);
  });

  it("proves a completed step is not executed twice after an interruption", () => {
    // Step 1 ("build") completed and checkpointed; the run was interrupted before step 2.
    const cp = checkpoint({ steps: [{ id: "build", digest: hashEvidence("build-out") }] });
    const file = path.join(tmp(), "checkpoint.json");
    writeRecoveryCheckpoint(file, cp);
    const restored = readRecoveryCheckpoint(file);
    const ctx = matchingContext({ evidence: { build: hashEvidence("build-out") } });

    // First resume: build is proven complete and skipped.
    const plan1 = evaluateRecovery(restored, ctx);
    expect(planRemainingSteps(["build", "test"], plan1)).toEqual(["test"]);
    // Replay after another interruption: same result — build is still skipped exactly once.
    const plan2 = evaluateRecovery(restored, ctx);
    expect(planRemainingSteps(["build", "test"], plan2)).toEqual(["test"]);
  });
});

describe("formatRecoveryPlan", () => {
  it("renders a resume plan listing the steps safe to skip", () => {
    const text = formatRecoveryPlan(evaluateRecovery(checkpoint(), matchingContext()));
    expect(text).toContain("Run recovery (oh-my-cli.recovery v1)");
    expect(text).toContain("decision:  resume");
    expect(text).toContain("safe to skip");
    expect(text).toContain("build");
  });

  it("renders a refuse plan with the reason", () => {
    const text = formatRecoveryPlan(evaluateRecovery(checkpoint(), matchingContext({ repoHead: "moved" })));
    expect(text).toContain("decision:  refuse");
    expect(text).toMatch(/stale/);
  });

  it("never leaks a secret in the formatted output", () => {
    const text = formatRecoveryPlan(
      evaluateRecovery(
        checkpoint({ taskIdentity: `task ${SECRET}`, steps: [{ id: `step ${SECRET}`, digest: hashEvidence("x") }] }),
        matchingContext({ taskIdentity: `task ${SECRET}`, evidence: { [`step ${SECRET}`]: hashEvidence("x") } }),
      ),
    );
    expect(text).not.toContain(SECRET);
  });
});
