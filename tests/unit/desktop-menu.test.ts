import { describe, it, expect, vi } from "vitest";
import { buildDesktopMenuTemplate } from "../../src/desktop/menu.js";

type TemplateItem = {
  role?: string;
  label?: string;
  click?: () => void;
  accelerator?: string;
  submenu?: TemplateItem[];
};

describe("buildDesktopMenuTemplate (Issue #523)", () => {
  it("keeps the standard roles and adds View zoom entries wired to the callback", () => {
    const onZoom = vi.fn();
    const template = buildDesktopMenuTemplate(onZoom, "linux") as TemplateItem[];

    // Standard app menus are preserved (Edit roles keep copy/paste/undo).
    expect(template.map((item) => item.role)).toEqual(
      expect.arrayContaining(["fileMenu", "editMenu", "windowMenu"]),
    );

    const view = template.find((item) => item.label === "View");
    expect(view?.submenu).toBeDefined();
    const byLabel = new Map(
      (view?.submenu ?? [])
        .filter((item) => typeof item.label === "string")
        .map((item) => [item.label, item]),
    );
    expect([...byLabel.keys()]).toEqual(["Actual Size", "Zoom In", "Zoom Out"]);

    byLabel.get("Zoom In")?.click?.();
    byLabel.get("Zoom Out")?.click?.();
    byLabel.get("Actual Size")?.click?.();
    expect(onZoom.mock.calls.map((call) => call[0])).toEqual([
      "zoom-in",
      "zoom-out",
      "zoom-reset",
    ]);
  });

  it("zoom entries carry no accelerators (single keyboard path)", () => {
    const template = buildDesktopMenuTemplate(() => {}, "linux") as TemplateItem[];
    const view = template.find((item) => item.label === "View");
    for (const item of view?.submenu ?? []) {
      expect(item.accelerator).toBeUndefined();
    }
  });

  it("includes the macOS app menu only on darwin", () => {
    const darwin = buildDesktopMenuTemplate(() => {}, "darwin") as TemplateItem[];
    expect(darwin[0].role).toBe("appMenu");
    const linux = buildDesktopMenuTemplate(() => {}, "linux") as TemplateItem[];
    expect(linux[0].role).not.toBe("appMenu");
  });
});
