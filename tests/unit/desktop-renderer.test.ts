import { describe, expect, it } from "vitest";
import {
  createDesktopViewModel,
  renderDesktopShell,
} from "../../src/desktop/renderer.js";

describe("desktop workbench renderer", () => {
  it.each([
    ["empty", "Choose a project to begin"],
    ["loading", "Opening project"],
    ["ready", "Workspace ready"],
    ["error", "Project unavailable"],
  ] as const)("renders the %s state", (state, message) => {
    const html = renderDesktopShell(createDesktopViewModel(state));

    expect(html).toContain(`data-workbench-state="${state}"`);
    expect(html).toContain(message);
  });

  it("renders accessible workbench landmarks and a fixed composer", () => {
    const html = renderDesktopShell(createDesktopViewModel("ready"));

    expect(html).toContain('aria-label="Projects and sessions"');
    expect(html).toContain('aria-label="Agent workbench"');
    expect(html).toContain('aria-label="Context inspector"');
    expect(html).toContain('aria-label="Message composer"');
    expect(html).toContain('data-fixed-composer="true"');
    expect(html).toContain('meta name="color-scheme" content="dark"');
  });

  it("keeps the document locked to local content", () => {
    const html = renderDesktopShell(createDesktopViewModel("ready"));

    expect(html).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
  });
});
