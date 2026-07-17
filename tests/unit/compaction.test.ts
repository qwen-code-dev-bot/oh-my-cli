import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  COMPACTION_SCHEMA,
  COMPACTION_VERSION,
  digestMessages,
  compactMessages,
  renderSummaryMessage,
  buildCompactedTranscript,
  saveCompaction,
  loadCompaction,
  formatCompaction,
  loadSessionMessages,
} from "../../src/compaction.js";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage } from "../../src/session.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-compaction-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A representative transcript: a goal, a constraint, a completed write, a failed
// shell command, and a final answer.
function sampleTranscript(): SessionMessage[] {
  return [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Build the feature and keep it deterministic." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "src/feature.ts", content: "export const x = 1;" }) } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "Wrote src/feature.ts" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c2", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "npm test" }) } },
      ],
    },
    { role: "tool", tool_call_id: "c2", content: "Exit code 1: 2 tests failed" },
    { role: "assistant", content: "Done building the feature." },
    { role: "user", content: "Now also add tests." },
  ];
}

describe("digestMessages", () => {
  it("is deterministic for identical input", () => {
    const m = sampleTranscript();
    expect(digestMessages(m)).toBe(digestMessages([...m]));
  });

  it("differs when the transcript differs", () => {
    const m = sampleTranscript();
    const m2 = sampleTranscript();
    m2[1] = { role: "user", content: "A different goal." };
    expect(digestMessages(m)).not.toBe(digestMessages(m2));
  });
});

describe("compactMessages", () => {
  it("extracts task, decisions, receipts, file changes, failures, and pending work", () => {
    const { summary } = compactMessages(sampleTranscript());
    expect(summary.schema).toBe(COMPACTION_SCHEMA);
    expect(summary.version).toBe(COMPACTION_VERSION);
    expect(summary.activeTask).toBe("Build the feature and keep it deterministic.");
    // The trailing unanswered user directive is pending work.
    expect(summary.pendingSteps).toContain("Now also add tests.");
    // The completed write is a receipt with a path reference.
    const write = summary.receipts.find((r) => r.tool === "write");
    expect(write).toBeDefined();
    expect(write?.category).toBe("mutate-file");
    expect(write?.outcome).toBe("ok");
    expect(write?.reference).toContain("src/feature.ts");
    // The failed shell command is classified as an error and surfaced.
    const shell = summary.receipts.find((r) => r.tool === "shell");
    expect(shell?.outcome).toBe("error");
    expect(summary.failures.some((f) => f.includes("Exit code 1"))).toBe(true);
    // The written file is tracked.
    expect(summary.fileChanges).toContain("src/feature.ts");
    expect(summary.messageCount).toBe(sampleTranscript().length);
  });

  it("is deterministic across runs", () => {
    const a = compactMessages(sampleTranscript()).summary;
    const b = compactMessages(sampleTranscript()).summary;
    expect(b).toEqual(a);
  });

  it("redacts secrets in shell references", () => {
    const m: SessionMessage[] = [
      { role: "user", content: "deploy" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "curl https://user:secret-token@example.com/deploy" }) } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const { summary } = compactMessages(m);
    const ref = summary.receipts[0].reference;
    expect(ref).not.toContain("secret-token");
  });

  it("bounds the summary regardless of transcript size", () => {
    const m: SessionMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 2000; i++) {
      m.push({ role: "user", content: `directive ${i} ${"x".repeat(1000)}` });
      m.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `c${i}`, type: "function", function: { name: "write", arguments: JSON.stringify({ path: `f${i}.ts`, content: "y".repeat(1000) }) } }],
      });
      m.push({ role: "tool", tool_call_id: `c${i}`, content: "ok" });
    }
    const { summary } = compactMessages(m);
    // Arrays are capped and string fields are clamped, so the serialized
    // summary stays far smaller than the multi-megabyte transcript.
    expect(summary.receipts.length).toBeLessThanOrEqual(400);
    expect(summary.fileChanges.length).toBeLessThanOrEqual(200);
    expect(summary.decisions.length).toBeLessThanOrEqual(50);
    const serialized = JSON.stringify(summary);
    expect(serialized.length).toBeLessThan(200_000);
  });
});

describe("renderSummaryMessage", () => {
  it("is a system message that forbids repeating completed actions", () => {
    const { summary } = compactMessages(sampleTranscript());
    const note = renderSummaryMessage(summary);
    expect(note.role).toBe("system");
    expect(note.content).toContain("do NOT repeat");
    expect(note.content).toContain("src/feature.ts");
    expect(note.content).toContain("Build the feature and keep it deterministic.");
    expect(note.content).toContain("Now also add tests.");
  });
});

describe("buildCompactedTranscript", () => {
  it("keeps the system message and the summary, dropping detailed turns", () => {
    const full = sampleTranscript();
    const { summary } = compactMessages(full);
    const compacted = buildCompactedTranscript(full, summary);
    expect(compacted.length).toBe(2);
    expect(compacted[0]).toEqual(full[0]);
    expect(compacted[1].role).toBe("system");
    // The original write tool_call is represented as a receipt, never replayed.
    const hasWriteCall = compacted.some(
      (m) => m.tool_calls?.some((tc) => tc.function.name === "write"),
    );
    expect(hasWriteCall).toBe(false);
  });
});

describe("saveCompaction / loadCompaction", () => {
  it("round-trips a summary", () => {
    const { summary } = compactMessages(sampleTranscript());
    const p = path.join(tmpDir, "s.compact.json");
    saveCompaction(p, summary);
    expect(loadCompaction(p)).toEqual(summary);
  });

  it("fails closed on a missing file", () => {
    expect(loadCompaction(path.join(tmpDir, "nope.compact.json"))).toBeNull();
  });

  it("fails closed on corrupt JSON", () => {
    const p = path.join(tmpDir, "bad.compact.json");
    fs.writeFileSync(p, "{ not json");
    expect(loadCompaction(p)).toBeNull();
  });

  it("fails closed on a schema or version mismatch", () => {
    const { summary } = compactMessages(sampleTranscript());
    const p = path.join(tmpDir, "wrong.compact.json");
    fs.writeFileSync(p, JSON.stringify({ ...summary, schema: "other.schema" }));
    expect(loadCompaction(p)).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ ...summary, version: 999 }));
    expect(loadCompaction(p)).toBeNull();
  });
});

describe("loadSessionMessages", () => {
  function newStore(): SessionStore {
    return new SessionStore(path.join(tmpDir, "sessions"));
  }

  it("applies a valid sidecar whose digest matches the transcript head", () => {
    const store = newStore();
    const id = store.newId();
    const full = sampleTranscript();
    store.checkpoint(id, full, { createdAt: Date.now() });
    const { summary } = compactMessages(full);
    saveCompaction(store.compactPath(id), summary);

    const loaded = loadSessionMessages(store, id);
    expect(loaded.length).toBe(2);
    expect(loaded[1].content).toContain("compacted");
    // The original transcript on disk is untouched.
    expect(store.load(id).length).toBe(full.length);
  });

  it("fails closed when the digest does not match", () => {
    const store = newStore();
    const id = store.newId();
    const full = sampleTranscript();
    store.checkpoint(id, full, { createdAt: Date.now() });
    const { summary } = compactMessages(full);
    saveCompaction(store.compactPath(id), { ...summary, sourceDigest: "deadbeef" });

    expect(loadSessionMessages(store, id).length).toBe(full.length);
  });

  it("fails closed when the sidecar is corrupt", () => {
    const store = newStore();
    const id = store.newId();
    const full = sampleTranscript();
    store.checkpoint(id, full, { createdAt: Date.now() });
    fs.writeFileSync(store.compactPath(id), "{ corrupt");

    expect(loadSessionMessages(store, id).length).toBe(full.length);
  });

  it("fails closed when messageCount exceeds the transcript length", () => {
    const store = newStore();
    const id = store.newId();
    const full = sampleTranscript();
    store.checkpoint(id, full, { createdAt: Date.now() });
    const { summary } = compactMessages(full);
    saveCompaction(store.compactPath(id), { ...summary, messageCount: full.length + 10 });

    expect(loadSessionMessages(store, id).length).toBe(full.length);
  });

  it("returns the full transcript when no sidecar exists", () => {
    const store = newStore();
    const id = store.newId();
    const full = sampleTranscript();
    store.checkpoint(id, full, { createdAt: Date.now() });
    expect(loadSessionMessages(store, id).length).toBe(full.length);
  });
});

describe("formatCompaction", () => {
  it("produces a redacted, human-readable report", () => {
    const { summary } = compactMessages(sampleTranscript());
    const report = formatCompaction(summary);
    expect(report).toContain(COMPACTION_SCHEMA);
    expect(report).toContain("Completed receipts: 2");
    expect(report).toContain("Pending steps: 1");
  });
});
