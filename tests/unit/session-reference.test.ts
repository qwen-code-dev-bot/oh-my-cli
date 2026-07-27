import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  SESSION_REFERENCE_PREFIX,
  isSessionReferenceQuery,
  parseSessionReferenceQuery,
  sessionReferenceToken,
  collectSessionReferenceCandidates,
  filterSessionReferenceCandidates,
  resolveSessionReference,
  formatSessionReferenceContext,
  formatSessionReferencePreview,
} from "../../src/session-reference.js";

const CURRENT_WS = "/workspace/current";
const OTHER_WS = "/workspace/other";
const SECRET = ["ghp", "_", "a".repeat(24)].join("");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeStore(): SessionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-ref-"));
  tmpDirs.push(dir);
  return new SessionStore(dir);
}

// Create a readable session with a workspace + model and the given messages.
function makeSession(
  store: SessionStore,
  opts: { workspace?: string; model?: string; messages: Array<{ role: "user" | "assistant" | "tool"; content: string }> },
): string {
  const id = store.newId();
  store.writeMeta(id, { workspace: opts.workspace, model: opts.model ?? "fake-model", createdAt: 1000 });
  for (const m of opts.messages) store.append(id, { role: m.role, content: m.content });
  return id;
}

// Create a corrupt session (a non-trailing malformed line).
function makeCorruptSession(store: SessionStore): string {
  const id = store.newId();
  fs.writeFileSync(store.filePath(id), "{this is not valid json\n");
  fs.appendFileSync(store.filePath(id), `${JSON.stringify({ role: "user", content: "hi" })}\n`);
  return id;
}

describe("session-reference namespace (#248)", () => {
  it("distinguishes the session namespace from workspace path references", () => {
    expect(isSessionReferenceQuery("session:abc123")).toBe(true);
    expect(isSessionReferenceQuery("session:")).toBe(true);
    expect(isSessionReferenceQuery("src/index.ts")).toBe(false);
    expect(isSessionReferenceQuery("session-notes.md")).toBe(false);
  });

  it("parses the id/search term after the prefix", () => {
    expect(parseSessionReferenceQuery("session:abc123")).toBe("abc123");
    expect(parseSessionReferenceQuery("session:build fix")).toBe("build fix");
    expect(parseSessionReferenceQuery("src/index.ts")).toBeNull();
  });

  it("formats an exact insertion token", () => {
    expect(sessionReferenceToken("abc-123")).toBe(`${SESSION_REFERENCE_PREFIX}abc-123`);
  });
});

describe("collectSessionReferenceCandidates (#248)", () => {
  it("excludes the current, corrupt, and cross-workspace sessions", () => {
    const store = makeStore();
    const current = makeSession(store, { workspace: CURRENT_WS, messages: [{ role: "user", content: "current" }] });
    const eligible = makeSession(store, { workspace: CURRENT_WS, messages: [{ role: "user", content: "prior" }] });
    const corrupt = makeCorruptSession(store);
    const crossWs = makeSession(store, { workspace: OTHER_WS, messages: [{ role: "user", content: "other ws" }] });

    const candidates = collectSessionReferenceCandidates(store, {
      currentSessionId: current,
      currentWorkspace: CURRENT_WS,
    });
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(eligible);
    expect(ids).not.toContain(current); // current session
    expect(ids).not.toContain(corrupt); // corrupt
    expect(ids).not.toContain(crossWs); // cross-workspace
  });

  it("produces redacted candidate fields with a context-size estimate", () => {
    const store = makeStore();
    const id = makeSession(store, {
      workspace: CURRENT_WS,
      model: "fake-model",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });
    const candidates = collectSessionReferenceCandidates(store, { currentWorkspace: CURRENT_WS });
    const c = candidates.find((x) => x.id === id)!;
    expect(c.shortId).toBe(id.split("-")[0].slice(0, 8));
    expect(c.workspace).toBe(CURRENT_WS);
    expect(c.model).toBe("fake-model");
    expect(c.approxTokens).toBeGreaterThan(0);
    expect(typeof c.ageLabel).toBe("string");
  });

  it("filters candidates by a case-insensitive substring across visible fields", () => {
    const store = makeStore();
    const id = makeSession(store, { workspace: CURRENT_WS, model: "special-model", messages: [{ role: "user", content: "x" }] });
    const candidates = collectSessionReferenceCandidates(store, { currentWorkspace: CURRENT_WS });
    expect(filterSessionReferenceCandidates(candidates, "SPECIAL-MODEL").some((c) => c.id === id)).toBe(true);
    expect(filterSessionReferenceCandidates(candidates, "zzz-nope").length).toBe(0);
  });
});

describe("resolveSessionReference (#248)", () => {
  it("resolves an exact id to a bounded redacted summary", () => {
    const store = makeStore();
    const id = makeSession(store, {
      workspace: CURRENT_WS,
      messages: [
        { role: "user", content: "investigate the build" },
        { role: "assistant", content: "the build is fine" },
      ],
    });
    const res = resolveSessionReference(store, id, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.summary.sessionId).toBe(id);
    expect(res.summary.messageCount).toBe(2);
    expect(res.summary.excerpt).toContain("investigate the build");
    expect(res.summary.excerpt).toContain("the build is fine");
    expect(res.summary.truncated).toBe(false);
  });

  it("resolves a unique short-id reference", () => {
    const store = makeStore();
    const id = makeSession(store, { workspace: CURRENT_WS, messages: [{ role: "user", content: "x" }] });
    const shortId = id.split("-")[0].slice(0, 8);
    const res = resolveSessionReference(store, shortId, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.summary.sessionId).toBe(id);
  });

  it("fails closed on a missing session", () => {
    const store = makeStore();
    const res = resolveSessionReference(store, "no-such-session-id", { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not found");
  });

  it("fails closed on a corrupt session", () => {
    const store = makeStore();
    const corrupt = makeCorruptSession(store);
    const res = resolveSessionReference(store, corrupt, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("corrupt");
  });

  it("fails closed when referencing the current session", () => {
    const store = makeStore();
    const current = makeSession(store, { workspace: CURRENT_WS, messages: [{ role: "user", content: "x" }] });
    const res = resolveSessionReference(store, current, { currentSessionId: current, currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("current session");
  });

  it("fails closed on a cross-workspace session", () => {
    const store = makeStore();
    const other = makeSession(store, { workspace: OTHER_WS, messages: [{ role: "user", content: "x" }] });
    const res = resolveSessionReference(store, other, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("different workspace");
  });

  it("redacts secrets and excludes tool output from the excerpt", () => {
    const store = makeStore();
    const id = makeSession(store, {
      workspace: CURRENT_WS,
      messages: [
        { role: "user", content: `my key is ${SECRET}` },
        { role: "assistant", content: "ok" },
        { role: "tool", content: `tool output with ${SECRET} and raw payload` },
      ],
    });
    const res = resolveSessionReference(store, id, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Secret redacted; tool output never included.
    expect(res.summary.excerpt).not.toContain(SECRET);
    expect(res.summary.excerpt).toContain("[REDACTED]");
    expect(res.summary.excerpt).not.toContain("raw payload");
  });

  it("bounds a long excerpt and flags truncation", () => {
    const store = makeStore();
    const id = makeSession(store, {
      workspace: CURRENT_WS,
      messages: [{ role: "assistant", content: "x".repeat(5000) }],
    });
    const res = resolveSessionReference(store, id, { currentWorkspace: CURRENT_WS });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.summary.truncated).toBe(true);
    expect(res.summary.excerpt.length).toBeLessThanOrEqual(1200);
  });
});

describe("formatSessionReferenceContext / preview (#248)", () => {
  it("renders a deterministic, bounded context block with provenance and truncation metadata", () => {
    const store = makeStore();
    const id = makeSession(store, {
      workspace: CURRENT_WS,
      model: "fake-model",
      messages: [{ role: "assistant", content: "x".repeat(5000) }],
    });
    const res = resolveSessionReference(store, id, { currentWorkspace: CURRENT_WS });
    if (!res.ok) throw new Error("expected ok");
    const ctx = formatSessionReferenceContext(res.summary);
    expect(ctx).toContain(`[Prior session reference ${res.summary.shortId}]`);
    expect(ctx).toContain("Provenance:");
    expect(ctx).toContain("fake-model");
    expect(ctx).toContain("Context size:");
    expect(ctx).toContain("truncated");
    expect(ctx).toContain(`[End prior session reference ${res.summary.shortId}]`);
    // Deterministic for a fixed session.
    expect(formatSessionReferenceContext(res.summary)).toBe(ctx);
  });

  it("renders a bounded preview line", () => {
    const store = makeStore();
    makeSession(store, { workspace: CURRENT_WS, model: "fake-model", messages: [{ role: "user", content: "x" }] });
    const candidates = collectSessionReferenceCandidates(store, { currentWorkspace: CURRENT_WS });
    const preview = formatSessionReferencePreview(candidates[0], 40);
    expect(Array.from(preview).length).toBeLessThanOrEqual(40);
    expect(preview).toContain("session");
  });
});
