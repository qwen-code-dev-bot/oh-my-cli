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
    ["empty", "Choose a project to begin"],
    ["loading", "Opening the Desktop workbench"],
    ["ready", "Desktop foundation ready"],
    ["error", "Desktop bridge unavailable"],
  ] as const)("renders the %s state", (state, message) => {
    const html = renderDesktopShell(createDesktopViewModel(state));

    expect(html).toContain(`data-workbench-state="${state}"`);
    expect(html).toContain(message);
  });

  it("renders accessible workbench landmarks and a fixed composer", () => {
    const html = renderDesktopWorkbench(
      createDesktopViewModel("ready"),
    );

    expect(html).toContain('aria-label="Projects and sessions"');
    expect(html).toContain('aria-label="Agent workbench"');
    expect(html).toContain('aria-label="Context inspector"');
    expect(html).toContain('aria-label="Message composer"');
    expect(html).toContain('data-fixed-composer="true"');
    expect(html).toContain('aria-label="Primary workbench views"');
    expect(html).toContain('data-capability="session-continuity"');
    expect(html).toContain("Requires #133");
    expect(html).toContain("Landed · #128");
    expect(html).toContain("Landed · #132");
    expect(html).not.toContain("MERGE READY");
    expect(html).not.toContain("Terminal E2E</span><strong>PASS");
  });

  it("keeps the document locked to local content", () => {
    const html = renderDesktopShell(createDesktopViewModel("ready"));

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
      payload: { platform: "darwin", version: "0.1.0" },
    });
    const workflow = reduceDesktopState(ready, {
      type: "select-view",
      view: "workflow",
    });
    const diagnostics = reduceDesktopState(workflow, {
      type: "set-diagnostics",
      open: true,
    });

    expect(initial.phase).toBe("loading");
    expect(diagnostics).toMatchObject({
      phase: "ready",
      activeView: "workflow",
      diagnosticsOpen: true,
      bootstrap: { platform: "darwin", version: "0.1.0" },
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
