import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
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

describe("Integration: notes presence in --list-sessions (Issue #624)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_700_800_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-624i-home-"));
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
    store.append(id, { role: "user", content: "listing fodder" });
    return id;
  }

  it("flags note counts in text and JSON, and omits them without notes", async () => {
    const withNotes = seed();
    expect(appendSessionNote(store, withNotes, "breadcrumb one", NOW).ok).toBe(true);
    expect(appendSessionNote(store, withNotes, "breadcrumb two", NOW + 1).ok).toBe(true);
    const bare = seed();

    const text = await runCli(["--list-sessions"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("(2 notes)");
    // The bare session's block carries no notes flag: exactly one flag total.
    expect(text.stdout.match(/\(\d+ notes?\)/g)).toHaveLength(1);

    const json = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    const noted = record.sessions.find((s: { id: string }) => s.id === withNotes);
    const bareEntry = record.sessions.find((s: { id: string }) => s.id === bare);
    expect(noted.noteCount).toBe(2);
    expect(bareEntry.noteCount).toBeUndefined();
  });

  it("renders honest absence for an unreadable sidecar and shows presence on corrupt sessions", async () => {
    const unreadable = seed();
    fs.writeFileSync(path.join(sessionsDir(), `${unreadable}.notes.json`), "{not json\n");

    const corruptId = "corrupt-624i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "fake-model", createdAt: NOW })}\n{broken mid-file\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "note on corrupt", NOW).ok).toBe(true);

    const json = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    expect(json.code, `stderr: ${json.stderr}`).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    const unreadableEntry = record.sessions.find((s: { id: string }) => s.id === unreadable);
    expect(unreadableEntry.noteCount).toBeUndefined();
    const corruptEntry = record.sessions.find((s: { id: string }) => s.id === corruptId);
    expect(corruptEntry.noteCount).toBe(1);
    expect(corruptEntry.corrupt).toBe(true);

    const text = await runCli(["--list-sessions"], baseEnv);
    expect(text.stdout).toContain("(1 note)");
  });

  it("keeps ordering, archive/pin flags, and store bytes unchanged", async () => {
    const older = seed();
    const newer = seed();
    expect(appendSessionNote(store, older, "old note", NOW).ok).toBe(true);
    store.writePinned(older, NOW);
    store.writeArchived(newer, NOW);

    const text = await runCli(["--list-sessions", "--include-archived"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    // Pinned first, with both flags on the older row.
    const lines = text.stdout.split("\n");
    const olderLine = lines.find((l) => l.includes(older))!;
    expect(olderLine).toContain("(pinned)");
    expect(olderLine).toContain("(1 note)");
    expect(text.stdout).toContain("(archived)");

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    await runCli(["--list-sessions"], baseEnv);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
