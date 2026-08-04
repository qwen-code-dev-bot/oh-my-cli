import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";
import { appendSessionNote, SESSION_NOTES_MAX } from "../../src/session-notes.js";

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

describe("Integration: session notes (--annotate-session / --session-notes, Issue #602)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_300_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function notesFile(id: string): string {
    return path.join(sessionsDir(), `${id}.notes.json`);
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-602i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(opts: { goal?: boolean; name?: string } = {}): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: NOW });
    store.append(id, { role: "user", content: "annotatable work" });
    if (opts.goal) runGoalCommand(store, id, "the annotated mission", NOW + 1);
    if (opts.name !== undefined) store.writeName(id, opts.name);
    return id;
  }

  it("annotates and views notes with text/JSON agreement", async () => {
    const id = seed();
    const add = await runCli(
      ["--annotate-session", id, "--note", "first breadcrumb"],
      baseEnv,
    );
    expect(add.code, `stderr: ${add.stderr}`).toBe(0);
    expect(add.stdout).toContain("Added a note");
    expect(add.stdout).toContain("1 recorded");

    const add2 = await runCli(
      ["--annotate-session", id, "--note", "second breadcrumb"],
      baseEnv,
    );
    expect(add2.code).toBe(0);
    expect(add2.stdout).toContain("2 recorded");

    const text = await runCli(["--session-notes", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("second breadcrumb");
    expect(text.stdout).toContain("first breadcrumb");
    expect(text.stdout.indexOf("second breadcrumb")).toBeLessThan(
      text.stdout.indexOf("first breadcrumb"),
    );
    expect(text.stdout).toContain("2 note(s).");

    const json = await runCli(["--session-notes", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-notes");
    expect(record.sessionId).toBe(id);
    expect(record.notes.map((n: { text: string }) => n.text)).toEqual([
      "second breadcrumb",
      "first breadcrumb",
    ]);
    expect(record.dropped).toBe(0);
    expect(record.sidecarCorrupt).toBe(false);
  });

  it("keeps transcript, goal, and name byte-identical through annotate + view", async () => {
    const id = seed({ goal: true, name: "annotated work" });
    const transcriptBefore = fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");
    const nameBefore = fs.readFileSync(store.namePath(id), "utf-8");

    expect((await runCli(["--annotate-session", id, "--note", "a note"], baseEnv)).code).toBe(0);
    expect((await runCli(["--session-notes", id], baseEnv)).code).toBe(0);

    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);
    expect(fs.readFileSync(store.namePath(id), "utf-8")).toBe(nameBefore);
  });

  it("annotates by user-owned name and annotates corrupt sessions", async () => {
    const id = seed({ name: "named target" });
    const byName = await runCli(
      ["--annotate-session", "named target", "--note", "via name"],
      baseEnv,
    );
    expect(byName.code, `stderr: ${byName.stderr}`).toBe(0);
    expect(fs.existsSync(notesFile(id))).toBe(true);

    const corruptId = "corrupt-602i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const before = fs.readFileSync(path.join(sessionsDir(), `${corruptId}.jsonl`), "utf-8");
    const onCorrupt = await runCli(
      ["--annotate-session", corruptId, "--note", "note on corrupt"],
      baseEnv,
    );
    expect(onCorrupt.code, `stderr: ${onCorrupt.stderr}`).toBe(0);
    // The corrupt checkpoint is untouched and never quarantined.
    expect(fs.readFileSync(path.join(sessionsDir(), `${corruptId}.jsonl`), "utf-8")).toBe(before);
    expect(fs.readdirSync(sessionsDir()).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("never persists or prints secret-shaped note text unredacted", async () => {
    const id = seed();
    const secret = ["ghp", "_", "q".repeat(24)].join("");
    const add = await runCli(["--annotate-session", id, "--note", `token ${secret}`], baseEnv);
    expect(add.code).toBe(0);
    expect(add.stdout).not.toContain(secret);

    const raw = fs.readFileSync(notesFile(id), "utf-8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");

    const view = await runCli(["--session-notes", id, "--output", "json"], baseEnv);
    expect(view.stdout).not.toContain(secret);
    expect(view.stdout).toContain("[REDACTED]");
  });

  it("bounds the ledger to the newest 20 with a truthful dropped count", async () => {
    const id = seed();
    // Seed the first 20 directly, then trip the bound through the CLI.
    for (let i = 0; i < SESSION_NOTES_MAX; i++) {
      expect(appendSessionNote(store, id, `seeded ${i}`, NOW + i).ok).toBe(true);
    }
    const overflow = await runCli(
      ["--annotate-session", id, "--note", "the overflow note"],
      baseEnv,
    );
    expect(overflow.code).toBe(0);
    expect(overflow.stdout).toContain(`${SESSION_NOTES_MAX} recorded`);
    expect(overflow.stdout).toContain("oldest note dropped");

    const json = await runCli(["--session-notes", id, "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.notes).toHaveLength(SESSION_NOTES_MAX);
    expect(record.dropped).toBe(1);
    expect(record.notes[0].text).toBe("the overflow note");
    expect(record.notes.some((n: { text: string }) => n.text === "seeded 0")).toBe(false);
  });

  it("fails closed on blank notes, orphan --note, unknown targets, and bad formats", async () => {
    const id = seed();
    const blank = await runCli(["--annotate-session", id, "--note", "   "], baseEnv);
    expect(blank.code).toBe(2);
    expect(blank.stderr).toContain("non-empty");
    expect(fs.existsSync(notesFile(id))).toBe(false);

    const missingFlag = await runCli(["--annotate-session", id], baseEnv);
    expect(missingFlag.code).toBe(2);
    expect(missingFlag.stderr).toContain("requires --note");

    const orphan = await runCli(["--list-sessions", "--note", "stray"], baseEnv);
    expect(orphan.code).toBe(2);
    expect(orphan.stderr).toContain("--note requires --annotate-session");

    const unknown = await runCli(["--annotate-session", "no-such", "--note", "x"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot annotate");

    const badFormat = await runCli(["--session-notes", id, "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("renders the honest empty state with exit 0", async () => {
    const id = seed();
    const text = await runCli(["--session-notes", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("No notes recorded for this session.");
    const json = await runCli(["--session-notes", id, "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.notes).toEqual([]);
    expect(record.sidecarCorrupt).toBe(false);
  });
});
