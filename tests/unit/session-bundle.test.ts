import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";
import {
  bundleSession,
  isSessionBundle,
  restoreSessionBundle,
  SESSION_BUNDLE_SCHEMA,
  SESSION_BUNDLE_VERSION,
  type SessionBundle,
} from "../../src/session-bundle.js";

function baseBundle(overrides: Partial<SessionBundle> = {}): SessionBundle {
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

describe("isSessionBundle (Issue #704)", () => {
  it("accepts a valid bundle", () => {
    expect(isSessionBundle(baseBundle())).toBe(true);
  });

  it("rejects a wrong schema", () => {
    expect(isSessionBundle(baseBundle({ schema: "oh-my-cli.other" } as never))).toBe(false);
  });

  it("rejects a wrong version", () => {
    expect(isSessionBundle(baseBundle({ v: 99 } as never))).toBe(false);
  });

  it("rejects non-string transcript lines and non-object sidecars", () => {
    expect(isSessionBundle(baseBundle({ transcriptLines: [1] } as never))).toBe(false);
    expect(isSessionBundle(baseBundle({ sidecars: null } as never))).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isSessionBundle(null)).toBe(false);
    expect(isSessionBundle("bundle")).toBe(false);
    expect(isSessionBundle(42)).toBe(false);
  });
});

describe("bundleSession / restoreSessionBundle (Issue #704)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-704u-store-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "bundle fodder" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1_700_000_000_000,
    });
    appendSessionNote(store, id, "a note", 1_700_000_001_000);
    store.writePinned(id, 1_700_000_002_000);
  });

  it("tags the bundle and carries raw transcript lines", () => {
    const bundle = bundleSession(store, id, 1234);
    expect(bundle.schema).toBe(SESSION_BUNDLE_SCHEMA);
    expect(bundle.v).toBe(SESSION_BUNDLE_VERSION);
    expect(bundle.bundledAt).toBe(1234);
    expect(bundle.sourceSessionId).toBe(id);
    expect(bundle.transcriptLines.join("\n") + "\n").toBe(
      fs.readFileSync(store.filePath(id), "utf-8"),
    );
  });

  it("omits absent sidecars and carries present ones", () => {
    const bundle = bundleSession(store, id, 1);
    expect(bundle.sidecars.notes).toBeDefined();
    expect(bundle.sidecars.pinned).toBeDefined();
    expect(bundle.sidecars.goal).toBeUndefined();
    expect(bundle.sidecars.archived).toBeUndefined();
    expect(bundle.sidecars.turn).toBeUndefined();
  });

  it("carries torn transcript lines raw (integrity rides along)", () => {
    fs.appendFileSync(store.filePath(id), "{torn tail\n");
    const bundle = bundleSession(store, id, 1);
    expect(bundle.transcriptLines[bundle.transcriptLines.length - 1]).toBe("{torn tail");
  });

  it("carries an unparseable sidecar as raw text", () => {
    fs.writeFileSync(store.goalPath(id), "{torn goal");
    const bundle = bundleSession(store, id, 1);
    expect(bundle.sidecars.goal).toBe("{torn goal");
  });

  it("restores as a new id with byte-identical content", () => {
    const bundle = bundleSession(store, id, 1);
    const { sessionId } = restoreSessionBundle(store, bundle);
    expect(sessionId).not.toBe(id);
    expect(fs.readFileSync(store.filePath(sessionId), "utf-8")).toBe(
      fs.readFileSync(store.filePath(id), "utf-8"),
    );
    expect(fs.readFileSync(store.pinnedPath(sessionId), "utf-8")).toBe(
      fs.readFileSync(store.pinnedPath(id), "utf-8"),
    );
  });

  it("rewrites turn-log entries to the new session id", () => {
    const turnLog = {
      checkpoints: [
        {
          schema: "oh-my-cli.turn-checkpoint",
          v: 1,
          sessionId: id,
          turnIndex: 0,
          head: null,
          messageCountBefore: 0,
          messageCountAfter: 1,
          messages: [{ role: "user", content: "x" }],
          files: [],
          digest: "0".repeat(64),
        },
      ],
    };
    fs.writeFileSync(
      store.filePath(id).replace(/\.jsonl$/, ".turn.json"),
      JSON.stringify(turnLog),
    );
    const bundle = bundleSession(store, id, 1);
    const { sessionId } = restoreSessionBundle(store, bundle);
    const restored = JSON.parse(
      fs.readFileSync(store.filePath(sessionId).replace(/\.jsonl$/, ".turn.json"), "utf-8"),
    );
    expect(restored.checkpoints[0].sessionId).toBe(sessionId);
  });
});
