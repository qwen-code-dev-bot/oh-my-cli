import { describe, it, expect } from "vitest";
import { generateBashCompletion, completionFunctionName } from "../../src/shell-completion.js";

describe("shell completion generation (Issue #777)", () => {
  const flags = [
    { long: "--workspace", description: "Workspace root" },
    { long: "--prompt", short: "-p", description: "One-shot prompt" },
    { long: "--approval-mode", description: "Approval mode" },
  ];

  it("sanitizes the command name into a safe function name", () => {
    expect(completionFunctionName("oh-my-cli")).toBe("_oh_my_cli");
    expect(completionFunctionName("weird.name")).toBe("_weird_name");
  });

  it("generates a complete -o default script bound to the command name", () => {
    const script = generateBashCompletion("oh-my-cli", flags);
    expect(script).toContain("complete -o default -F _oh_my_cli oh-my-cli");
    expect(script).toContain("_oh_my_cli() {");
  });

  it("enumerates every long flag and any short forms, sorted, none fabricated", () => {
    const script = generateBashCompletion("oh-my-cli", flags);
    expect(script).toContain("--workspace");
    expect(script).toContain("--prompt");
    expect(script).toContain("--approval-mode");
    expect(script).toContain("-p");
    // Sorted word list: approval-mode before prompt before workspace.
    expect(script.indexOf("--approval-mode")).toBeLessThan(script.indexOf("--prompt"));
    expect(script.indexOf("--prompt")).toBeLessThan(script.indexOf("--workspace"));
  });

  it("omits short forms that do not exist", () => {
    const script = generateBashCompletion("x", [{ long: "--only" }]);
    expect(script).toContain("--only");
    // Only one word for the flag (no fabricated short).
    expect(script.match(/--only/g)?.length).toBe(1);
  });

  it("produces a script with balanced bash structure", () => {
    const script = generateBashCompletion("oh-my-cli", flags);
    expect(script).toContain("COMPREPLY=");
    expect(script).toContain("compgen -W");
    expect((script.match(/{/g) ?? []).length).toBe((script.match(/}/g) ?? []).length);
  });
});
