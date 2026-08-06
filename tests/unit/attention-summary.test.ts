import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage } from "../../src/session.js";
import { CANCELLED_TOOL_CONTENT } from "../../src/agent.js";
import {
  ATTENTION_MAX_ITEMS,
  ATTENTION_SCHEMA,
  ATTENTION_VERSION,
  attentionRecord,
  buildAttention,
  deriveLastTurnOutcome,
  formatAttention,
} from "../../src/attention-summary.js";

const WS_A = "/srv/proj-a";
const WS_B = "/srv/proj-b";
const NOW = 1_000_000_000_000;
const fixedNow = () => NOW;
// Deterministic canonical keys without git/realpath: identity is the path
// itself, so scoping is exercised purely.
const keyOf = (p: string): string => p;

const user = (content: string): SessionMessage => ({ role: "user", content });
const assistant = (content: string, over: Partial<SessionMessage> = {}): SessionMessage => ({
  role: "assistant",
  content,
  ...over,
});
const toolCallTurn = (ids: string[]): SessionMessage => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "read", arguments: "{}" } })),
});
const toolResult = (id: string, content: string): SessionMessage => ({
  role: "tool",
  content,
  tool_call_id: id,
});

describe("deriveLastTurnOutcome (Issue #558)", () => {
  it("returns null when there is no user turn to attribute", () => {
    expect(deriveLastTurnOutcome([])).toBeNull();
    expect(deriveLastTurnOutcome([assistant("hello")])).toBeNull();
  });

  it("reports failed when nothing followed the last prompt", () => {
    const r = deriveLastTurnOutcome([user("hi")]);
    expect(r?.outcome).toBe("failed");
    expect(r?.detail).toContain("no response");
  });

  it("reports completed when the turn ends in a final assistant answer", () => {
    const r = deriveLastTurnOutcome([user("hi"), assistant("done")]);
    expect(r?.outcome).toBe("completed");
  });

  it("reports cancelled when the last turn carries a cancelled placeholder", () => {
    const r = deriveLastTurnOutcome([
      user("work"),
      toolCallTurn(["c1", "c2"]),
      toolResult("c1", "real output"),
      toolResult("c2", CANCELLED_TOOL_CONTENT),
    ]);
    expect(r?.outcome).toBe("cancelled");
  });

  it("reports failed for an interrupted mid-stream assistant turn", () => {
    const r = deriveLastTurnOutcome([user("hi"), assistant("partial", { interrupted: true })]);
    expect(r?.outcome).toBe("failed");
    expect(r?.detail).toContain("interrupted");
  });

  it("reports failed when the turn ends on a tool result without a final answer", () => {
    const r = deriveLastTurnOutcome([
      user("work"),
      toolCallTurn(["c1"]),
      toolResult("c1", "output"),
    ]);
    expect(r?.outcome).toBe("failed");
    expect(r?.detail).toContain("did not reach a final answer");
  });

  it("attributes only the most recent turn", () => {
    const r = deriveLastTurnOutcome([
      user("first"),
      assistant("old answer"),
      user("second"),
      assistant("new answer"),
    ]);
    expect(r?.outcome).toBe("completed");
    const r2 = deriveLastTurnOutcome([
      user("first"),
      assistant("old answer"),
      user("second"),
    ]);
    expect(r2?.outcome).toBe("failed");
  });
});

describe("buildAttention (Issue #558)", () => {
  let homeDir: string;
  let store: SessionStore;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-"));
    store = new SessionStore(homeDir);
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function seed(
    workspace: string | undefined,
    messages: SessionMessage[],
    over: { id?: string; corrupt?: boolean; partial?: boolean } = {},
  ): string {
    const id = over.id ?? store.newId();
    const lines = [
      JSON.stringify({ meta: true, model: "fake-model", ...(workspace ? { workspace } : {}), createdAt: NOW - 5000 }),
      ...messages.map((m) => JSON.stringify(m)),
    ];
    let body = lines.join("\n") + "\n";
    if (over.corrupt) {
      // A mid-file unparseable line makes the checkpoint corrupt.
      const parts = body.split("\n");
      parts.splice(2, 0, "{ this is not json }");
      body = parts.join("\n");
    }
    if (over.partial) {
      // A single trailing torn line is a recoverable partial.
      body += '{"role":"assistant","content":"incomple';
    }
    fs.writeFileSync(store.filePath(id), body);
    return id;
  }

  const build = (workspacePath: string) =>
    buildAttention({ store, workspacePath, keyOf, now: fixedNow });

  it("returns nothing for an empty store", () => {
    expect(build(WS_A)).toEqual([]);
  });

  it("classifies a corrupt session and offers salvage", () => {
    // Two messages so the bad line lands mid-file (a trailing bad line would
    // be a recoverable partial, not corrupt).
    const id = seed(WS_A, [user("hi"), assistant("ok")], { corrupt: true });
    const items = build(WS_A);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("corrupt-session");
    expect(items[0].sessionId).toBe(id);
    expect(items[0].actions.join(" ")).toContain("--salvage-session");
  });

  it("classifies a recoverable partial checkpoint and offers resume", () => {
    const id = seed(WS_A, [user("hi")], { partial: true });
    const items = build(WS_A);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("partial-session");
    expect(items[0].actions.join(" ")).toContain("--resume");
  });

  it("reports each healthy session's most recent turn outcome", () => {
    const completed = seed(WS_A, [user("a"), assistant("answer")]);
    const failed = seed(WS_A, [user("b"), assistant("partial", { interrupted: true })]);
    const cancelled = seed(WS_A, [
      user("c"),
      toolCallTurn(["k1", "k2"]),
      toolResult("k1", "ok"),
      toolResult("k2", CANCELLED_TOOL_CONTENT),
    ]);
    const types = new Map(build(WS_A).map((i) => [i.sessionId, i.type]));
    expect(types.get(completed)).toBe("turn-completed");
    expect(types.get(failed)).toBe("turn-failed");
    expect(types.get(cancelled)).toBe("turn-cancelled");
  });

  it("emits no item for a session without any user turn", () => {
    seed(WS_A, []);
    expect(build(WS_A)).toEqual([]);
  });

  it("never surfaces another workspace's sessions", () => {
    seed(WS_B, [user("foreign"), assistant("answer")]);
    seed(WS_A, [user("local"), assistant("answer")]);
    const items = build(WS_A);
    expect(items).toHaveLength(1);
    expect(items[0].workspace).toBe(WS_A);
  });

  it("excludes sessions without workspace metadata (unverifiable scope)", () => {
    seed(undefined, [user("legacy"), assistant("answer")]);
    expect(build(WS_A)).toEqual([]);
  });

  it("excludes sessions whose identity cannot be canonicalized", () => {
    seed("/srv/other", [user("hi"), assistant("ok")]);
    const items = buildAttention({
      store,
      workspacePath: WS_A,
      keyOf: (p) => {
        if (p === WS_A) return WS_A; // the current workspace resolves...
        throw new Error("unavailable"); // ...but the session's does not
      },
      now: fixedNow,
    });
    expect(items).toEqual([]);
  });

  it("matches a symlink alias of the current workspace", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-real-"));
    const alias = path.join(path.dirname(real), `${path.basename(real)}-alias`);
    fs.symlinkSync(real, alias);
    try {
      seed(real, [user("hi"), assistant("ok")]);
      const items = buildAttention({ store, workspacePath: alias, now: fixedNow });
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("turn-completed");
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("orders by severity, then recency, then id", () => {
    // Two completed turns with different recency, one failed, one corrupt.
    const older = seed(WS_A, [user("a"), assistant("x")]);
    const newer = seed(WS_A, [user("b"), assistant("y")]);
    const failed = seed(WS_A, [user("c"), assistant("p", { interrupted: true })]);
    const corrupt = seed(WS_A, [user("d"), assistant("q")], { corrupt: true });
    // Pin deterministic mtimes: older < newer.
    fs.utimesSync(store.filePath(older), new Date(NOW - 60_000), new Date(NOW - 60_000));
    fs.utimesSync(store.filePath(newer), new Date(NOW - 30_000), new Date(NOW - 30_000));
    const items = build(WS_A);
    expect(items.map((i) => i.type)).toEqual([
      "corrupt-session",
      "turn-failed",
      "turn-completed",
      "turn-completed",
    ]);
    expect(items[0].sessionId).toBe(corrupt);
    expect(items[1].sessionId).toBe(failed);
    // Newer completed item comes first among equals.
    expect(items[2].sessionId).toBe(newer);
    expect(items[3].sessionId).toBe(older);
  });
});

describe("attentionRecord / formatAttention (Issue #558)", () => {
  let homeDir: string;
  let store: SessionStore;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-rec-"));
    store = new SessionStore(homeDir);
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const SECRET = ["ghp", "_", "a".repeat(24)].join("");

  function seedNamed(): string {
    const id = store.newId();
    const lines = [
      JSON.stringify({ meta: true, model: `model-${SECRET}`, workspace: WS_A, createdAt: NOW - 5000 }),
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "assistant", content: "done" }),
    ];
    fs.writeFileSync(store.filePath(id), lines.join("\n") + "\n");
    store.writeName(id, `secret name ${SECRET}`);
    return id;
  }

  it("emits a versioned, schema-tagged, redacted record", () => {
    const id = seedNamed();
    const items = buildAttention({ store, workspacePath: WS_A, keyOf, now: fixedNow });
    const record = attentionRecord(items, WS_A);
    expect(record.schema).toBe(ATTENTION_SCHEMA);
    expect(record.v).toBe(ATTENTION_VERSION);
    expect(record.workspace).toBe(WS_A);
    expect(record.total).toBe(1);
    expect(record.shown).toBe(1);
    expect(record.omitted).toBe(0);
    expect(record.items[0].sessionId).toBe(id);
    expect(record.items[0].type).toBe("turn-completed");
    const raw = JSON.stringify(record);
    expect(raw).not.toContain(SECRET);
    expect(record.items[0].name).toContain("[REDACTED]");
  });

  it("caps the item list and counts the overflow", () => {
    for (let i = 0; i < ATTENTION_MAX_ITEMS + 1; i++) {
      const id = `fixed-${String(i).padStart(3, "0")}`;
      fs.writeFileSync(
        store.filePath(id),
        JSON.stringify({ meta: true, model: "m", workspace: WS_A, createdAt: NOW - 5000 }) +
          "\n" +
          JSON.stringify({ role: "user", content: "hi" }) +
          "\n" +
          JSON.stringify({ role: "assistant", content: "ok" }) +
          "\n",
      );
    }
    const items = buildAttention({ store, workspacePath: WS_A, keyOf, now: fixedNow });
    expect(items.length).toBe(ATTENTION_MAX_ITEMS + 1);
    const record = attentionRecord(items, WS_A);
    expect(record.total).toBe(ATTENTION_MAX_ITEMS + 1);
    expect(record.shown).toBe(ATTENTION_MAX_ITEMS);
    expect(record.omitted).toBe(1);
    const text = formatAttention(items, WS_A).join("\n");
    expect(text).toContain("1 more not shown");
  });

  it("renders an explicit empty-state line", () => {
    const text = formatAttention([], WS_A).join("\n");
    expect(text).toContain(`workspace ${WS_A}`);
    expect(text).toContain("Nothing needs attention in this workspace.");
  });

  it("renders item lines with status and action hints, free of ANSI and secrets", () => {
    seedNamed();
    const items = buildAttention({ store, workspacePath: WS_A, keyOf, now: fixedNow });
    const text = formatAttention(items, WS_A).join("\n");
    expect(text).toContain("turn-completed");
    expect(text).toContain("final answer delivered");
    expect(text).toContain("--resume");
    expect(text).toContain("--session-stats");
    expect(text).toContain("Read-only");
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).not.toContain(SECRET);
  });

  it("is deterministic: identical state yields identical output", () => {
    seedNamed();
    const items = () => buildAttention({ store, workspacePath: WS_A, keyOf, now: fixedNow });
    expect(JSON.stringify(attentionRecord(items(), WS_A))).toBe(
      JSON.stringify(attentionRecord(items(), WS_A)),
    );
    expect(formatAttention(items(), WS_A).join("\n")).toBe(formatAttention(items(), WS_A).join("\n"));
  });
});
