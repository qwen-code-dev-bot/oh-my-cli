import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: session pinning (--pin-session / --unpin-session, Issue #610)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_600_000_000;

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
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-610i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(name?: string): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: NOW });
    store.append(id, { role: "user", content: "pin fodder" });
    if (name !== undefined) store.writeName(id, name);
    return id;
  }

  // Deterministic recency: explicit mtimes instead of relying on write order.
  function setAge(id: string, ageSeconds: number): void {
    const t = new Date(Date.now() / 1000 - ageSeconds);
    fs.utimesSync(path.join(sessionsDir(), `${id}.jsonl`), t, t);
  }

  async function listedIds(extraArgs: string[] = []): Promise<string[]> {
    const r = await runCli(["--list-sessions", "--output", "json", ...extraArgs], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    return (JSON.parse(r.stdout.trim()) as { sessions: Array<{ id: string }> }).sessions.map(
      (s) => s.id,
    );
  }

  it("pinning elevates an old session above newer ones; unpinning restores recency", async () => {
    const older = seed("older work");
    const newer = seed();
    setAge(older, 3600); // one hour old
    setAge(newer, 10); // ten seconds old

    expect(await listedIds()).toEqual([newer, older]);

    const pin = await runCli(["--pin-session", older], baseEnv);
    expect(pin.code, `stderr: ${pin.stderr}`).toBe(0);
    expect(pin.stdout).toContain("Pinned session");
    expect(pin.stdout).toContain("lists first");

    expect(await listedIds()).toEqual([older, newer]);

    const unpin = await runCli(["--unpin-session", older], baseEnv);
    expect(unpin.code).toBe(0);
    expect(unpin.stdout).toContain("recency order restored");
    expect(await listedIds()).toEqual([newer, older]);
  });

  it("reports pinned flags and counts in text + JSON agreement", async () => {
    const older = seed("pinned by name");
    const newer = seed();
    setAge(older, 3600);
    setAge(newer, 10);

    // Pin by user-owned name.
    const pin = await runCli(["--pin-session", "pinned by name"], baseEnv);
    expect(pin.code, `stderr: ${pin.stderr}`).toBe(0);

    const text = await runCli(["--list-sessions"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("(pinned)");
    // The pinned entry renders first.
    expect(text.stdout.indexOf("(pinned)")).toBeLessThan(text.stdout.indexOf(newer.slice(0, 8)));

    const json = await runCli(["--list-sessions", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.pinned).toBe(1);
    const entry = record.sessions.find((s: { id: string }) => s.id === older);
    expect(entry.pinned).toBe(true);
    expect(typeof entry.pinnedAt).toBe("number");
    expect(record.sessions[0].id).toBe(older);
  });

  it("is idempotent on re-pin and honest on no-op unpin", async () => {
    const id = seed();
    expect((await runCli(["--pin-session", id], baseEnv)).code).toBe(0);
    const again = await runCli(["--pin-session", id], baseEnv);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already pinned");

    const notPinned = seed();
    const noop = await runCli(["--unpin-session", notPinned], baseEnv);
    expect(noop.code).toBe(0);
    expect(noop.stdout).toContain("is not pinned");
  });

  it("keeps other sidecars byte-identical and pins corrupt sessions", async () => {
    const id = seed();
    const before = dirSnapshot();
    expect((await runCli(["--pin-session", id], baseEnv)).code).toBe(0);
    const afterPin = dirSnapshot();
    // Only the new pin marker differs.
    const changed = [...afterPin.keys()].filter(
      (f) => !before.has(f) || before.get(f) !== afterPin.get(f),
    );
    expect(changed).toEqual([`${id}.pinned.json`]);

    const corruptId = "corrupt-610i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const pinCorrupt = await runCli(["--pin-session", corruptId], baseEnv);
    expect(pinCorrupt.code, `stderr: ${pinCorrupt.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir(), `${corruptId}.pinned.json`))).toBe(true);
    expect(fs.readdirSync(sessionsDir()).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("counts pinned sessions in the overview census", async () => {
    const a = seed();
    const b = seed();
    expect((await runCli(["--pin-session", a], baseEnv)).code).toBe(0);
    expect((await runCli(["--pin-session", b], baseEnv)).code).toBe(0);
    const json = await runCli(["--sessions-overview", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.metadata.pinned).toBe(2);
    const text = await runCli(["--sessions-overview"], baseEnv);
    expect(text.stdout).toContain("2 pinned");
  });

  it("archive visibility prevails over pinning", async () => {
    const archivedPinned = seed();
    expect((await runCli(["--archive-session", archivedPinned], baseEnv)).code).toBe(0);
    expect((await runCli(["--pin-session", archivedPinned], baseEnv)).code).toBe(0);

    // Hidden without --include-archived even though pinned.
    expect(await listedIds()).toEqual([]);
    const hiddenText = await runCli(["--list-sessions"], baseEnv);
    expect(hiddenText.stdout).toContain("1 archived session(s) hidden");

    // Shown (flagged) with --include-archived.
    expect(await listedIds(["--include-archived"])).toEqual([archivedPinned]);
    const shown = await runCli(["--list-sessions", "--include-archived"], baseEnv);
    expect(shown.stdout).toContain("(archived)");
    expect(shown.stdout).toContain("(pinned)");
  });

  it("fails closed on unknown targets and combined flags", async () => {
    const unknown = await runCli(["--pin-session", "no-such"], baseEnv);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Cannot pin");

    const id = seed();
    const both = await runCli(["--pin-session", id, "--unpin-session", id], baseEnv);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("cannot be combined");
    expect(fs.existsSync(path.join(sessionsDir(), `${id}.pinned.json`))).toBe(false);
  });
});
