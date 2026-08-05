import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";
import { appendSessionNote } from "../../src/session-notes.js";

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

describe("Integration: session journal (--session-journal, Issue #618)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_700_100_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-618i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: NOW });
    store.append(id, { role: "user", content: "journal fodder" });
    return id;
  }

  it("renders a chronological journal in text and JSON agreement", async () => {
    const id = seed();
    runGoalCommand(store, id, "journal mission", NOW + 100);
    runGoalCommand(store, id, "pause", NOW + 300);
    expect(appendSessionNote(store, id, "journal breadcrumb", NOW + 200).ok).toBe(true);
    store.writePinned(id, NOW + 400);
    store.writeArchived(id, NOW + 500);

    const text = await runCli(["--session-journal", id], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Session journal —");
    expect(text.stdout).toContain("session created");
    expect(text.stdout).toContain("journal mission");
    expect(text.stdout).toContain("journal breadcrumb");
    expect(text.stdout).toContain("pinned to the top of discovery");
    expect(text.stdout).toContain("retired from discovery");

    const json = await runCli(["--session-journal", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal");
    expect(record.sessionId).toBe(id);
    expect(record.integrity).toBe("ok");
    // Oldest first.
    const ats = record.entries.map((e: { at: number }) => e.at);
    expect(ats).toEqual([...ats].sort((a: number, b: number) => a - b));
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("goal");
    expect(kinds).toContain("note");
    expect(kinds).toContain("pinned");
    expect(kinds).toContain("archived");
    expect(kinds).toContain("last-activity");
    // Counts agree between the two modes.
    expect(text.stdout).toContain(`${record.entries.length} event(s).`);
  });

  it("never leaks secrets and journals corrupt sessions honestly", async () => {
    const secret = ["ghp", "_", "i".repeat(24)].join("");
    const id = seed();
    runGoalCommand(store, id, `mission with ${secret}`, NOW + 100);
    expect(appendSessionNote(store, id, `note with ${secret}`, NOW + 200).ok).toBe(true);

    const text = await runCli(["--session-journal", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain(secret);
    expect(text.stdout).toContain("[REDACTED]");
    const json = await runCli(["--session-journal", id, "--output", "json"], baseEnv);
    expect(json.stdout).not.toContain(secret);

    // Corrupt transcript: still journalable, with the corrupt verdict.
    const corruptId = "corrupt-618i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "fake-model", createdAt: NOW })}\n{broken mid-file\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    store.writePinned(corruptId, NOW + 5);
    const corruptText = await runCli(["--session-journal", corruptId], baseEnv);
    expect(corruptText.code, `stderr: ${corruptText.stderr}`).toBe(0);
    expect(corruptText.stdout).toContain("(corrupt)");
    expect(corruptText.stdout).toContain("pinned to the top of discovery");
  });

  it("renders the honest minimal journal for a bare session and fails closed on bad input", async () => {
    const id = seed();
    const bare = await runCli(["--session-journal", id], baseEnv);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("session created");
    expect(bare.stdout).toContain("2 event(s).");

    const unknown = await runCli(["--session-journal", "no-such"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot read journal");

    const badFormat = await runCli(["--session-journal", id, "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("keeps the store byte-identical through journal reads", async () => {
    const id = seed();
    runGoalCommand(store, id, "mission", NOW + 100);
    expect(appendSessionNote(store, id, "breadcrumb", NOW + 200).ok).toBe(true);
    store.writeArchived(id, NOW + 300);

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const a = await runCli(["--session-journal", id], baseEnv);
    const b = await runCli(["--session-journal", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
