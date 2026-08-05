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

describe("Integration: export carries the whole durable state (Issue #614)", () => {
  let home: string;
  let outRoot: string;
  let baseEnv: Record<string, string | undefined>;
  let store: SessionStore;
  const NOTE_AT = 1_700_000_700_000;
  const ARCHIVED_AT = 1_700_000_500_000;
  const PINNED_AT = 1_700_000_600_000;

  function sessionsDir(): string {
    return path.join(home, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-614i-home-"));
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-614i-out-"));
    // No provider credentials: the export path must not need a network or model.
    baseEnv = {
      HOME: home,
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: "",
    };
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: `${home}/work`, createdAt: 1_700_000_000_000 });
    store.append(id, { role: "user", content: "export fodder" });
    return id;
  }

  it("includes goal, notes, and markers for an equipped session in both outputs", async () => {
    const id = seed();
    store.writeGoal(id, {
      revision: 1,
      goal: {
        objective: "finish the rollout",
        status: "paused",
        createdAt: 1,
        updatedAt: 2,
        title: "Rollout",
      },
    });
    expect(appendSessionNote(store, id, "exported breadcrumb", NOTE_AT).ok).toBe(true);
    store.writeArchived(id, ARCHIVED_AT);
    store.writePinned(id, PINNED_AT);

    const out = path.join(outRoot, "equipped");
    const r = await runCli(["--export-session", id, "--out", out], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, `${id}.session-export.manifest.json`), "utf8"),
    );
    expect(manifest.goal).toEqual({
      status: "paused",
      objective: "finish the rollout",
      title: "Rollout",
      revision: 1,
      historyCount: 0,
    });
    expect(manifest.notes).toEqual([{ at: NOTE_AT, text: "exported breadcrumb" }]);
    expect(manifest.archivedAt).toBe(ARCHIVED_AT);
    expect(manifest.pinnedAt).toBe(PINNED_AT);

    const md = fs.readFileSync(path.join(out, `${id}.session-export.md`), "utf8");
    expect(md).toContain("### Goal");
    expect(md).toContain("Status: paused · Title: Rollout");
    expect(md).toContain("### Notes");
    expect(md).toContain("exported breadcrumb");
    expect(md).toContain("### Lifecycle markers");
    expect(md).toContain(`Archived: ${new Date(ARCHIVED_AT).toISOString()}`);
    expect(md).toContain(`Pinned: ${new Date(PINNED_AT).toISOString()}`);
  });

  it("exports honest absence for a bare session and never leaks secrets", async () => {
    const id = seed();
    const secret = ["ghp", "_", "e".repeat(24)].join("");
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: `ship with ${secret}`, status: "active", createdAt: 1, updatedAt: 2 },
    });
    expect(appendSessionNote(store, id, `note with ${secret}`, NOTE_AT).ok).toBe(true);

    const out = path.join(outRoot, "secrets");
    const r = await runCli(["--export-session", id, "--out", out], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);

    const mdPath = path.join(out, `${id}.session-export.md`);
    const manifestPath = path.join(out, `${id}.session-export.manifest.json`);
    const md = fs.readFileSync(mdPath, "utf8");
    const manifestText = fs.readFileSync(manifestPath, "utf8");
    expect(md).not.toContain(secret);
    expect(manifestText).not.toContain(secret);
    expect(md).toContain("[REDACTED]");
    expect(md).not.toContain("### Lifecycle markers");

    const manifest = JSON.parse(manifestText);
    expect(manifest.archivedAt).toBeNull();
    expect(manifest.pinnedAt).toBeNull();
    expect(manifest.goal.objective).toContain("[REDACTED]");
    expect(manifest.notes[0].text).toContain("[REDACTED]");
  });

  it("exports a corrupt session's durable state with the corrupt verdict", async () => {
    const id = "corrupt-614i";
    const metaLine = JSON.stringify({ meta: true, model: "fake-model", workspace: `${home}/work`, createdAt: 1 });
    fs.writeFileSync(
      path.join(sessionsDir(), `${id}.jsonl`),
      `${metaLine}\n{broken mid-file\n${JSON.stringify({ role: "user", content: "kept" })}\n`,
    );
    expect(appendSessionNote(store, id, "corrupt breadcrumb", NOTE_AT).ok).toBe(true);
    store.writePinned(id, PINNED_AT);

    const out = path.join(outRoot, "corrupt");
    const r = await runCli(["--export-session", id, "--out", out], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, `${id}.session-export.manifest.json`), "utf8"),
    );
    expect(manifest.integrity).toBe("corrupt");
    expect(manifest.notes).toEqual([{ at: NOTE_AT, text: "corrupt breadcrumb" }]);
    expect(manifest.pinnedAt).toBe(PINNED_AT);
  });

  it("keeps the whole store byte-identical through the export", async () => {
    const id = seed();
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    expect(appendSessionNote(store, id, "breadcrumb", NOTE_AT).ok).toBe(true);
    store.writeArchived(id, ARCHIVED_AT);

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const r = await runCli(["--export-session", id, "--out", path.join(outRoot, "readonly")], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
