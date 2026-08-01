import { describe, it, expect } from "vitest";
import {
  MemoryStore,
  assembleMemoryView,
  formatMemoryView,
  isSecretKey,
  redactValue,
  checkStaleness,
  type MemoryEntry,
} from "../../src/memory-inspection.js";

// Pure-function coverage for memory inspection (Issue #369): provenance,
// redaction, staleness, multi-scope, citation, and read-only guarantee.

const PROV = { sessionId: "s1", turnId: "turn-10", createdAt: 1000 };

// --- secret detection -------------------------------------------------------

describe("isSecretKey", () => {
  it("detects secret-bearing keys", () => {
    expect(isSecretKey("provider.apiKey")).toBe(true);
    expect(isSecretKey("db.password")).toBe(true);
    expect(isSecretKey("auth_token")).toBe(true);
  });

  it("passes non-secret keys", () => {
    expect(isSecretKey("editor.fontSize")).toBe(false);
    expect(isSecretKey("preferred.model")).toBe(false);
  });
});

describe("redactValue", () => {
  it("redacts short values", () => {
    expect(redactValue("abc")).toBe("[REDACTED]");
  });

  it("shows first/last 2 chars for longer values", () => {
    const result = redactValue("abcdefgh123456");
    expect(result).toContain("ab");
    expect(result).toContain("56");
    expect(result).toContain("[REDACTED]");
  });
});

// --- provenance -------------------------------------------------------------

describe("provenance", () => {
  it("tracks session and turn provenance", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "preferred.model",
      rawValue: "qwen3-max",
      scope: "user",
      provenance: PROV,
    });

    expect(entry.provenance.sessionId).toBe("s1");
    expect(entry.provenance.turnId).toBe("turn-10");
    expect(entry.citation).toContain("session:s1");
    expect(entry.citation).toContain("turn:turn-10");
  });
});

// --- redaction in store -----------------------------------------------------

describe("redaction", () => {
  it("redacts secret values", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "provider.apiKey",
      rawValue: "placeholder-long-secret-value-here",
      scope: "user",
      provenance: PROV,
    });

    expect(entry.isSecret).toBe(true);
    expect(entry.displayValue).toContain("[REDACTED]");
    expect(entry.displayValue).not.toContain("placeholder-long-secret-value-here");
  });

  it("does not redact non-secret values", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "editor.theme",
      rawValue: "dark",
      scope: "user",
      provenance: PROV,
    });

    expect(entry.isSecret).toBe(false);
    expect(entry.displayValue).toBe("dark");
  });
});

// --- staleness detection ----------------------------------------------------

describe("staleness detection", () => {
  it("flags stale memories on revision mismatch", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "build.command",
      rawValue: "npm run build",
      scope: "repository",
      provenance: PROV,
      revisionBinding: "abc123",
      currentRevision: "def456",
    });

    expect(entry.isStale).toBe(true);
  });

  it("does not flag when revisions match", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "build.command",
      rawValue: "npm run build",
      scope: "repository",
      provenance: PROV,
      revisionBinding: "abc123",
      currentRevision: "abc123",
    });

    expect(entry.isStale).toBe(false);
  });

  it("does not flag when no revision binding", () => {
    const store = new MemoryStore();
    const entry = store.register({
      key: "user.name",
      rawValue: "Alice",
      scope: "user",
      provenance: PROV,
    });

    expect(entry.isStale).toBe(false);
  });

  it("refreshes staleness against new revision", () => {
    const store = new MemoryStore();
    store.register({
      key: "build.command",
      rawValue: "npm run build",
      scope: "repository",
      provenance: PROV,
      revisionBinding: "abc123",
      currentRevision: "abc123",
    });

    expect(store.getStale()).toHaveLength(0);
    store.refreshStaleness("new-revision");
    expect(store.getStale()).toHaveLength(1);
  });
});

describe("checkStaleness", () => {
  it("returns false for no binding", () => {
    const entry: MemoryEntry = {
      key: "x", displayValue: "y", isSecret: false, scope: "user",
      provenance: PROV, isStale: false, citation: "",
    };
    expect(checkStaleness(entry, "any")).toBe(false);
  });
});

// --- multi-scope fixture ----------------------------------------------------

describe("multi-scope fixture", () => {
  it("tracks memories across scopes", () => {
    const store = new MemoryStore();
    store.register({ key: "editor.theme", rawValue: "dark", scope: "user", provenance: PROV });
    store.register({ key: "build.command", rawValue: "make", scope: "repository", provenance: { ...PROV, sessionId: "s2" } });
    store.register({ key: "project.name", rawValue: "my-app", scope: "workspace", provenance: { ...PROV, sessionId: "s3" } });

    expect(store.size).toBe(3);
    expect(store.getByScope("user")).toHaveLength(1);
    expect(store.getByScope("repository")).toHaveLength(1);
    expect(store.getByScope("workspace")).toHaveLength(1);
  });
});

// --- inspection view --------------------------------------------------------

describe("assembleMemoryView", () => {
  it("counts stale and secret entries", () => {
    const store = new MemoryStore();
    store.register({ key: "editor.theme", rawValue: "dark", scope: "user", provenance: PROV });
    store.register({ key: "provider.apiKey", rawValue: "placeholder-secret-value-123", scope: "user", provenance: PROV });
    store.register({ key: "build.cmd", rawValue: "make", scope: "repository", provenance: PROV, revisionBinding: "old", currentRevision: "new" });

    const view = assembleMemoryView(store);
    expect(view.totalCount).toBe(3);
    expect(view.secretCount).toBe(1);
    expect(view.staleCount).toBe(1);
    expect(view.hasStale).toBe(true);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatMemoryView", () => {
  it("renders memories with provenance, staleness, and redaction", () => {
    const store = new MemoryStore();
    store.register({ key: "editor.theme", rawValue: "dark", scope: "user", provenance: PROV });
    store.register({ key: "provider.apiKey", rawValue: "placeholder-secret-value-456", scope: "user", provenance: PROV });
    store.register({ key: "build.cmd", rawValue: "make", scope: "repository", provenance: PROV, revisionBinding: "old-rev", currentRevision: "new-rev" });

    const view = assembleMemoryView(store);
    const output = formatMemoryView(view);

    expect(output).toContain("Memory Inspection");
    expect(output).toContain("editor.theme = dark");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("🔒");
    expect(output).toContain("⚠STALE");
    expect(output).toContain("session:s1");
    expect(output).toContain("Read-only");
    expect(output).not.toContain("placeholder-secret-value-456");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("view assembly does not mutate store", () => {
    const store = new MemoryStore();
    store.register({ key: "x", rawValue: "y", scope: "user", provenance: PROV });

    const before = store.size;
    assembleMemoryView(store);
    expect(store.size).toBe(before);
  });
});
