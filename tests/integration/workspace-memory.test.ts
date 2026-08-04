import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.on("error", reject);
  });
}

describe("Integration: workspace memory (--memory-*, Issue #570)", () => {
  let wsA: string;
  let wsB: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570i-wsA-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570i-wsB-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-570i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    for (const d of [wsA, wsB, homeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  function memoryDir(): string {
    return path.join(homeDir, ".oh-my-cli", "memory");
  }

  function storeFiles(): string[] {
    if (!fs.existsSync(memoryDir())) return [];
    return fs.readdirSync(memoryDir()).filter((f) => f.endsWith(".json"));
  }

  function rawStore(): string {
    const files = storeFiles();
    expect(files.length).toBe(1);
    return fs.readFileSync(path.join(memoryDir(), files[0]), "utf8");
  }

  it("records, lists, and forgets a memory end to end", async () => {
    const add = await runCli(
      ["--memory-add", "always run the smoke suite before merging", "--workspace", wsA],
      baseEnv,
    );
    expect(add.code).toBe(0);
    const id = add.stdout.trim().replace("Recorded memory ", "");
    expect(id).toMatch(/^[0-9a-f]{8}$/);

    const list = await runCli(["--memory-list", "--workspace", wsA], baseEnv);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("always run the smoke suite before merging");
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("recorded");

    const forget = await runCli(["--memory-forget", id, "--workspace", wsA], baseEnv);
    expect(forget.code).toBe(0);

    const after = await runCli(["--memory-list", "--workspace", wsA], baseEnv);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("No workspace memories recorded.");
    expect(after.stdout).toContain("1 forgotten entry hidden from this list.");
    // The tombstone stays auditable in the store file.
    expect(rawStore()).toContain('"status":"forgotten"');
  });

  it("redacts secrets before persistence and reports the id", async () => {
    const secret = ["ghp", "_", "b".repeat(24)].join("");
    const add = await runCli(
      ["--memory-add", `deploy token is ${secret}`, "--workspace", wsA],
      baseEnv,
    );
    expect(add.code).toBe(0);
    const raw = rawStore();
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
  });

  it("isolates memories between workspaces", async () => {
    const add = await runCli(["--memory-add", "only for workspace A", "--workspace", wsA], baseEnv);
    expect(add.code).toBe(0);
    const listB = await runCli(["--memory-list", "--workspace", wsB], baseEnv);
    expect(listB.code).toBe(0);
    expect(listB.stdout).toContain("No workspace memories recorded.");
    expect(listB.stdout).not.toContain("only for workspace A");
  });

  it("emits a versioned JSON record for automation", async () => {
    await runCli(["--memory-add", "json memory", "--workspace", wsA], baseEnv);
    const r = await runCli(["--memory-list", "--workspace", wsA, "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.memory");
    expect(parsed.v).toBe(1);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].text).toBe("json memory");
  });

  it("refuses everything when memory is disabled", async () => {
    const disabledEnv = { ...baseEnv, OMC_MEMORY_DISABLED: "1" };
    const add = await runCli(["--memory-add", "nope", "--workspace", wsA], disabledEnv);
    expect(add.code).toBe(2);
    expect(add.stderr).toContain("disabled");
    const list = await runCli(["--memory-list", "--workspace", wsA], disabledEnv);
    expect(list.code).toBe(2);
    // Nothing was read or written.
    expect(storeFiles()).toEqual([]);
  });

  it("fails closed on empty text and unknown ids", async () => {
    const empty = await runCli(["--memory-add", "   ", "--workspace", wsA], baseEnv);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("must not be empty");

    const unknown = await runCli(["--memory-forget", "zzzzzzzz", "--workspace", wsA], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("no memory with id");
  });

  it("warns on a corrupt store without crashing and refuses writes", async () => {
    await runCli(["--memory-add", "before corruption", "--workspace", wsA], baseEnv);
    const file = path.join(memoryDir(), storeFiles()[0]);
    fs.writeFileSync(file, "{ not json");

    const list = await runCli(["--memory-list", "--workspace", wsA], baseEnv);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("unreadable");

    const add = await runCli(["--memory-add", "after corruption", "--workspace", wsA], baseEnv);
    expect(add.code).toBe(2);
    expect(add.stderr).toContain("unreadable");
    // The corrupt bytes are preserved.
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("rejects an invalid --output format for --memory-list", async () => {
    const r = await runCli(["--memory-list", "--workspace", wsA, "--output", "yaml"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
