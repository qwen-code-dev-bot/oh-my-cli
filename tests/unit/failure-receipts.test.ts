import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import {
  FAILURE_RECEIPTS_SCHEMA,
  FAILURE_RECEIPTS_VERSION,
  FAILURE_RECEIPTS_MAX,
  FAILURE_OUTPUT_TAIL_CHARS,
  FAILURE_COMMAND_CHARS,
  appendFailureReceipt,
  loadFailureLog,
  buildFailureRecord,
  formatFailures,
  failureLogPath,
} from "../../src/failure-receipts.js";

const ANSI = /\x1b\[/;
const NOW = 1_785_100_000_000;

describe("failure receipts store (Issue #574)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-574u-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const detail = (over: Partial<{ command: string; status: number | null; timedOut: boolean; stdout: string; stderr: string }> = {}) => ({
    command: over.command ?? "make test",
    status: over.status === undefined ? 3 : over.status,
    timedOut: over.timedOut ?? false,
    stdout: over.stdout ?? "out line",
    stderr: over.stderr ?? "boom: it broke",
    cwd: "/tmp/ws",
  });

  it("appends a receipt with redaction BEFORE persistence", () => {
    const secret = ["ghp", "_", "c".repeat(24)].join("");
    appendFailureReceipt(
      store,
      sessionId,
      detail({ command: `TOKEN=${secret} make test`, stderr: `auth failed for ${secret}` }),
      { head: "f".repeat(40), now: () => NOW },
    );
    const raw = fs.readFileSync(failureLogPath(store, sessionId), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    const load = loadFailureLog(store, sessionId);
    expect(load.corrupt).toBe(false);
    expect(load.receipts).toHaveLength(1);
    const r = load.receipts[0];
    expect(r.seq).toBe(1);
    expect(r.at).toBe(new Date(NOW).toISOString());
    expect(r.status).toBe(3);
    expect(r.exitState).toBe("nonzero");
    expect(r.head).toBe("f".repeat(40));
    expect(r.command).toContain("make test");
  });

  it("maps exit states: timeout, signal-killed, and non-zero", () => {
    appendFailureReceipt(store, sessionId, detail({ timedOut: true, status: null }), { now: () => NOW });
    appendFailureReceipt(store, sessionId, detail({ status: null }), { now: () => NOW + 1 });
    appendFailureReceipt(store, sessionId, detail({ status: 7 }), { now: () => NOW + 2 });
    const load = loadFailureLog(store, sessionId);
    expect(load.receipts.map((r) => r.exitState)).toEqual(["timeout", "signal", "nonzero"]);
    expect(load.receipts.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("bounds output tails and command summaries", () => {
    const bigOut = "o".repeat(FAILURE_OUTPUT_TAIL_CHARS + 500);
    const bigCmd = "c".repeat(FAILURE_COMMAND_CHARS + 500);
    appendFailureReceipt(store, sessionId, detail({ command: bigCmd, stdout: bigOut }), { now: () => NOW });
    const r = loadFailureLog(store, sessionId).receipts[0];
    expect(r.stdoutTail.length).toBeLessThanOrEqual(FAILURE_OUTPUT_TAIL_CHARS + 1); // + leading …
    expect(r.stdoutTail.startsWith("…")).toBe(true);
    expect(r.command.length).toBeLessThanOrEqual(FAILURE_COMMAND_CHARS + 1);
    expect(r.stderrTail).toBe("boom: it broke");
  });

  it("caps the sidecar at the newest receipts and counts the drop", () => {
    for (let i = 0; i < FAILURE_RECEIPTS_MAX + 3; i++) {
      appendFailureReceipt(store, sessionId, detail({ command: `cmd ${i}` }), { now: () => NOW + i });
    }
    const load = loadFailureLog(store, sessionId);
    expect(load.receipts).toHaveLength(FAILURE_RECEIPTS_MAX);
    expect(load.dropped).toBe(3);
    // Newest kept: the oldest three were dropped.
    expect(load.receipts[0].command).toContain("cmd 3");
    expect(load.receipts[load.receipts.length - 1].command).toContain(`cmd ${FAILURE_RECEIPTS_MAX + 2}`);
  });

  it("writes atomically with no stray temp file", () => {
    appendFailureReceipt(store, sessionId, detail(), { now: () => NOW });
    const dir = path.dirname(failureLogPath(store, sessionId));
    const sidecars = fs.readdirSync(dir).filter((f) => f.includes(".failures.json"));
    expect(sidecars).toEqual([path.basename(failureLogPath(store, sessionId))]);
  });

  it("never overwrites a corrupt sidecar and preserves its bytes", () => {
    const filePath = failureLogPath(store, sessionId);
    fs.writeFileSync(filePath, "{ not json");
    appendFailureReceipt(store, sessionId, detail(), { now: () => NOW });
    expect(fs.readFileSync(filePath, "utf8")).toBe("{ not json");
    const load = loadFailureLog(store, sessionId);
    expect(load.corrupt).toBe(true);
    expect(load.receipts).toEqual([]);
  });

  it("reads a missing sidecar as empty (not corrupt)", () => {
    const load = loadFailureLog(store, sessionId);
    expect(load.corrupt).toBe(false);
    expect(load.receipts).toEqual([]);
    expect(load.dropped).toBe(0);
  });
});

describe("failure receipts rendering (Issue #574)", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-574r-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    for (const d of [homeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("renders the explicit empty state", () => {
    const record = buildFailureRecord(store, sessionId);
    expect(record.schema).toBe(FAILURE_RECEIPTS_SCHEMA);
    expect(record.v).toBe(FAILURE_RECEIPTS_VERSION);
    const text = formatFailures(record).join("\n");
    expect(text).toContain("No recorded failures for this session.");
    expect(text).not.toMatch(ANSI);
  });

  it("renders receipts newest-first with revision context and bounded tails", () => {
    appendFailureReceipt(
      store,
      sessionId,
      { command: "first fail", status: 1, timedOut: false, stdout: "", stderr: "one", cwd: "/tmp/ws" },
      { head: "a".repeat(40), now: () => NOW },
    );
    appendFailureReceipt(
      store,
      sessionId,
      { command: "second fail", status: null, timedOut: true, stdout: "partial", stderr: "", cwd: "/tmp/ws" },
      { head: null, now: () => NOW + 1000 },
    );
    const record = buildFailureRecord(store, sessionId);
    expect(record.receipts.map((r) => r.command)).toEqual(["second fail", "first fail"]);
    const text = formatFailures(record).join("\n");
    expect(text.indexOf("second fail")).toBeLessThan(text.indexOf("first fail"));
    expect(text).toContain("timed out");
    expect(text).toContain("exit code 1");
    expect(text).toContain("head: " + "a".repeat(12));
    expect(text).toContain("no git head");
    expect(text).toContain("stderr: one");
    expect(text).toContain("stdout: partial");
    expect(text).not.toMatch(ANSI);
  });

  it("renders the corrupt warning and stays deterministic", () => {
    fs.writeFileSync(failureLogPath(store, sessionId), "{ not json");
    const record = buildFailureRecord(store, sessionId);
    expect(record.corrupt).toBe(true);
    const text = formatFailures(record).join("\n");
    expect(text).toContain("unreadable");
    expect(formatFailures(record).join("\n")).toBe(text);
  });
});

describe("Issue #860: surrogate-safe output tails", () => {
  let homeDir: string;
  let store: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-860-"));
    store = new SessionStore(homeDir);
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "m", workspace: "/tmp/ws", createdAt: 1 });
    store.append(sessionId, { role: "user", content: "hi" });
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("does not orphan a surrogate when an output tail straddles a pair", () => {
    // Rocket's low surrogate sits exactly at index (length - FAILURE_OUTPUT_TAIL_CHARS).
    const stdout = "a".repeat(10) + "🚀" + "a".repeat(FAILURE_OUTPUT_TAIL_CHARS - 1);
    appendFailureReceipt(
      store,
      sessionId,
      { command: "make test", status: 3, timedOut: false, stdout, stderr: "boom", cwd: "/tmp/ws" },
      { now: () => NOW },
    );
    const r = loadFailureLog(store, sessionId).receipts[0];
    const UNPAIRED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(r.stdoutTail).not.toMatch(UNPAIRED);
    expect(r.stdoutTail.startsWith("…")).toBe(true);
  });
});
