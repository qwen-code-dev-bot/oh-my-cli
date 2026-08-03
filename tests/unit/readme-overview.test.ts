import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Pins the fix for community report #524 (execution issue #528): the README
// must open with a short orientation section — what the repo is, what makes
// it different, and a dot-point feature map — before the policies block. Also
// guards the section's jump links against rot.

const readmePath = path.resolve(import.meta.dirname, "../../README.md");
const readme = fs.readFileSync(readmePath, "utf-8");
const lines = readme.split("\n");

function headingIndex(heading: string): number {
  const index = lines.findIndex((line) => line.trim() === heading);
  expect(index, `heading "${heading}" not found in README.md`).toBeGreaterThanOrEqual(0);
  return index;
}

function sectionOf(heading: string): string {
  const start = headingIndex(heading);
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+/.test(line) && /^#+/.exec(line)![0].length <= level,
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

// GitHub-style anchor slug: lowercase, spaces to hyphens, drop other
// punctuation. Matches how the README's own anchors are generated.
function slugify(headingText: string): string {
  return headingText
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "");
}

describe("README orientation section (Issue #528)", () => {
  it("opens with the orientation section before Project policies", () => {
    const overview = headingIndex("## What is oh-my-cli?");
    const policies = headingIndex("## Project policies");
    expect(overview).toBeLessThan(policies);
  });

  it("carries a differentiator blurb and a dot-point feature map", () => {
    const section = sectionOf("## What is oh-my-cli?");
    expect(section).toContain("What makes it different");
    const bullets = section.split("\n").filter((line) => /^- /.test(line.trim()));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
    // The documented differentiating themes stay present.
    expect(section).toContain("Safety is the product");
    expect(section).toContain("Durable sessions");
    expect(section).toContain("Headless-first automation");
    expect(section).toContain("Beyond the terminal");
    expect(section).toContain("Develops itself");
  });

  it("links only to anchors that exist in the README (no link rot)", () => {
    const section = sectionOf("## What is oh-my-cli?");
    const anchors = [...section.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);
    expect(anchors.length).toBeGreaterThanOrEqual(10);

    const headingSlugs = lines
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => slugify(line.replace(/^#{1,6} /, "")));
    for (const anchor of anchors) {
      expect(headingSlugs, `broken anchor "#${anchor}" in orientation section`).toContain(anchor);
    }
  });
});
