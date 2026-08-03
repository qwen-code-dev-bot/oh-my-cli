import { describe, expect, it } from "vitest";
import type { DesktopSessionSummary } from "../../src/desktop/contracts.js";
import {
  createDesktopViewModel,
  createInitialDesktopState,
  filterSessions,
  reduceDesktopState,
  renderDesktopShell,
  renderDesktopWorkbench,
  shouldAdoptCompletedSession,
  type DesktopRuntimeState,
} from "../../src/desktop/renderer.js";

function summary(overrides: Partial<DesktopSessionSummary>): DesktopSessionSummary {
  return {
    id: "one",
    title: "Build desktop",
    messageCount: 2,
    updatedAt: 1,
    draft: false,
    streaming: false,
    failed: false,
    unread: false,
    archived: false,
    ...overrides,
  };
}

function readyWith(overrides: {
  sessions?: DesktopSessionSummary[];
  files?: { path: string }[];
}): DesktopRuntimeState {
  return reduceDesktopState(createInitialDesktopState(), {
    type: "bootstrap-resolved",
    payload: { platform: "darwin", version: "0.1.0", workspaceName: "demo" },
    sessions: overrides.sessions ?? [summary({})],
    files: overrides.files,
  });
}

describe("desktop workbench renderer", () => {
  it.each([
    ["empty", "Start a local agent session"],
    ["loading", "Opening the Desktop workbench"],
    ["ready", "Ready for a real task"],
    ["error", "Desktop bridge unavailable"],
  ] as const)("renders the %s state", (state, message) => {
    const html = renderDesktopShell(createDesktopViewModel(state));
    expect(html).toContain(`data-workbench-state="${state}"`);
    expect(html).toContain(message);
  });

  it("renders actionable session, chat, and file controls", () => {
    const selected = reduceDesktopState(
      readyWith({ files: [{ path: "src/app.ts" }] }),
      {
        type: "select-session",
        session: {
          id: "one",
          title: "Build desktop",
          messages: [
            { role: "user", content: "Make it work" },
            { role: "assistant", content: "Ready" },
          ],
        },
      },
    );
    const html = renderDesktopWorkbench(createDesktopViewModel(selected));

    expect(html).toContain('aria-label="Projects and sessions"');
    expect(html).toContain('aria-label="Agent workbench"');
    expect(html).toContain('aria-label="Context inspector"');
    expect(html).toContain('aria-label="Message composer"');
    expect(html).toContain('data-fixed-composer="true"');
    expect(html).toContain('aria-label="New session"');
    expect(html).toContain('aria-label="Search sessions"');
    expect(html).toContain('data-session-id="one"');
    expect(html).toContain('data-file-path="src/app.ts"');
    expect(html).toContain("Make it work");
    expect(html).toContain("Ready");
    expect(html).toContain('data-action="rename-session"');
    expect(html).toContain('data-action="archive-session"');
    expect(html).toContain('aria-label="Delete session"');
    expect(html).not.toContain('aria-label="Send message" disabled');
  });

  it("filters the rail by archive view and search text", () => {
    const sessions = [
      summary({ id: "a", title: "Refactor rail" }),
      summary({ id: "b", title: "Fix editor", archived: true }),
    ];
    expect(
      filterSessions(sessions, { search: "", archived: false }).map((s) => s.id),
    ).toEqual(["a"]);
    expect(
      filterSessions(sessions, { search: "", archived: true }).map((s) => s.id),
    ).toEqual(["b"]);
    expect(
      filterSessions(sessions, { search: "editor", archived: false }),
    ).toEqual([]);
    expect(
      filterSessions(sessions, { search: "FIX", archived: true }).map((s) => s.id),
    ).toEqual(["b"]);

    const searching = reduceDesktopState(readyWith({ sessions }), {
      type: "set-session-search",
      value: "refactor",
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(searching));
    expect(html).toContain('data-session-id="a"');
    expect(html).not.toContain('data-session-id="b"');
    expect(html).toContain('value="refactor"');
  });

  it("renders truthful lifecycle badges from persisted state", () => {
    const state = readyWith({
      sessions: [
        summary({ id: "s1", title: "Live turn", streaming: true }),
        summary({ id: "s2", title: "Broken turn", failed: true }),
        summary({ id: "s3", title: "Fresh draft", draft: true, messageCount: 0 }),
        summary({ id: "s4", title: "Background news", unread: true }),
      ],
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(state));
    expect(html).toContain('data-session-id="s1" data-status="streaming"');
    expect(html).toContain('data-session-id="s2" data-status="failed"');
    expect(html).toContain('data-session-id="s3" data-status="draft"');
    expect(html).toContain('data-session-id="s4" data-status="unread"');
  });

  it("offers the archived rail view only when archived sessions exist", () => {
    const plain = renderDesktopWorkbench(
      createDesktopViewModel(readyWith({})),
    );
    expect(plain).not.toContain('data-action="toggle-archived"');

    const withArchived = readyWith({
      sessions: [summary({ id: "a", title: "Old", archived: true })],
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(withArchived));
    expect(html).toContain('data-action="toggle-archived"');
    expect(html).toContain("Archived (1)");

    const showing = reduceDesktopState(withArchived, {
      type: "set-show-archived",
      show: true,
    });
    const archivedHtml = renderDesktopWorkbench(createDesktopViewModel(showing));
    expect(archivedHtml).toContain("Hide archived");
    expect(archivedHtml).toContain('data-session-id="a" data-status="idle" data-archived="true"');
  });

  it("renders inline rename and confirmed deletion surfaces", () => {
    let state = reduceDesktopState(readyWith({}), {
      type: "select-session",
      session: { id: "one", title: "Build desktop", messages: [] },
    });
    state = reduceDesktopState(state, { type: "set-renaming", renaming: true });
    const renameHtml = renderDesktopWorkbench(createDesktopViewModel(state));
    expect(renameHtml).toContain('aria-label="Rename session"');
    expect(renameHtml).toContain('value="Build desktop"');
    expect(renameHtml).toContain("Enter saves");

    const confirming = reduceDesktopState(
      reduceDesktopState(readyWith({}), {
        type: "select-session",
        session: { id: "one", title: "Build desktop", messages: [] },
      }),
      { type: "confirm-delete", sessionId: "one" },
    );
    const deleteHtml = renderDesktopWorkbench(createDesktopViewModel(confirming));
    expect(deleteHtml).toContain('aria-labelledby="delete-session-title"');
    expect(deleteHtml).toContain("Build desktop");
    expect(deleteHtml).toContain('data-action="confirm-delete-session"');
    expect(deleteHtml).toContain('data-action="cancel-delete"');

    const cancelled = reduceDesktopState(confirming, {
      type: "confirm-delete",
    });
    expect(cancelled.confirmDeleteId).toBeUndefined();
    const cleared = reduceDesktopState(confirming, { type: "clear-session" });
    expect(cleared.activeSession).toBeUndefined();
    expect(cleared.confirmDeleteId).toBeUndefined();
  });

  it("never attaches late events to the wrong session", () => {
    let state = reduceDesktopState(
      readyWith({
        sessions: [summary({ id: "one" }), summary({ id: "two", title: "Other" })],
      }),
      {
        type: "select-session",
        session: { id: "one", title: "Build desktop", messages: [] },
      },
    );
    state = reduceDesktopState(state, {
      type: "agent-event",
      event: { type: "assistant-delta", sessionId: "two", delta: "leaked?" },
    });
    state = reduceDesktopState(state, {
      type: "agent-event",
      event: { type: "complete", sessionId: "two", ok: true },
    });

    expect(state.streamingText).toBe("");
    expect(state.busy).toBe(false);
    expect(
      renderDesktopWorkbench(createDesktopViewModel(state)),
    ).not.toContain("leaked?");

    const own = reduceDesktopState(state, {
      type: "agent-event",
      event: { type: "assistant-delta", sessionId: "one", delta: "kept" },
    });
    expect(own.streamingText).toBe("kept");
  });

  it("lets a completing turn adopt its session only while it is still active", () => {
    const withActive = reduceDesktopState(
      readyWith({
        sessions: [summary({ id: "one" }), summary({ id: "two", title: "Other" })],
      }),
      {
        type: "select-session",
        session: { id: "one", title: "Build desktop", messages: [] },
      },
    );
    // The user stayed: the finishing turn may reload its own session.
    expect(shouldAdoptCompletedSession(withActive, "one")).toBe(true);

    // The user switched away mid-turn: completion is background truth and
    // must never yank the workbench back to the originating session.
    const switched = reduceDesktopState(withActive, {
      type: "select-session",
      session: { id: "two", title: "Other", messages: [] },
    });
    expect(shouldAdoptCompletedSession(switched, "one")).toBe(false);
    expect(switched.activeSession?.id).toBe("two");

    // No active session at all: nothing may be adopted.
    const cleared = reduceDesktopState(withActive, { type: "clear-session" });
    expect(shouldAdoptCompletedSession(cleared, "one")).toBe(false);
  });

  it("reports the session status line from lifecycle truth", () => {
    const drafty = reduceDesktopState(
      readyWith({ sessions: [summary({ id: "one", draft: true, messageCount: 0 })] }),
      {
        type: "select-session",
        session: { id: "one", title: "New session", messages: [] },
      },
    );
    expect(
      renderDesktopWorkbench(createDesktopViewModel(drafty)),
    ).toContain("Draft · send the first message");

    const failed = reduceDesktopState(
      readyWith({ sessions: [summary({ id: "one", failed: true })] }),
      {
        type: "select-session",
        session: { id: "one", title: "Build desktop", messages: [] },
      },
    );
    expect(
      renderDesktopWorkbench(createDesktopViewModel(failed)),
    ).toContain("Last turn failed");
  });

  it("renders streamed assistant text and tool activity", () => {
    let state = reduceDesktopState(readyWith({ sessions: [] }), {
      type: "select-session",
      session: { id: "one", title: "Live", messages: [] },
    });
    state = reduceDesktopState(state, {
      type: "agent-event",
      event: {
        type: "assistant-delta",
        sessionId: "one",
        delta: "Streaming now",
      },
    });
    state = reduceDesktopState(state, {
      type: "agent-event",
      event: { type: "tool-start", sessionId: "one", name: "read" },
    });

    expect(renderDesktopWorkbench(createDesktopViewModel(state))).toContain(
      "Streaming now",
    );
    const workflow = reduceDesktopState(state, {
      type: "select-view",
      view: "workflow",
    });
    expect(renderDesktopWorkbench(createDesktopViewModel(workflow))).toContain(
      "Running read",
    );
  });

  it("renders an editable file and tracks the dirty state", () => {
    let state = reduceDesktopState(readyWith({ sessions: [] }), {
      type: "select-file",
      file: { path: "src/app.ts", content: "const value = 1;", bytes: 16 },
    });
    state = reduceDesktopState(state, {
      type: "file-changed",
      content: "const value = 2;",
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(state));

    expect(html).toContain('aria-label="File content"');
    expect(html).toContain("const value = 2;");
    expect(html).toContain("Unsaved");
    expect(html).toContain('data-action="save-file"');
  });

  it("keeps the document locked to local content", () => {
    const html = renderDesktopShell(createDesktopViewModel("ready"));
    expect(html).toContain('meta name="color-scheme" content="light"');
    expect(html).toContain("color-scheme: light");
    expect(html).toContain(
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).toContain('<script src="./renderer-entry.js" defer></script>');
  });

  it("reduces bootstrap, navigation, and diagnostics state", () => {
    const initial = createInitialDesktopState();
    const ready = reduceDesktopState(initial, {
      type: "bootstrap-resolved",
      payload: { platform: "darwin", version: "0.1.0", workspaceName: "demo" },
    });
    const workflow = reduceDesktopState(ready, {
      type: "select-view",
      view: "workflow",
    });
    const diagnostics = reduceDesktopState(workflow, {
      type: "set-diagnostics",
      open: true,
    });
    expect(diagnostics).toMatchObject({
      phase: "ready",
      activeView: "workflow",
      diagnosticsOpen: true,
      bootstrap: {
        platform: "darwin",
        version: "0.1.0",
        workspaceName: "demo",
      },
    });
    expect(
      renderDesktopWorkbench(createDesktopViewModel(diagnostics)),
    ).toContain("macOS · 0.1.0");
  });

  it("renders a recoverable bootstrap failure", () => {
    const failed = reduceDesktopState(createInitialDesktopState(), {
      type: "bootstrap-rejected",
      message: "Desktop bridge unavailable",
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(failed));
    expect(failed.phase).toBe("error");
    expect(html).toContain("Desktop bridge unavailable");
    expect(html).toContain('data-action="retry-bootstrap"');
  });
});
