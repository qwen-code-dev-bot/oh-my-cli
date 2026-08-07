import { describe, it, expect } from "vitest";
import { corruptStoreWarning, redactStorePath } from "../../src/readline-store-warnings.js";

describe("readline store warnings (Issue #739)", () => {
  it("redacts the home prefix to ~ and leaves other paths untouched", () => {
    expect(redactStorePath("/home/u/.oh-my-cli/drafts/x.json", "/home/u")).toBe(
      "~/.oh-my-cli/drafts/x.json",
    );
    expect(redactStorePath("/etc/elsewhere/x.json", "/home/u")).toBe("/etc/elsewhere/x.json");
    expect(redactStorePath("/home/u/.oh-my-cli/drafts/x.json", undefined)).toBe(
      "/home/u/.oh-my-cli/drafts/x.json",
    );
  });

  it("warns about a corrupt draft with the consequence and the redacted file path", () => {
    const home = process.env.HOME ?? "/root";
    const line = corruptStoreWarning("composer draft", `${home}/.oh-my-cli/drafts/abc.json`);
    expect(line).toContain("composer draft could not be restored");
    expect(line).toContain("starting with an empty composer");
    expect(line).toContain("~/.oh-my-cli/drafts/abc.json");
  });

  it("warns about corrupt prompt history with the consequence and the redacted file path", () => {
    const home = process.env.HOME ?? "/root";
    const line = corruptStoreWarning("prompt history", `${home}/.oh-my-cli/prompt-history/abc.json`);
    expect(line).toContain("prompt history could not be restored");
    expect(line).toContain("starting with an empty recall");
    expect(line).toContain("~/.oh-my-cli/prompt-history/abc.json");
  });

  it("stays single-line and content-free", () => {
    for (const kind of ["composer draft", "prompt history"] as const) {
      const line = corruptStoreWarning(kind, "/home/u/.oh-my-cli/drafts/abc.json");
      expect(line.includes("\n")).toBe(false);
      // Only the fact and the path — never store content.
      expect(line.startsWith("Warning:")).toBe(true);
    }
  });
});
