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

const NOW = 1_701_400_000_000;

describe("Integration: workspace journal (--workspace-journal, Issue #630)", () => {
  let homeDir: string;
  let wsA: string;
  let wsB: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-630i-home-"));
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-630i-wsa-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-630i-wsb-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(workspace: string | undefined): string {
    const id = store.newId();
    store.writeMeta(
      id,
      workspace === undefined
        ? { model: "fake-model", createdAt: NOW }
        : { model: "fake-model", workspace, createdAt: NOW },
    );
    store.append(id, { role: "user", content: "journal fodder" });
    return id;
  }

  it("merges workspace sessions with text/JSON agreement, excluding other workspaces", async () => {
    const a = seed(wsA);
    expect(appendSessionNote(store, a, "alpha crumb", NOW).ok).toBe(true);
    const b = seed(wsA);
    expect(appendSessionNote(store, b, "beta crumb", NOW + 1000).ok).toBe(true);
    const elsewhere = seed(wsB);
    expect(appendSessionNote(store, elsewhere, "elsewhere crumb", NOW).ok).toBe(true);

    const text = await runCli(["--workspace-journal", "--workspace", wsA], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain(`Workspace journal — ${wsA}`);
    expect(text.stdout).toContain("Sessions merged: 2");
    expect(text.stdout).toContain("alpha crumb");
    expect(text.stdout).toContain("beta crumb");
    expect(text.stdout).not.toContain("elsewhere crumb");

    const json = await runCli(
      ["--workspace-journal", "--workspace", wsA, "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.workspace-journal");
    expect(record.workspace).toBe(wsA);
    expect(record.sessionsScanned).toBe(2);
    expect(record.sessionsSkippedArchived).toBe(0);
    expect(record.elided).toBe(0);
    expect(JSON.stringify(record)).not.toContain("elsewhere crumb");
    // Counts agree between the two modes.
    expect(text.stdout).toContain(`${record.entries.length} event(s) shown.`);
    // Entries are chronological.
    const at = record.entries.map((e: { at: number }) => e.at);
    expect(at).toEqual([...at].sort((x: number, y: number) => x - y));
  });

  it("skips archived sessions and tags corrupt sessions", async () => {
    const archived = seed(wsA);
    store.writeArchived(archived, NOW);
    expect(appendSessionNote(store, archived, "retired crumb", NOW).ok).toBe(true);

    const corruptId = "corrupt-630i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ meta: true, model: "fake-model", workspace: wsA, createdAt: NOW })}\n` +
        `{broken mid-file}\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "corrupt crumb", NOW).ok).toBe(true);

    const json = await runCli(
      ["--workspace-journal", "--workspace", wsA, "--output", "json"],
      baseEnv,
    );
    expect(json.code, `stderr: ${json.stderr}`).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.sessionsScanned).toBe(1);
    expect(record.sessionsSkippedArchived).toBe(1);
    expect(JSON.stringify(record)).not.toContain("retired crumb");
    const corruptEntries = record.entries.filter((e: { sessionId: string }) => e.sessionId === corruptId);
    expect(corruptEntries.length).toBeGreaterThan(0);
    expect(corruptEntries.every((e: { integrity?: string }) => e.integrity === "corrupt")).toBe(true);

    const text = await runCli(["--workspace-journal", "--workspace", wsA], baseEnv);
    expect(text.stdout).toContain("(skipped 1 archived)");
    expect(text.stdout).toContain("(corrupt)");
  });

  it("renders the honest empty state and fails closed on a bad format", async () => {
    const empty = await runCli(["--workspace-journal", "--workspace", wsB], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("Sessions merged: 0");
    expect(empty.stdout).toContain("No journal entries for this workspace.");

    const badFormat = await runCli(
      ["--workspace-journal", "--workspace", wsA, "--output", "yaml"],
      baseEnv,
    );
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("keeps the store byte-identical through journal reads", async () => {
    const id = seed(wsA);
    expect(appendSessionNote(store, id, "byte crumb", NOW).ok).toBe(true);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const a = await runCli(["--workspace-journal", "--workspace", wsA], baseEnv);
    const b = await runCli(["--workspace-journal", "--workspace", wsA, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
