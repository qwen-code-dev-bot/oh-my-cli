import { describe, it, expect } from "vitest";
import {
  VERSION,
  WIDE_WORDMARK,
  MEDIUM_MARK,
  detectColorDepth,
  selectBannerVariant,
  buildProductBanner,
  colorizeBannerRow,
  renderProductBanner,
  formatProductBanner,
} from "../../src/product-banner.js";
import type { BannerModel } from "../../src/product-banner.js";

const ESC = "\x1b";

function stripAnsi(s: string): string {
  // Remove CSI SGR sequences (\x1b[ ... m) for visible-length assertions.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const sample: BannerModel = {
  version: "0.1.0",
  model: "gpt-4o",
  workspace: "~/dev/proj",
  authReady: true,
  approvalMode: "default",
};

describe("block art geometry", () => {
  it("wide wordmark is a rectangular 6x89 ANSI Shadow grid", () => {
    expect(WIDE_WORDMARK).toHaveLength(6);
    for (const row of WIDE_WORDMARK) {
      expect([...row].length).toBe(89);
    }
    expect(WIDE_WORDMARK.join("\n")).toContain("██╔═══██╗");
    expect(WIDE_WORDMARK.join("\n")).toContain("╚══▀▀═╝");
  });

  it("medium mark is the exact compact product label", () => {
    expect(MEDIUM_MARK).toHaveLength(1);
    for (const row of MEDIUM_MARK) {
      expect([...row].length).toBe(11);
    }
  });

  it("art contains no controls, bidirectional marks, or zero-width glyphs", () => {
    for (const row of [...WIDE_WORDMARK, ...MEDIUM_MARK]) {
      expect(row).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(row).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/);
    }
  });
});

describe("detectColorDepth", () => {
  it("is none when the --no-color flag is set", () => {
    expect(detectColorDepth({ noColor: true, env: { COLORTERM: "truecolor" }, isTTY: true })).toBe("none");
  });

  it("is none for a non-empty NO_COLOR", () => {
    expect(detectColorDepth({ env: { NO_COLOR: "1" }, isTTY: true })).toBe("none");
    expect(detectColorDepth({ env: { NO_COLOR: "0" }, isTTY: true })).toBe("none");
  });

  it("is none when not a TTY", () => {
    expect(detectColorDepth({ env: { COLORTERM: "truecolor" }, isTTY: false })).toBe("none");
  });

  it("detects truecolor from COLORTERM", () => {
    expect(detectColorDepth({ env: { COLORTERM: "truecolor" }, isTTY: true })).toBe("truecolor");
    expect(detectColorDepth({ env: { COLORTERM: "24bit" }, isTTY: true })).toBe("truecolor");
  });

  it("detects 256 from TERM", () => {
    expect(detectColorDepth({ env: { TERM: "xterm-256color" }, isTTY: true })).toBe("256");
  });

  it("falls back to basic for ordinary terminals", () => {
    expect(detectColorDepth({ env: { TERM: "xterm" }, isTTY: true })).toBe("basic");
    expect(detectColorDepth({ env: {}, isTTY: true })).toBe("basic");
  });
});

describe("selectBannerVariant", () => {
  it("selects plain when color is disabled", () => {
    expect(selectBannerVariant(200, "none")).toBe("plain");
  });

  it("selects plain for narrow terminals", () => {
    expect(selectBannerVariant(10, "truecolor")).toBe("plain");
  });

  it("selects medium for mid-width terminals", () => {
    expect(selectBannerVariant(40, "truecolor")).toBe("medium");
  });

  it("selects wide for wide terminals", () => {
    expect(selectBannerVariant(120, "truecolor")).toBe("wide");
  });
});

describe("buildProductBanner", () => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  it("redacts a home-prefixed workspace to ~", () => {
    if (!home) return;
    const b = buildProductBanner({
      version: VERSION,
      model: "gpt-4o",
      workspace: home + "/dev/proj",
      authReady: true,
      approvalMode: "default",
    });
    expect(b.workspace).toBe("~/dev/proj");
    expect(b.workspace).not.toContain(home);
  });

  it("carries no credential fields into the model", () => {
    const b = buildProductBanner({
      version: VERSION,
      model: "gpt-4o",
      workspace: "/srv/app",
      authReady: true,
      approvalMode: "yolo",
    });
    expect(Object.keys(b).sort()).toEqual(
      ["approvalMode", "authReady", "model", "version", "workspace"],
    );
  });
});

describe("renderProductBanner", () => {
  it("plain variant is pure ASCII art with no ANSI escapes", () => {
    const out = renderProductBanner(sample, { variant: "plain", depth: "none" });
    expect(out).not.toContain(ESC);
    expect(out).toContain("Qwen3.8-Max");
    expect(out).not.toContain("█");
    expect(out).toContain("v0.1.0");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("auth ready");
    expect(out).toContain("approval default");
  });

  it("wide truecolor emits 24-bit color and block glyphs", () => {
    const out = renderProductBanner(sample, { variant: "wide", depth: "truecolor", width: 100 });
    expect(out).toContain("\x1b[1;38;2;");
    expect(out).toContain("\x1b[0m");
    expect(stripAnsi(out)).toContain("██╔═══██╗");
  });

  it("256 depth emits indexed color", () => {
    const out = renderProductBanner(sample, { variant: "wide", depth: "256", width: 100 });
    expect(out).toContain("\x1b[1;38;5;");
  });

  it("applies a left-to-right blue, violet, and rose gradient within one row", () => {
    const out = colorizeBannerRow("█".repeat(60), "256");
    expect(out).toContain("\x1b[1;38;5;75m");
    expect(out).toContain("\x1b[1;38;5;99m");
    expect(out).toContain("\x1b[1;38;5;175m");
  });

  it("basic depth emits 16-color bold SGR", () => {
    const out = renderProductBanner(sample, { variant: "medium", depth: "basic", width: 30 });
    expect(out).toMatch(/\x1b\[1;3[0-9]m/);
  });

  it("never overflows the metadata line beyond the width", () => {
    const wide = { ...sample, workspace: "~/a/very/deeply/nested/workspace/path/segment" };
    const out = renderProductBanner(wide, { variant: "medium", depth: "truecolor", width: 24 });
    const lastLine = out.split("\n").at(-1)!;
    expect([...stripAnsi(lastLine)].length).toBeLessThanOrEqual(24);
  });

  it("is deterministic for identical inputs", () => {
    const a = renderProductBanner(sample, { variant: "wide", depth: "truecolor", width: 100 });
    const b = renderProductBanner(sample, { variant: "wide", depth: "truecolor", width: 100 });
    expect(a).toBe(b);
  });
});

describe("formatProductBanner", () => {
  const base = {
    version: VERSION,
    model: "gpt-4o",
    workspace: "/srv/app",
    authReady: true,
    approvalMode: "default",
  };

  it("renders the wide wordmark on a capable wide terminal", () => {
    const out = formatProductBanner({
      ...base,
      width: 120,
      env: { COLORTERM: "truecolor" },
      isTTY: true,
    });
    expect(stripAnsi(out)).toContain(WIDE_WORDMARK[0]);
    expect(out).toContain("\x1b[1;38;2;");
  });

  it("renders the compact mark on a mid-width terminal", () => {
    const out = formatProductBanner({
      ...base,
      width: 40,
      env: { COLORTERM: "truecolor" },
      isTTY: true,
    });
    expect(stripAnsi(out)).toContain("Qwen3.8-Max");
    expect(out.split("\n").filter((l) => stripAnsi(l).includes("Qwen3.8-Max")).length).toBe(MEDIUM_MARK.length);
  });

  it("falls back to plain ASCII when NO_COLOR is set", () => {
    const out = formatProductBanner({
      ...base,
      width: 120,
      env: { NO_COLOR: "1", COLORTERM: "truecolor" },
      isTTY: true,
    });
    expect(out).not.toContain(ESC);
    expect(out).toContain("Qwen3.8-Max");
    expect(out).not.toContain("█");
  });

  it("falls back to plain ASCII on a narrow terminal", () => {
    const out = formatProductBanner({
      ...base,
      width: 12,
      env: { COLORTERM: "truecolor" },
      isTTY: true,
    });
    expect(stripAnsi(out)).toContain("Qwen3.8-Max");
    expect(out).not.toContain("█");
  });
});
