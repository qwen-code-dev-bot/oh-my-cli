import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  bundleStore,
  isStoreBundle,
  restoreStoreBundle,
  STORE_BUNDLE_SCHEMA,
  STORE_BUNDLE_VERSION,
  SESSION_BUNDLE_SCHEMA,
  SESSION_BUNDLE_VERSION,
  type StoreBundle,
} from "../../src/session-bundle.js";

function sessionEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SESSION_BUNDLE_SCHEMA,
    v: SESSION_BUNDLE_VERSION,
    bundledAt: 1,
    sourceSessionId: "source-id",
    transcriptLines: ['{"role":"user","content":"x"}'],
    sidecars: {},
    ...overrides,
  };
}

function storeBundle(overrides: Partial<StoreBundle> = {}): StoreBundle {
  return {
    schema: STORE_BUNDLE_SCHEMA,
    v: STORE_BUNDLE_VERSION,
    bundledAt: 1,
    sessionCount: 1,
    sessions: [sessionEntry() as never],
    ...overrides,
  };
}

describe("isStoreBundle (Issue #706)", () => {
  it("accepts a valid store bundle", () => {
    expect(isStoreBundle(storeBundle())).toBe(true);
    expect(isStoreBundle(storeBundle({ sessionCount: 0, sessions: [] }))).toBe(true);
  });

  it("rejects a wrong store schema or version", () => {
    expect(isStoreBundle(storeBundle({ schema: "oh-my-cli.other" } as never))).toBe(false);
    expect(isStoreBundle(storeBundle({ v: 99 } as never))).toBe(false);
  });

  it("rejects a non-array sessions field", () => {
    expect(isStoreBundle(storeBundle({ sessions: {} } as never))).toBe(false);
  });

  it("rejects a sessionCount mismatch", () => {
    expect(isStoreBundle(storeBundle({ sessionCount: 5 }))).toBe(false);
  });

  it("rejects bundles containing a malformed session entry", () => {
    const bad = sessionEntry({ schema: "oh-my-cli.wrong" });
    expect(isStoreBundle(storeBundle({ sessions: [bad as never] }))).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isStoreBundle(null)).toBe(false);
    expect(isStoreBundle("store")).toBe(false);
  });
});

describe("bundleStore / restoreStoreBundle (Issue #706)", () => {
  let dir: string;
  let store: SessionStore;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-706u-store-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    store = new SessionStore(dir);
  });

  function seed(content: string): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1_700_000_000_000,
    });
    return id;
  }

  it("bundles every session in deterministic ascending id order", () => {
    const ids = [seed("one"), seed("two"), seed("three")].sort();
    const bundle = bundleStore(store, 42);
    expect(bundle.schema).toBe(STORE_BUNDLE_SCHEMA);
    expect(bundle.v).toBe(STORE_BUNDLE_VERSION);
    expect(bundle.bundledAt).toBe(42);
    expect(bundle.sessionCount).toBe(3);
    expect(bundle.sessions.map((s) => s.sourceSessionId)).toEqual(ids);
  });

  it("bundles an empty store as an honest zero state", () => {
    const bundle = bundleStore(store, 1);
    expect(bundle.sessionCount).toBe(0);
    expect(bundle.sessions).toEqual([]);
  });

  it("restores every session as a new id", () => {
    seed("one");
    seed("two");
    const bundle = bundleStore(store, 1);
    const { sessionIds } = restoreStoreBundle(store, bundle);
    expect(sessionIds).toHaveLength(2);
    for (const id of sessionIds) {
      expect(bundle.sessions.map((s) => s.sourceSessionId)).not.toContain(id);
      expect(fs.existsSync(store.filePath(id))).toBe(true);
    }
  });
});
