import { describe, it, expect } from "vitest";
import { CONTEXT_COMPACT_GUIDANCE, formatContextView } from "../../src/context-view.js";
import type { ContextViewInput } from "../../src/context-view.js";

const BASE: ContextViewInput = {
  lastCallPromptTokens: 4200,
  threshold: 100000,
  lastTurnUsage: { prompt: 4200, completion: 180, total: 4380 },
  sidecar: null,
  messageCount: 9,
};

describe("context view formatter (Issue #721)", () => {
  it("states the gate input against the threshold when both exist", () => {
    const text = formatContextView(BASE);
    expect(text).toContain("Last provider call prompt: 4200 tokens; threshold 100000 — below threshold.");
    expect(text).toContain("Latest turn usage: prompt 4200, completion 180, total 4380.");
    expect(text).toContain("Compaction sidecar: none.");
    expect(text).toContain("Transcript messages: 9.");
    expect(text.trim().endsWith(CONTEXT_COMPACT_GUIDANCE)).toBe(true);
  });

  it("flags the reached threshold honestly", () => {
    const text = formatContextView({ ...BASE, lastCallPromptTokens: 100000 });
    expect(text).toContain("threshold 100000 — reached — auto-compaction fires at the next round boundary.");
  });

  it("says when no threshold is configured", () => {
    const text = formatContextView({ ...BASE, threshold: null });
    expect(text).toContain("Auto-compaction threshold: not configured (--compact-threshold / OMC_COMPACT_THRESHOLD).");
    expect(text).not.toContain("below threshold");
  });

  it("says when no provider call has reported usage yet", () => {
    const text = formatContextView({ ...BASE, lastCallPromptTokens: null, lastTurnUsage: null });
    expect(text).toContain("Auto-compaction threshold: 100000 tokens — no provider call has reported usage yet.");
    expect(text).toContain("Latest turn usage: not reported yet.");
  });

  it("shows the sidecar state with a digest prefix when present", () => {
    const text = formatContextView({
      ...BASE,
      sidecar: { messageCount: 11, sourceDigest: "8a66e3139ad530fff2d7904503bc98db" },
    });
    expect(text).toContain("Compaction sidecar: present (summarized 11 messages, digest 8a66e3139ad5…).");
    // The full digest never leaks into the view.
    expect(text).not.toContain("8a66e3139ad530fff2d7904503bc98db");
  });

  it("handles the zero-message fresh session", () => {
    const text = formatContextView({
      lastCallPromptTokens: null,
      threshold: null,
      lastTurnUsage: null,
      sidecar: null,
      messageCount: 0,
    });
    expect(text).toContain("Transcript messages: 0.");
    expect(text).toContain("not configured");
    expect(text).toContain("not reported yet");
    expect(text).toContain("Compaction sidecar: none.");
  });
});
