// The read-only /context view (Issue #721): states the session's
// context-compaction budget honestly — the exact auto-compaction gate input
// (last provider call's prompt tokens) against the configured threshold, the
// latest turn's provider-reported usage, the compaction sidecar state, and
// the transcript size. Pure formatter over an explicit input record: only
// provider-reported numbers and store facts — nothing estimated is presented
// as measured, and absence is stated, never papered over.

export interface ContextViewInput {
  // Prompt size of the most recent provider call (the auto-compaction gate
  // input), or null when no call has reported usage yet.
  lastCallPromptTokens: number | null;
  // Configured auto-compaction threshold (--compact-threshold /
  // OMC_COMPACT_THRESHOLD), or null when not configured.
  threshold: number | null;
  // Latest turn's provider-reported usage, or null when the provider gave
  // none.
  lastTurnUsage: { prompt: number; completion: number; total: number } | null;
  // Validated compaction sidecar for the session, or null when absent.
  sidecar: { messageCount: number; sourceDigest: string } | null;
  // Messages currently in the on-disk transcript.
  messageCount: number;
}

export const CONTEXT_COMPACT_GUIDANCE =
  "Run /compact to write a fresh summary; it applies from the next turn and the next --resume.";

export function formatContextView(input: ContextViewInput): string {
  const lines: string[] = [];
  lines.push("Context budget");

  // Compaction gate: last provider call's prompt size vs the threshold.
  if (input.threshold === null) {
    lines.push("  Auto-compaction threshold: not configured (--compact-threshold / OMC_COMPACT_THRESHOLD).");
  } else if (input.lastCallPromptTokens === null) {
    lines.push(`  Auto-compaction threshold: ${input.threshold} tokens — no provider call has reported usage yet.`);
  } else {
    const relation =
      input.lastCallPromptTokens >= input.threshold
        ? "reached — auto-compaction fires at the next round boundary"
        : "below threshold";
    lines.push(
      `  Last provider call prompt: ${input.lastCallPromptTokens} tokens; threshold ${input.threshold} — ${relation}.`,
    );
  }

  // Latest turn usage, exactly as the provider reported it.
  if (input.lastTurnUsage === null) {
    lines.push("  Latest turn usage: not reported yet.");
  } else {
    lines.push(
      `  Latest turn usage: prompt ${input.lastTurnUsage.prompt}, completion ${input.lastTurnUsage.completion}, total ${input.lastTurnUsage.total}.`,
    );
  }

  // Compaction sidecar state (digest prefix only — no transcript content).
  if (input.sidecar === null) {
    lines.push("  Compaction sidecar: none.");
  } else {
    lines.push(
      `  Compaction sidecar: present (summarized ${input.sidecar.messageCount} messages, digest ${input.sidecar.sourceDigest.slice(0, 12)}…).`,
    );
  }

  lines.push(`  Transcript messages: ${input.messageCount}.`);
  lines.push(CONTEXT_COMPACT_GUIDANCE);
  return lines.join("\n");
}
