import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
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

describe("Integration: session archiving (--archive-session / --unarchive-session, Issue #598)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_100_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function listedIds(stdout: string): string[] {
    return (JSON.parse(stdout.trim()) as { sessions: Array<{ id: string }> }).sessions.map(
      (s) => s.id,
    );
  }

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-598i-home-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(content: string, opts: { goal?: boolean } = {}): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: tmpDir, createdAt: NOW });
    store.append(id, { role: "user", content });
    if (opts.goal) {
      runGoalCommand(store, id, "the archived mission", NOW + 1);
    }
    return id;
  }

  it("archives by id: hidden from list and search with truthful counts, flagged via --include-archived", async () => {
    const active = seed("active needle");
    const retired = seed("retired needle", { goal: true });

    const archive = await runCli(["--archive-session", retired], baseEnv);
    expect(archive.code, `stderr: ${archive.stderr}`).toBe(0);
    expect(archive.stdout).toContain("Archived session");
    expect(archive.stdout).toContain("--resume");

    // Default listing hides the archived session and reports the count.
    const list = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(list.code).toBe(0);
    const record = JSON.parse(list.stdout.trim());
    expect(listedIds(list.stdout)).toEqual([active]);
    expect(record.archivedHidden).toBe(1);
    const listText = await runCli(["--list-sessions"], baseEnv);
    expect(listText.stdout).toContain("1 archived session(s) hidden — use --include-archived");

    // --include-archived flags the entry and drops the hidden count.
    const included = await runCli(["--list-sessions", "--include-archived", "--output", "json"], baseEnv);
    const includedRecord = JSON.parse(included.stdout.trim());
    expect(listedIds(included.stdout).sort()).toEqual([active, retired].sort());
    expect("archivedHidden" in includedRecord).toBe(false);
    const retiredEntry = includedRecord.sessions.find((s: { id: string }) => s.id === retired);
    expect(retiredEntry.archived).toBe(true);

    // Search never surfaces the archived session.
    const search = await runCli(["--search-sessions", "needle", "--output", "json"], baseEnv);
    const searchRecord = JSON.parse(search.stdout.trim());
    expect(searchRecord.sessionsScanned).toBe(1);
    expect(searchRecord.matches).toHaveLength(1);
    expect(searchRecord.matches[0].sessionId).toBe(active);
  });

  it("unarchiving restores discovery; transcript, meta, and goal stay byte-identical throughout", async () => {
    const id = seed("stable content", { goal: true });
    store.writeName(id, "stable work");
    const transcriptBefore = fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    expect((await runCli(["--archive-session", id], baseEnv)).code).toBe(0);
    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);

    const unarchive = await runCli(["--unarchive-session", id], baseEnv);
    expect(unarchive.code).toBe(0);
    expect(unarchive.stdout).toContain("Unarchived session");
    expect(fs.existsSync(store.archivedPath(id))).toBe(false);
    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);

    // Visible again (by name — the name sidecar survived too).
    const list = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(listedIds(list.stdout)).toEqual([id]);
  });

  it("archives by user-owned name and is idempotent on re-archive", async () => {
    const id = seed("named work content");
    store.writeName(id, "named work");
    const byName = await runCli(["--archive-session", "named work"], baseEnv);
    expect(byName.code, `stderr: ${byName.stderr}`).toBe(0);
    expect(store.readArchived(id)).not.toBeNull();

    const again = await runCli(["--archive-session", id], baseEnv);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already archived");
  });

  it("keeps --resume working for an archived session (resume is unaffected)", async () => {
    const id = seed("resume me after archiving");
    expect((await runCli(["--archive-session", id], baseEnv)).code).toBe(0);

    server.setResponses([{ type: "text", content: "resumed archived session" }]);
    const resumed = await runCli(
      ["-p", "continue", "--resume", id, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(resumed.code, `stderr: ${resumed.stderr}`).toBe(0);
    expect(resumed.stdout).toContain("resumed archived session");
  });

  it("archives a corrupt session (marker is integrity-agnostic)", async () => {
    const id = "corrupt-598";
    fs.writeFileSync(
      path.join(sessionsDir(), `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const r = await runCli(["--archive-session", id], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(fs.existsSync(store.archivedPath(id))).toBe(true);
  });

  it("fails closed on unknown targets and rejects combining both flags", async () => {
    const unknown = await runCli(["--archive-session", "no-such-session"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot archive");

    const id = seed("some content");
    const both = await runCli(
      ["--archive-session", id, "--unarchive-session", id],
      baseEnv,
    );
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("cannot be combined");
    expect(store.readArchived(id)).toBeNull();
  });
});
