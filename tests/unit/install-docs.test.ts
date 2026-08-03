import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Pins the fix for community report #522 (execution issue #526): the
// documented install path must include `npm link` so following the docs puts
// the `oh-my-cli` command on PATH. The package already declares the bin entry
// (`package.json` → dist/index.js with a node shebang); this test keeps the
// docs honest so a future edit cannot silently drop the step.

function sectionOf(file: string, heading: string): string {
  const md = fs.readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf-8");
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  expect(start, `heading "${heading}" not found in ${file}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+/.test(line) && /^#+/.exec(line)![0].length <= level,
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

describe("install docs include the npm link step (Issue #526)", () => {
  it("README Install documents link and unlink", () => {
    const section = sectionOf("README.md", "## Install");
    expect(section).toContain("npm install");
    expect(section).toContain("npm run build");
    expect(section).toContain("npm link");
    expect(section).toContain("npm unlink -g oh-my-cli");
  });

  it("FIRST-RUN section 1 documents the same link step", () => {
    const section = sectionOf("docs/FIRST-RUN.md", "## 1. Install");
    expect(section).toContain("npm install");
    expect(section).toContain("npm run build");
    expect(section).toContain("npm link");
    expect(section).toContain("npm unlink -g oh-my-cli");
  });

  it("package.json still declares the bin entry the link step relies on", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin?.["oh-my-cli"]).toBe("./dist/index.js");
  });
});
