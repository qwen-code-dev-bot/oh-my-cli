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

describe("Integration: workspace-scoped notes search (--search-notes --workspace-scoped, Issue #628)", () => {
  let homeDir: string;
  let wsA: string;
  let wsB: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_701_100_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628i-home-"));
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628i-wsa-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628i-wsb-"));
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

  function seed(workspace: string | undefined, note: string): string {
    const id = store.newId();
    store.writeMeta(
      id,
      workspace === undefined
        ? { model: "fake-model", createdAt: NOW }
        : { model: "fake-model", workspace, createdAt: NOW },
    );
    store.append(id, { role: "user", content: "scope fodder" });
    expect(appendSessionNote(store, id, note, NOW).ok).toBe(true);
    return id;
  }

  it("scopes the scan to the workspace with text/JSON agreement", async () => {
    const inA = seed(wsA, "scoped breadcrumb");
    seed(wsB, "scoped breadcrumb elsewhere");

    const text = await runCli(
      ["--search-notes", "scoped breadcrumb", "--workspace-scoped", "--workspace", wsA],
      baseEnv,
    );
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain(`Scoped to workspace: ${wsA}`);
    expect(text.stdout).toContain("Scanned 1 note ledger(s).");
    expect(text.stdout).toContain("1 match(es).");
    expect(text.stdout).not.toContain("elsewhere");

    const json = await runCli(
      ["--search-notes", "scoped breadcrumb", "--workspace-scoped", "--workspace", wsA, "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.scopedWorkspace).toBe(wsA);
    expect(record.ledgersScanned).toBe(1);
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(inA);
    expect(record.matches[0].snippet).toBe("scoped breadcrumb");

    // Unscoped scan still sees both (unchanged behavior).
    const unscoped = await runCli(["--search-notes", "scoped breadcrumb", "--output", "json"], baseEnv);
    const unscopedRecord = JSON.parse(unscoped.stdout.trim());
    expect(unscopedRecord.scopedWorkspace).toBeUndefined();
    expect(unscopedRecord.matches).toHaveLength(2);
  });

  it("keeps archived sessions skipped even when scoped", async () => {
    const archived = seed(wsA, "retired scoped note");
    store.writeArchived(archived, NOW);
    seed(wsA, "live scoped note");

    const json = await runCli(
      ["--search-notes", "scoped note", "--workspace-scoped", "--workspace", wsA, "--output", "json"],
      baseEnv,
    );
    expect(json.code, `stderr: ${json.stderr}`).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.ledgersScanned).toBe(1);
    expect(record.matches.map((m: { snippet: string }) => m.snippet)).toEqual(["live scoped note"]);
  });

  it("scans zero ledgers honestly for a workspace with no sessions", async () => {
    seed(wsA, "any note");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omc-628i-empty-ws-"));
    try {
      const r = await runCli(
        ["--search-notes", "any note", "--workspace-scoped", "--workspace", empty, "--output", "json"],
        baseEnv,
      );
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);
      const record = JSON.parse(r.stdout.trim());
      expect(record.scopedWorkspace).toBe(empty);
      expect(record.ledgersScanned).toBe(0);
      expect(record.matches).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("keeps the store byte-identical through scoped and unscoped scans", async () => {
    seed(wsA, "byte note");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const a = await runCli(
      ["--search-notes", "byte", "--workspace-scoped", "--workspace", wsA],
      baseEnv,
    );
    const b = await runCli(["--search-notes", "byte"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
