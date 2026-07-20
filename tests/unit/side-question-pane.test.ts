import { describe, it, expect } from "vitest";
import {
  openSideQuestion,
  appendSideAnswer,
  finishSideQuestion,
  promoteSideAnswer,
  sideAnswerClipboardEscape,
  renderSideQuestionPanel,
  shellStyle,
  composeScreen,
  visibleWidth,
} from "../../src/tui-shell.js";
import type { ShellState, SideQuestionState } from "../../src/tui-shell.js";

const style = shellStyle(false);
const SUMMARY =
  "Context (read-only): 3 messages. Tools and workspace changes are disabled; the main task is unaffected.";

describe("side-question pane transitions", () => {
  it("opens streaming with an active provider request and empty answer", () => {
    const sq = openSideQuestion("what does X do?", SUMMARY);
    expect(sq.phase).toBe("streaming");
    expect(sq.providerActive).toBe(true);
    expect(sq.answer).toBe("");
    expect(sq.question).toBe("what does X do?");
    expect(sq.contextSummary).toBe(SUMMARY);
  });

  it("appends deltas while streaming", () => {
    let sq = openSideQuestion("q", SUMMARY);
    sq = appendSideAnswer(sq, "Hello ");
    sq = appendSideAnswer(sq, "world");
    expect(sq.answer).toBe("Hello world");
  });

  it("ignores a late delta after the turn has settled", () => {
    let sq = openSideQuestion("q", SUMMARY);
    sq = appendSideAnswer(sq, "partial");
    sq = finishSideQuestion(sq, { phase: "cancelled" });
    const after = appendSideAnswer(sq, "MORE");
    expect(after).toBe(sq);
    expect(after.answer).toBe("partial");
  });

  it("finishing clears the active provider flag and records the phase", () => {
    let sq = openSideQuestion("q", SUMMARY);
    sq = finishSideQuestion(sq, { phase: "answered" });
    expect(sq.phase).toBe("answered");
    expect(sq.providerActive).toBe(false);
    const err = finishSideQuestion(openSideQuestion("q", SUMMARY), {
      phase: "error",
      error: "boom",
    });
    expect(err.phase).toBe("error");
    expect(err.error).toBe("boom");
  });

  it("promotes a non-empty answer and rejects an empty one", () => {
    const answered = finishSideQuestion(appendSideAnswer(openSideQuestion("q", SUMMARY), "  keep me  "), {
      phase: "answered",
    });
    expect(promoteSideAnswer(answered)).toBe("keep me");
    const empty = finishSideQuestion(openSideQuestion("q", SUMMARY), { phase: "cancelled" });
    expect(promoteSideAnswer(empty)).toBeNull();
  });

  it("encodes the answer as an OSC 52 clipboard escape", () => {
    const esc = sideAnswerClipboardEscape("hi");
    // base64("hi") === "aGk="
    expect(esc).toBe("\x1b]52;c;aGk=\x07");
  });
});

describe("renderSideQuestionPanel", () => {
  const sq: SideQuestionState = {
    question: "why is the build failing?",
    phase: "answered",
    contextSummary: SUMMARY,
    providerActive: false,
    answer: "The build fails because tsc found a type error in src/index.ts.",
  };

  it("shows the title, boundary, provider status, question, answer, and actions", () => {
    const lines = renderSideQuestionPanel(20, 80, style, sq);
    const joined = lines.join("\n");
    expect(joined).toContain("Side question");
    expect(joined).toContain("read-only");
    expect(joined).toContain("main task unaffected");
    expect(joined).toContain("Provider request: none · answered");
    expect(joined).toContain("why is the build failing?");
    expect(joined).toContain("type error in src/index.ts");
    expect(joined).toContain("Enter promote to composer");
  });

  it("fills exactly the given height and never overflows the width", () => {
    const lines = renderSideQuestionPanel(18, 60, style, sq);
    expect(lines).toHaveLength(18);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("reports an active provider request and Esc-cancel hint while streaming", () => {
    const streaming = openSideQuestion("q?", SUMMARY);
    const joined = renderSideQuestionPanel(16, 80, style, streaming).join("\n");
    expect(joined).toContain("Provider request: active · streaming");
    expect(joined).toContain("Esc cancel");
  });

  it("renders the error phase with the failure detail", () => {
    const errored = finishSideQuestion(openSideQuestion("q?", SUMMARY), {
      phase: "error",
      error: "The side question could not be answered (provider error).",
    });
    const joined = renderSideQuestionPanel(16, 80, style, errored).join("\n");
    expect(joined).toContain("provider error");
    expect(joined).toContain("could not be answered");
    expect(joined).toContain("Esc dismiss");
  });

  it("returns nothing for a zero-height region", () => {
    expect(renderSideQuestionPanel(0, 80, style, sq)).toEqual([]);
  });
});

describe("composeScreen with a side-question overlay", () => {
  function baseState(): ShellState {
    return {
      viewport: { rows: 24, cols: 80 },
      version: "0.1.0",
      transcript: [
        { kind: "user", text: "do the long task" },
        { kind: "assistant", text: "working on it" },
      ],
      composer: { mode: "focused", text: "", placeholder: "Ask a question, or type / for commands" },
      status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: null },
      color: false,
      turn: { phase: "idle" },
      expanded: new Set(),
      scroll: 0,
    };
  }

  it("renders the pane over the main area while keeping the status anchored", () => {
    const state: ShellState = {
      ...baseState(),
      sideQuestion: {
        question: "quick clarification?",
        phase: "answered",
        contextSummary: SUMMARY,
        providerActive: false,
        answer: "Here is the side answer.",
      },
    };
    const screen = composeScreen(state);
    expect(screen.lines).toHaveLength(24);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    const joined = screen.lines.join("\n");
    // The overlay is shown instead of the main transcript.
    expect(joined).toContain("Side question");
    expect(joined).toContain("quick clarification?");
    expect(joined).toContain("Here is the side answer.");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
    // The main transcript body is not rendered while the overlay is open.
    expect(joined).not.toContain("working on it");
  });
});
