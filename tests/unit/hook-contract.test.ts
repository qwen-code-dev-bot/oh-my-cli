import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_CONTRACT_SCHEMA,
  HOOK_CONTRACT_VERSION,
  SUPPORTED_HOOK_CONTRACT_VERSIONS,
  parseHookContract,
  resolvePreToolUseHooks,
  hookMatches,
  evaluatePreToolUseHooks,
  collectHookList,
  formatHookList,
  type HookRunner,
  type HookRunResult,
  type HookRunOptions,
  type PreToolUseHook,
} from "../../src/hook-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-hook-contract-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

// A fake runner so the decision logic is exercised deterministically without
// spawning real processes.
function fakeRunner(result: Partial<HookRunResult>): HookRunner {
  return async () => ({
    exitCode: 0,
    timedOut: false,
    outputCapped: false,
    stdout: "",
    stderr: "",
    ...result,
  });
}

const SHELL_HOOK: PreToolUseHook = { matcher: "shell", command: "/usr/bin/guard", args: [] };

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseHookContract: version negotiation", () => {
  it("accepts a supported contract version with one hook", () => {
    const contract = parseHookContract({
      contractVersion: 1,
      PreToolUse: [{ matcher: "shell", command: "/usr/bin/guard", args: ["--strict"] }],
    });
    expect(contract.contractVersion).toBe(1);
    expect(contract.preToolUse).toHaveLength(1);
    expect(contract.preToolUse[0]).toEqual({
      matcher: "shell",
      command: "/usr/bin/guard",
      args: ["--strict"],
    });
    expect(SUPPORTED_HOOK_CONTRACT_VERSIONS).toContain(HOOK_CONTRACT_VERSION);
  });

  it("accepts the wildcard matcher and defaults args to []", () => {
    const contract = parseHookContract({
      contractVersion: 1,
      PreToolUse: [{ matcher: "*", command: "guard" }],
    });
    expect(contract.preToolUse[0].matcher).toBe("*");
    expect(contract.preToolUse[0].args).toEqual([]);
  });

  it("treats a hooks section with no PreToolUse event as an empty inventory", () => {
    const contract = parseHookContract({ contractVersion: 1 });
    expect(contract.preToolUse).toEqual([]);
  });

  it("fails closed when contractVersion is missing", () => {
    expect(() => parseHookContract({ PreToolUse: [] })).toThrow(/contractVersion is required/);
  });

  it("fails closed on an unsupported contract version", () => {
    expect(() => parseHookContract({ contractVersion: 99, PreToolUse: [] })).toThrow(/not supported/);
  });

  it("fails closed on a non-integer contract version", () => {
    expect(() => parseHookContract({ contractVersion: 1.5, PreToolUse: [] })).toThrow(/must be an integer/);
  });
});

describe("parseHookContract: strict validation (fail closed)", () => {
  it("rejects a non-object section", () => {
    expect(() => parseHookContract([])).toThrow(/settings\.hooks must be an object/);
  });

  it("rejects an unknown envelope key", () => {
    expect(() => parseHookContract({ contractVersion: 1, PostToolUse: [] })).toThrow(/unknown key/);
  });

  it("rejects a non-array PreToolUse", () => {
    expect(() => parseHookContract({ contractVersion: 1, PreToolUse: {} })).toThrow(/must be an array/);
  });

  it("rejects a non-object entry", () => {
    expect(() => parseHookContract({ contractVersion: 1, PreToolUse: ["nope"] })).toThrow(
      /PreToolUse\[0\] must be an object/,
    );
  });

  it("rejects an unknown key in an entry", () => {
    expect(() =>
      parseHookContract({
        contractVersion: 1,
        PreToolUse: [{ matcher: "shell", command: "guard", when: "always" }],
      }),
    ).toThrow(/unrecognized|unknown/i);
  });

  it("rejects a raw credential field in an entry", () => {
    expect(() =>
      parseHookContract({
        contractVersion: 1,
        PreToolUse: [{ matcher: "shell", command: "guard", token: "leaked" }],
      }),
    ).toThrow(/raw credential field/);
  });

  it("rejects an invalid matcher", () => {
    expect(() =>
      parseHookContract({ contractVersion: 1, PreToolUse: [{ matcher: "Shell*", command: "g" }] }),
    ).toThrow(/matcher/);
  });

  it("rejects an empty command", () => {
    expect(() =>
      parseHookContract({ contractVersion: 1, PreToolUse: [{ matcher: "shell", command: "" }] }),
    ).toThrow(/command must be a non-empty string/);
  });
});

describe("resolvePreToolUseHooks: user-scope-only resolution", () => {
  it("returns the declared hooks from the user settings file", () => {
    const p = writeSettings({
      hooks: { contractVersion: 1, PreToolUse: [{ matcher: "shell", command: "guard" }] },
    });
    const hooks = resolvePreToolUseHooks({ settingsPath: p });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].matcher).toBe("shell");
  });

  it("returns [] when there is no hooks section", () => {
    const p = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    expect(resolvePreToolUseHooks({ settingsPath: p })).toEqual([]);
  });

  it("returns [] when the settings file is missing", () => {
    expect(resolvePreToolUseHooks({ settingsPath: missingPath() })).toEqual([]);
  });

  it("fails closed (throws) on a present-but-malformed hooks section", () => {
    const p = writeSettings({ hooks: { contractVersion: 99, PreToolUse: [] } });
    expect(() => resolvePreToolUseHooks({ settingsPath: p })).toThrow(/not supported/);
  });

  it("never reads a project-local file (user scope only)", () => {
    // The user file has no hooks; a sibling project file declares one. Resolution
    // takes only the user path, so the project hook is never seen.
    const userPath = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const projectPath = writeSettings({
      hooks: { contractVersion: 1, PreToolUse: [{ matcher: "*", command: "evil" }] },
    });
    const hooks = resolvePreToolUseHooks({ settingsPath: userPath });
    expect(hooks).toEqual([]);
    expect(JSON.stringify(hooks)).not.toContain("evil");
    expect(projectPath).toBeTruthy(); // the project file exists but is never consulted
  });
});

describe("hookMatches", () => {
  it("matches the wildcard for any tool", () => {
    expect(hookMatches({ matcher: "*", command: "g", args: [] }, "write")).toBe(true);
    expect(hookMatches({ matcher: "*", command: "g", args: [] }, "shell")).toBe(true);
  });

  it("matches an exact tool name only", () => {
    expect(hookMatches(SHELL_HOOK, "shell")).toBe(true);
    expect(hookMatches(SHELL_HOOK, "write")).toBe(false);
  });
});

describe("evaluatePreToolUseHooks: deny-only decisions", () => {
  const cwd = tmpDir();
  const ctx = { toolName: "shell", toolInput: { command: "rm -rf /" } };

  it("is silent when no hook matches the tool", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], { toolName: "write", toolInput: {} }, { cwd, runner: fakeRunner({ exitCode: 2 }) });
    expect(d.denied).toBe(false);
  });

  it("denies on exit code 2", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner: fakeRunner({ exitCode: 2 }) });
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/exit 2/);
  });

  it("denies on a JSON permissionDecision of deny with a reason", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "deny", reason: "blocked by org policy" }),
    });
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner });
    expect(d.denied).toBe(true);
    expect(d.reason).toContain("blocked by org policy");
  });

  it("treats an allow decision as silence (a hook can never relax)", async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ permissionDecision: "allow" }),
    });
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner });
    expect(d.denied).toBe(false);
  });

  it("treats exit 0 with no decision as silence", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner: fakeRunner({ exitCode: 0 }) });
    expect(d.denied).toBe(false);
  });

  it("treats a non-blocking non-zero exit (not 2) as silence", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner: fakeRunner({ exitCode: 1 }) });
    expect(d.denied).toBe(false);
  });

  it("fails closed (denies) on a timeout", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner: fakeRunner({ timedOut: true }) });
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/timeout/i);
  });

  it("fails closed (denies) on a spawn error", async () => {
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, {
      cwd,
      runner: fakeRunner({ exitCode: null, spawnError: "ENOENT" }),
    });
    expect(d.denied).toBe(true);
    expect(d.reason).toMatch(/failed to start/i);
  });

  it("stops at the first denying hook", async () => {
    const calls: string[] = [];
    const deny: HookRunner = async () => {
      calls.push("deny");
      return { exitCode: 2, timedOut: false, outputCapped: false, stdout: "", stderr: "" };
    };
    const never: HookRunner = async () => {
      calls.push("never");
      return { exitCode: 0, timedOut: false, outputCapped: false, stdout: "", stderr: "" };
    };
    const hooks: PreToolUseHook[] = [
      { matcher: "shell", command: "first", args: [] },
      { matcher: "shell", command: "second", args: [] },
    ];
    // A composite runner: first hook denies, so the second must not run.
    let n = 0;
    const composite: HookRunner = async (opts) => {
      const r = n++ === 0 ? deny : never;
      return r(opts);
    };
    const d = await evaluatePreToolUseHooks(hooks, ctx, { cwd, runner: composite });
    expect(d.denied).toBe(true);
    expect(calls).toEqual(["deny"]);
  });

  it("redacts secrets and the home path in the deny reason", async () => {
    const home = process.env.HOME ?? "";
    const runner = fakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        permissionDecision: "deny",
        reason: `blocked sk-aaaaaaaaaaaaaaaaaaaa at ${home}/secret.txt`,
      }),
    });
    const d = await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner });
    expect(d.denied).toBe(true);
    expect(d.reason).toContain("[REDACTED]");
    expect(d.reason).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
    if (home) {
      expect(d.reason).not.toContain(`${home}/secret.txt`);
      expect(d.reason).toContain("~");
    }
  });

  it("hands the tool-call context to the runner on stdin as JSON", async () => {
    let captured: HookRunOptions | null = null;
    const runner: HookRunner = async (opts) => {
      captured = opts;
      return { exitCode: 0, timedOut: false, outputCapped: false, stdout: "", stderr: "" };
    };
    await evaluatePreToolUseHooks([SHELL_HOOK], ctx, { cwd, runner });
    expect(captured).not.toBeNull();
    const input = JSON.parse(captured!.input);
    expect(input.hook_event_name).toBe("PreToolUse");
    expect(input.tool_name).toBe("shell");
    expect(input.tool_input).toEqual({ command: "rm -rf /" });
    expect(captured!.cwd).toBe(cwd);
  });
});

describe("collectHookList / formatHookList", () => {
  it("lists declared hooks with a redacted command and an arg count", () => {
    const home = process.env.HOME ?? os.homedir();
    const p = path.join(tmpDir(), "settings.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          contractVersion: 1,
          PreToolUse: [{ matcher: "shell", command: `${home}/bin/guard`, args: ["--strict", "-v"] }],
        },
      }),
    );
    const report = collectHookList({ settingsPath: p });
    expect(report.schema).toBe(HOOK_CONTRACT_SCHEMA);
    expect(report.contractVersion).toBe(1);
    expect(report.hooks).toHaveLength(1);
    expect(report.hooks[0].event).toBe("PreToolUse");
    expect(report.hooks[0].matcher).toBe("shell");
    expect(report.hooks[0].args).toBe(2);
    // The home path is collapsed to ~ in the listing.
    expect(report.hooks[0].command).toContain("~");
    expect(report.hooks[0].command).not.toContain(home);
  });

  it("reports an empty inventory when there is no hooks section", () => {
    const p = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectHookList({ settingsPath: p });
    expect(report.hooks).toEqual([]);
    expect(formatHookList(report)).toContain("PreToolUse: (none)");
  });

  it("marks the settings path (not found) when the file is missing", () => {
    const report = collectHookList({ settingsPath: missingPath() });
    expect(report.hooks).toEqual([]);
    expect(report.settings).toContain("(not found)");
  });

  it("fails closed (throws) on a malformed hooks section", () => {
    const p = writeSettings({
      hooks: { contractVersion: 1, PreToolUse: [{ matcher: "shell", command: "g", token: "x" }] },
    });
    expect(() => collectHookList({ settingsPath: p })).toThrow(/raw credential field/);
  });

  it("renders a human-readable list with the matcher and command", () => {
    const p = writeSettings({
      hooks: { contractVersion: 1, PreToolUse: [{ matcher: "shell", command: "guard", args: [] }] },
    });
    const text = formatHookList(collectHookList({ settingsPath: p }));
    expect(text).toContain("PreToolUse: 1");
    expect(text).toContain("shell");
    expect(text).toContain("guard");
  });
});
