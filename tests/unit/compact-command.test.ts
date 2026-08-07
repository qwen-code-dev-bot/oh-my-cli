import { describe, it, expect } from "vitest";
import {
  COMPACT_APPLIES_LINE,
  COMPACT_ARGS_REJECTION,
  compactCurrentSession,
  rejectCompactArgs,
} from "../../src/compact-command.js";
import type { CompactCommandIO } from "../../src/compact-command.js";
import type { CompactionSummary } from "../../src/compaction.js";
import type { SessionMessage } from "../../src/session.js";

const TRANSCRIPT: SessionMessage[] = [
  { role: "system", content: "you are oh-my-cli" },
  { role: "user", content: "do the thing" },
  { role: "assistant", content: "the thing is done" },
];

function fakeIo(messages: SessionMessage[]): {
  io: CompactCommandIO;
  saved: Array<{ sessionId: string; summary: CompactionSummary }>;
} {
  const saved: Array<{ sessionId: string; summary: CompactionSummary }> = [];
  return {
    saved,
    io: {
      load: () => [...messages],
      save: (sessionId, summary) => {
        saved.push({ sessionId, summary });
      },
    },
  };
}

describe("compact command: argument rejection (Issue #719)", () => {
  it("allows the no-argument form", () => {
    expect(rejectCompactArgs("")).toBeNull();
    expect(rejectCompactArgs("   ")).toBeNull();
  });

  it("rejects any argument with the honest guidance", () => {
    expect(rejectCompactArgs("some-session")).toBe(COMPACT_ARGS_REJECTION);
    expect(COMPACT_ARGS_REJECTION).toContain("--compact <id-or-name>");
  });
});

describe("compact command: current-session compaction (Issue #719)", () => {
  it("reports honestly for an empty session and writes nothing", () => {
    const { io, saved } = fakeIo([]);
    const output = compactCurrentSession("sid", io);
    expect(output).toContain("Nothing to compact");
    expect(saved).toHaveLength(0);
  });

  it("writes one sidecar and reports the summary plus the applies line", () => {
    const { io, saved } = fakeIo(TRANSCRIPT);
    const output = compactCurrentSession("sid-1", io);
    expect(saved).toHaveLength(1);
    expect(saved[0].sessionId).toBe("sid-1");
    expect(saved[0].summary.messageCount).toBe(TRANSCRIPT.length);
    expect(output).toContain("Compaction summary");
    expect(output).toContain(COMPACT_APPLIES_LINE);
    expect(COMPACT_APPLIES_LINE).toContain("Transcript untouched");
  });

  it("is deterministic: identical input yields an identical report and digest", () => {
    const first = fakeIo(TRANSCRIPT);
    const second = fakeIo(TRANSCRIPT);
    expect(compactCurrentSession("a", first.io)).toBe(compactCurrentSession("a", second.io));
    expect(first.saved[0].summary.sourceDigest).toBe(second.saved[0].summary.sourceDigest);
  });

  it("reports a failed load honestly and changes nothing", () => {
    const io: CompactCommandIO = {
      load: () => {
        throw new Error("store unreadable");
      },
      save: () => {
        throw new Error("save should not run");
      },
    };
    const output = compactCurrentSession("sid", io);
    expect(output).toContain("Compaction failed: store unreadable");
    expect(output).toContain("unchanged");
  });

  it("reports a failed sidecar write honestly (atomic write leaves prior state)", () => {
    const io: CompactCommandIO = {
      load: () => [...TRANSCRIPT],
      save: () => {
        throw new Error("disk full");
      },
    };
    const output = compactCurrentSession("sid", io);
    expect(output).toContain("Compaction failed: disk full");
    expect(output).toContain("unchanged");
  });
});
