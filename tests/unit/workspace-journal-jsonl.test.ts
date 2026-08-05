import { describe, it, expect } from "vitest";
import {
  workspaceJournalEntryJsonLine,
  WORKSPACE_JOURNAL_SCHEMA,
  WORKSPACE_JOURNAL_VERSION,
  type WorkspaceJournalEntry,
} from "../../src/workspace-journal.js";

function entry(overrides: Partial<WorkspaceJournalEntry> = {}): WorkspaceJournalEntry {
  return {
    at: 1754370000000,
    kind: "note",
    detail: "note saved",
    sessionId: "session-a",
    shortId: "short-a",
    ...overrides,
  };
}

describe("workspaceJournalEntryJsonLine (Issue #686)", () => {
  it("emits one complete, parseable JSON value", () => {
    const line = workspaceJournalEntryJsonLine(entry());
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("tags the line with the workspace-journal schema identity", () => {
    const parsed = JSON.parse(workspaceJournalEntryJsonLine(entry()));
    expect(parsed.schema).toBe(WORKSPACE_JOURNAL_SCHEMA);
    expect(parsed.v).toBe(WORKSPACE_JOURNAL_VERSION);
  });

  it("carries every entry field", () => {
    const parsed = JSON.parse(
      workspaceJournalEntryJsonLine(entry({ kind: "pinned", detail: "pinned to the top of discovery" })),
    );
    expect(parsed.at).toBe(1754370000000);
    expect(parsed.kind).toBe("pinned");
    expect(parsed.detail).toBe("pinned to the top of discovery");
    expect(parsed.sessionId).toBe("session-a");
    expect(parsed.shortId).toBe("short-a");
  });

  it("omits integrity when absent and carries it when present", () => {
    expect(JSON.parse(workspaceJournalEntryJsonLine(entry())).integrity).toBeUndefined();
    expect(
      JSON.parse(workspaceJournalEntryJsonLine(entry({ integrity: "corrupt" }))).integrity,
    ).toBe("corrupt");
  });

  it("passes redacted detail through untouched", () => {
    const detail = "note saved: [REDACTED: secret]";
    expect(JSON.parse(workspaceJournalEntryJsonLine(entry({ detail }))).detail).toBe(detail);
  });

  it("is a pure, stable serializer", () => {
    expect(workspaceJournalEntryJsonLine(entry())).toBe(workspaceJournalEntryJsonLine(entry()));
  });
});
