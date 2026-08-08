import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  generateBashCompletion,
  generateZshCompletion,
  zshDescribeText,
  completionFunctionName,
} from "../../src/shell-completion.js";

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

describe("zsh completion generation (Issue #779)", () => {
  // Hosts without zsh (like the local dev box) skip the validity check
  // honestly; CI runners have zsh, so the script is validated there.
  const zshAvailable = spawnSync("zsh", ["--version"]).status === 0;

  const flags = [
    { long: "--workspace", description: "Workspace root" },
    { long: "--prompt", short: "-p", description: "One-shot prompt" },
    { long: "--approval-mode", description: "Approval mode" },
  ];

  it("emits the #compdef header and compdef registration", () => {
    const script = generateZshCompletion("oh-my-cli", flags);
    expect(script.startsWith("#compdef oh-my-cli")).toBe(true);
    expect(script).toContain("compdef _oh_my_cli oh-my-cli");
    expect(script).toContain("_oh_my_cli() {");
    expect(script).toContain("_describe 'flag' flags");
  });

  it("enumerates every long flag with its description, sorted, none fabricated", () => {
    const script = generateZshCompletion("oh-my-cli", flags);
    expect(script).toContain("--workspace:Workspace root");
    expect(script).toContain("--prompt:One-shot prompt");
    expect(script).toContain("--approval-mode:Approval mode");
    expect(script.indexOf("--approval-mode")).toBeLessThan(script.indexOf("--prompt"));
    expect(script.indexOf("--prompt")).toBeLessThan(script.indexOf("--workspace"));
  });

  it("escapes colons and backslashes in descriptions for _describe", () => {
    expect(zshDescribeText("fails closed: no session")).toBe("fails closed\\: no session");
    expect(zshDescribeText("back\\slash")).toBe("back\\\\slash");
    const script = generateZshCompletion("x", [
      { long: "--resume", description: "fails closed: no session" },
    ]);
    expect(script).toContain("--resume:fails closed\\: no session");
  });

  it("omits the description field when a flag has none", () => {
    const script = generateZshCompletion("x", [{ long: "--only" }]);
    expect(script).toContain("'--only'");
  });

  it.runIf(zshAvailable)(
    "passes zsh -n when zsh is available on the host",
    () => {
      const script = generateZshCompletion("oh-my-cli", flags);
      const check = spawnSync("zsh", ["-n", "-c", script]);
      expect(check.status).toBe(0);
    },
  );
});
