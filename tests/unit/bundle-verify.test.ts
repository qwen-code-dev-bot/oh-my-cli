import { describe, it, expect } from "vitest";
import {
  verifySessionBundle,
  verifyStoreBundle,
  formatBundleVerify,
  SESSION_BUNDLE_SCHEMA,
  SESSION_BUNDLE_VERSION,
  STORE_BUNDLE_SCHEMA,
  STORE_BUNDLE_VERSION,
  type SessionBundle,
  type StoreBundle,
} from "../../src/session-bundle.js";

function sessionBundle(overrides: Partial<SessionBundle> = {}): SessionBundle {
  return {
    schema: SESSION_BUNDLE_SCHEMA,
    v: SESSION_BUNDLE_VERSION,
    bundledAt: 1,
    sourceSessionId: "session-a",
    transcriptLines: ['{"role":"user","content":"x"}'],
    sidecars: {},
    ...overrides,
  };
}

function storeBundle(sessions: SessionBundle[]): StoreBundle {
  return {
    schema: STORE_BUNDLE_SCHEMA,
    v: STORE_BUNDLE_VERSION,
    bundledAt: 1,
    sessionCount: sessions.length,
    sessions,
  };
}

describe("verifySessionBundle (Issue #708)", () => {
  it("reports a clean bundle healthy with its line count", () => {
    const result = verifySessionBundle(sessionBundle());
    expect(result.healthy).toBe(true);
    expect(result.transcriptLines).toBe(1);
    expect(result.tornTranscriptLines).toBe(0);
    expect(result.tornSidecars).toEqual([]);
    expect(result.sourceSessionId).toBe("session-a");
  });

  it("counts torn transcript lines", () => {
    const result = verifySessionBundle(
      sessionBundle({
        transcriptLines: ['{"ok":true}', "{torn one", '{"also":"ok"}', "{torn two"],
      }),
    );
    expect(result.transcriptLines).toBe(4);
    expect(result.tornTranscriptLines).toBe(2);
    expect(result.healthy).toBe(false);
  });

  it("reports sidecars carried as raw text as torn, by name", () => {
    const result = verifySessionBundle(
      sessionBundle({
        sidecars: { goal: { parsed: true }, notes: "{torn notes", pinned: "{torn pinned" },
      }),
    );
    expect(result.tornSidecars).toEqual(["notes", "pinned"]);
    expect(result.healthy).toBe(false);
  });

  it("reports a raw turn log as a torn sidecar", () => {
    const result = verifySessionBundle(
      sessionBundle({ sidecars: { turn: "{torn turn log" } }),
    );
    expect(result.tornSidecars).toEqual(["turn"]);
    expect(result.healthy).toBe(false);
  });

  it("treats sidecars carried as parseable raw text as healthy (byte-fidelity carriage)", () => {
    // The bundle format carries EVERY sidecar as raw stored text (#704);
    // only content that fails to parse is torn. Regression for the
    // false-positive caught by post-merge dogfood on the real store.
    const result = verifySessionBundle(
      sessionBundle({
        sidecars: { goal: '{"objective":"x"}', notes: '[{"text":"n"}]', turn: '{"checkpoints":[]}' },
      }),
    );
    expect(result.tornSidecars).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  it("treats empty transcript and parsed sidecars as healthy", () => {
    const result = verifySessionBundle(
      sessionBundle({ transcriptLines: [], sidecars: { goal: { ok: 1 }, turn: [] } }),
    );
    expect(result.healthy).toBe(true);
  });
});

describe("verifyStoreBundle (Issue #708)", () => {
  it("reports a clean store healthy", () => {
    const result = verifyStoreBundle(storeBundle([sessionBundle()]));
    expect(result.healthy).toBe(true);
    expect(result.sessions).toHaveLength(1);
  });

  it("reports a store damaged when any session is damaged", () => {
    const damaged = sessionBundle({
      sourceSessionId: "session-b",
      transcriptLines: ["{torn"],
    });
    const result = verifyStoreBundle(storeBundle([sessionBundle(), damaged]));
    expect(result.healthy).toBe(false);
    expect(result.sessions.map((s) => s.healthy)).toEqual([true, false]);
  });

  it("reports an empty store healthy", () => {
    expect(verifyStoreBundle(storeBundle([])).healthy).toBe(true);
  });
});

describe("formatBundleVerify (Issue #708)", () => {
  it("renders only the verdict for a healthy record", () => {
    const text = formatBundleVerify({
      kind: "session",
      sessions: [verifySessionBundle(sessionBundle())],
      healthy: true,
    }).join("\n");
    expect(text).toContain("Bundle kind: session; 1 session(s) checked.");
    expect(text).toContain("Verdict: healthy.");
    expect(text).not.toContain("damaged (");
  });

  it("renders damaged sessions with their findings", () => {
    const findings = verifySessionBundle(
      sessionBundle({ transcriptLines: ["{torn"], sidecars: { notes: "{torn" } }),
    );
    const text = formatBundleVerify({ kind: "store", sessions: [findings], healthy: false }).join(
      "\n",
    );
    expect(text).toContain("session-");
    expect(text).toContain("1 torn transcript line(s)");
    expect(text).toContain("torn sidecars: notes");
    expect(text).toContain("Verdict: damaged.");
  });
});
