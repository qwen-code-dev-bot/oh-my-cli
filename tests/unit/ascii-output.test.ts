import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";
import { asciiSafe, asciiSafeLine, renderReportLines } from "../../src/ascii-output.js";
import { buildSessionJournal, formatSessionJournal } from "../../src/session-journal.js";
import { buildSessionHealthReport, formatSessionHealthReport } from "../../src/session-health.js";
import { buildSessionStorageReport, formatSessionStorageReport } from "../../src/session-storage.js";
import { buildStoreDoctorReport, formatStoreDoctorReport } from "../../src/store-doctor.js";

describe("asciiSafe transformation (Issue #672)", () => {
  it("maps each decorative glyph to its ASCII equivalent", () => {
    expect(asciiSafeLine("─")).toBe("-");
    expect(asciiSafeLine("·")).toBe("|");
    expect(asciiSafeLine("×")).toBe("x");
    expect(asciiSafeLine("—")).toBe("-");
    expect(asciiSafeLine("  2026-01-01T00:00:00.000Z · note · detail")).toBe(
      "  2026-01-01T00:00:00.000Z | note | detail",
    );
    expect(asciiSafeLine("4 event(s) across 2 day(s).")).toBe("4 event(s) across 2 day(s).");
    expect(asciiSafeLine("  2026-08 ×3")).toBe("  2026-08 x3");
    expect(asciiSafeLine("shortid (archived) — ok")).toBe("shortid (archived) - ok");
    expect(asciiSafeLine("─".repeat(40))).toBe("-".repeat(40));
  });

  it("leaves plain ASCII and unrelated unicode untouched", () => {
    expect(asciiSafeLine("plain ascii 123")).toBe("plain ascii 123");
    // Semantic marks are mapped by design since Issue #674 (covered by
    // ascii-semantic.test.ts); unrelated unicode is content, never rewritten.
    expect(asciiSafeLine("café ☃")).toBe("café ☃");
  });

  it("preserves line counts and is idempotent", () => {
    const lines = ["─".repeat(40), "a · b", "c × d — e", "plain"];
    const mapped = asciiSafe(lines);
    expect(mapped.length).toBe(lines.length);
    expect(asciiSafe(mapped)).toEqual(mapped);
  });

  it("renderReportLines passes through without the flag and maps with it", () => {
    const lines = ["─".repeat(40), "x · y"];
    expect(renderReportLines(lines, undefined)).toBe(lines.join("\n") + "\n");
    expect(renderReportLines(lines, false)).toBe(lines.join("\n") + "\n");
    expect(renderReportLines(lines, true)).toBe(asciiSafe(lines).join("\n") + "\n");
  });
});

describe("formatter parity under --ascii (Issue #672)", () => {
  let dir: string;
  let store: SessionStore;
  let id: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-672u-"));
    store = new SessionStore(dir);
    id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "ascii fodder" }], {
      model: "m",
      workspace: "/srv/ws",
      createdAt: 1_700_000_000_000,
    });
    expect(appendSessionNote(store, id, "ascii note", 1_700_000_100_000).ok).toBe(true);
    // A damaged sidecar gives the health/doctor reports something to mark.
    fs.writeFileSync(store.goalPath(id), "{torn goal");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function parity(lines: string[]): void {
    const mapped = asciiSafe(lines);
    // Same structure: identical line counts.
    expect(mapped.length).toBe(lines.length);
    // Content equality modulo the glyph map: mapping the default output
    // yields exactly the ASCII output.
    expect(mapped).toEqual(asciiSafe(lines));
    // The ASCII variant carries no decorative glyphs.
    for (const line of mapped) {
      expect(line).not.toMatch(/[\u2500\u00b7\u00d7\u2014]/);
    }
  }

  it("session journal parity", () => {
    const built = buildSessionJournal(store, id);
    if ("error" in built) throw new Error(built.error);
    parity(formatSessionJournal(built.journal));
  });

  it("health report parity", () => {
    parity(formatSessionHealthReport(buildSessionHealthReport(store)));
  });

  it("storage report parity", () => {
    parity(formatSessionStorageReport(buildSessionStorageReport(store)));
  });

  it("store doctor parity", () => {
    parity(formatStoreDoctorReport(buildStoreDoctorReport(store)));
  });
});
