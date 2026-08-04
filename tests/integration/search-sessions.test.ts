import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: headless session search (--search-sessions, Issue #594)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snap.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    return snap;
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-594i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(content: string[]): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: 1 });
    for (const c of content) store.append(id, { role: "user", content: c });
    return id;
  }

  it("finds matches across sessions with role, index, name, and skip counts", async () => {
    const hitSession = seed(["talk about the storage migration", "unrelated"]);
    store.writeName(hitSession, "migration work");
    const assistantSession = store.newId();
    store.writeMeta(assistantSession, { model: "fake-model", workspace: "/tmp", createdAt: 1 });
    store.append(assistantSession, { role: "assistant", content: "MIGRATION plan attached" });
    seed(["nothing to see here"]);
    const corruptId = "corrupt-594";
    // Damage mid-file (a trailing torn line would be "partial" and is
    // legitimately scanned).
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "migration in corrupt" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );

    const r = await runCli(["--search-sessions", "migration"], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Session search");
    expect(r.stdout).toContain("Scanned 3 session(s), skipped 1 corrupt.");
    expect(r.stdout).toContain("(migration work) message #0 (user)");
    expect(r.stdout).toContain("storage migration");
    expect(r.stdout).toContain("message #0 (assistant)");
    expect(r.stdout).toContain("MIGRATION plan attached");
    expect(r.stdout).toContain("2 match(es).");
    // The no-match session's id never appears as a match line.
    expect(r.stdout).not.toContain("nothing to see here");
  });

  it("emits a versioned JSON record agreeing with the text counts", async () => {
    const id = seed(["the fallback model question", "second fallback mention"]);
    const r = await runCli(["--search-sessions", "fallback", "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-search");
    expect(record.v).toBe(1);
    expect(record.query).toBe("fallback");
    expect(record.sessionsScanned).toBe(1);
    expect(record.sessionsSkippedCorrupt).toBe(0);
    expect(record.matches).toHaveLength(2);
    expect(record.matches[0].sessionId).toBe(id);
    expect(record.matches[0].messageIndex).toBe(0);
    expect(record.matches[0].role).toBe("user");
    expect(record.matches[0].snippet).toContain("fallback model question");
    expect(record.elidedPerSession).toBe(0);
    expect(record.elidedTotal).toBe(0);
  });

  it("leaves the store byte-identical after a scan", async () => {
    const id = seed(["searchable content here"]);
    store.writeName(id, "scan target");
    fs.writeFileSync(
      path.join(sessionsDir(), "corrupt-594.jsonl"),
      `${JSON.stringify({ role: "user", content: "searchable too" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const before = dirSnapshot();
    const a = await runCli(["--search-sessions", "searchable"], baseEnv);
    const b = await runCli(["--search-sessions", "searchable", "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const after = dirSnapshot();
    expect(after).toEqual(before);
  });

  it("reports an honest empty result with exit 0", async () => {
    seed(["something else"]);
    const r = await runCli(["--search-sessions", "zzz-not-present"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No matches found.");
    const json = await runCli(["--search-sessions", "zzz-not-present", "--output", "json"], baseEnv);
    expect(JSON.parse(json.stdout.trim()).matches).toEqual([]);
  });

  it("fails closed on a blank query and a bad format without scanning", async () => {
    seed(["content"]);
    const blank = await runCli(["--search-sessions", "   "], baseEnv);
    expect(blank.code).toBe(2);
    expect(blank.stderr).toContain("non-empty search text");
    const badFormat = await runCli(["--search-sessions", "x", "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("never echoes a secret-shaped query unredacted", async () => {
    seed(["content"]);
    const secret = ["ghp", "_", "q".repeat(24)].join("");
    const r = await runCli(["--search-sessions", secret, "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(secret);
    expect(r.stdout).toContain("[REDACTED]");
  });
});
