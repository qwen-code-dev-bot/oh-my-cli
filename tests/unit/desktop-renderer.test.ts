import { describe, expect, it } from "vitest";
import {
  createDesktopViewModel,
  createInitialDesktopState,
  reduceDesktopState,
  renderDesktopShell,
  renderDesktopWorkbench,
} from "../../src/desktop/renderer.js";

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
    const ready = reduceDesktopState(createInitialDesktopState(), {
      type: "bootstrap-resolved",
      payload: { platform: "darwin", version: "0.1.0", workspaceName: "demo" },
      sessions: [
        { id: "one", title: "Build desktop", messageCount: 2, updatedAt: 1 },
      ],
      files: [{ path: "src/app.ts" }],
    });
    const selected = reduceDesktopState(ready, {
      type: "select-session",
      session: {
        id: "one",
        title: "Build desktop",
        messages: [
          { role: "user", content: "Make it work" },
          { role: "assistant", content: "Ready" },
        ],
      },
    });
    const html = renderDesktopWorkbench(createDesktopViewModel(selected));

    expect(html).toContain('aria-label="Projects and sessions"');
    expect(html).toContain('aria-label="Agent workbench"');
    expect(html).toContain('aria-label="Context inspector"');
    expect(html).toContain('aria-label="Message composer"');
    expect(html).toContain('data-fixed-composer="true"');
    expect(html).toContain('aria-label="New session"');
    expect(html).toContain('data-session-id="one"');
    expect(html).toContain('data-file-path="src/app.ts"');
    expect(html).toContain("Make it work");
    expect(html).toContain("Ready");
    expect(html).not.toContain('aria-label="Send message" disabled');
  });

  it("renders streamed assistant text and tool activity", () => {
    let state = reduceDesktopState(createInitialDesktopState(), {
      type: "bootstrap-resolved",
      payload: { platform: "darwin", version: "0.1.0", workspaceName: "demo" },
    });
    state = reduceDesktopState(state, {
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
    let state = reduceDesktopState(createInitialDesktopState(), {
      type: "bootstrap-resolved",
      payload: { platform: "darwin", version: "0.1.0", workspaceName: "demo" },
    });
    state = reduceDesktopState(state, {
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
