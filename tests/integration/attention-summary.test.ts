import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// --attention (Issue #558): a read-only, workspace-scoped return-to-work
// summary. It must classify durable state (corrupt / partial / turn outcomes),
// never surface another workspace's sessions, never mutate anything, and stay
// deterministic across repeated reads.

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

describe("Integration: attention summary (--attention, Issue #558)", () => {
  let server: FakeServer;
  let wsA: string;
  let wsB: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-wsA-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-wsB-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-558-sess-"));
    fs.writeFileSync(path.join(wsA, "a.txt"), "workspace A\n");
    fs.writeFileSync(path.join(wsB, "b.txt"), "workspace B\n");
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function snapshotSessionsDir(): Record<string, string> {
    const out: Record<string, string> = {};
    const dir = sessionsHome();
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).sort()) {
      out[f] = fs.readFileSync(path.join(dir, f), "utf8");
    }
    return out;
  }

  // Seed one real completed session in wsA through the CLI, then drop three
  // hand-written sessions beside it: a cancelled transcript and a corrupt and
  // a partial checkpoint (all belonging to wsA), plus one foreign session in
  // wsB that must never appear.
  async function seedMixedState(): Promise<void> {
    server.setResponses([{ type: "text", content: "MAIN ANSWER" }]);
    const r = await runCli(
      ["-p", "inspect the build", "--approval-mode", "yolo", "--workspace", wsA],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const CANCELLED = "[cancelled: turn cancelled before this tool ran]";
    const meta = (workspace: string) =>
      JSON.stringify({ meta: true, model: "fake-model", workspace, createdAt: 1 });

    fs.mkdirSync(sessionsHome(), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsHome(), "cancelled-turn.jsonl"),
      [
        meta(wsA),
        JSON.stringify({ role: "user", content: "do the work" }),
        JSON.stringify({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "k1", type: "function", function: { name: "read", arguments: "{}" } },
            { id: "k2", type: "function", function: { name: "shell", arguments: "{}" } },
          ],
        }),
        JSON.stringify({ role: "tool", content: "real result", tool_call_id: "k1" }),
        JSON.stringify({ role: "tool", content: CANCELLED, tool_call_id: "k2" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsHome(), "corrupt-one.jsonl"),
      [
        meta(wsA),
        JSON.stringify({ role: "user", content: "hi" }),
        "{ this is not json }",
        JSON.stringify({ role: "assistant", content: "ok" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsHome(), "partial-one.jsonl"),
      [meta(wsA), JSON.stringify({ role: "user", content: "hi" })].join("\n") +
        "\n" +
        '{"role":"assistant","content":"incomple',
    );
    fs.writeFileSync(
      path.join(sessionsHome(), "foreign-one.jsonl"),
      [
        meta(wsB),
        JSON.stringify({ role: "user", content: "foreign" }),
        JSON.stringify({ role: "assistant", content: "answer" }),
      ].join("\n") + "\n",
    );
  }

  it("classifies workspace sessions, excludes foreign ones, and stays read-only", async () => {
    await seedMixedState();
    const before = snapshotSessionsDir();

    const r = await runCli(["--attention", "--workspace", wsA], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`workspace ${wsA}`);
    // All four wsA states are classified; the wsB session never appears.
    expect(r.stdout).toContain("corrupt-session");
    expect(r.stdout).toContain("partial-session");
    expect(r.stdout).toContain("turn-cancelled");
    expect(r.stdout).toContain("turn-completed");
    expect(r.stdout).not.toContain("foreign-one");
    expect(r.stdout).not.toContain(wsB);
    // Safe next actions, and the read-only disclaimer.
    expect(r.stdout).toContain("--salvage-session");
    expect(r.stdout).toContain("--resume");
    expect(r.stdout).toContain("Read-only");
    expect(r.stdout).toContain("4 item(s)");

    // The view healed, quarantined, or wrote nothing.
    expect(snapshotSessionsDir()).toEqual(before);
  });

  it("is deterministic: repeated reads agree except the clock-relative age", async () => {
    await seedMixedState();
    const a = await runCli(["--attention", "--workspace", wsA, "--output", "json"], baseEnv);
    const b = await runCli(["--attention", "--workspace", wsA, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // ageMs is relative to the read instant (like the --list-sessions record);
    // everything else is state-derived and must be identical across reads.
    const stripAges = (s: string) =>
      JSON.parse(s, (k, v) => (k === "ageMs" ? undefined : v));
    expect(stripAges(a.stdout.trim())).toEqual(stripAges(b.stdout.trim()));
  });

  it("emits a versioned JSON record with scoped counts", async () => {
    await seedMixedState();
    const r = await runCli(["--attention", "--workspace", wsA, "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.attention");
    expect(parsed.v).toBe(1);
    expect(parsed.workspace).toBe(wsA);
    expect(parsed.total).toBe(4);
    expect(parsed.shown).toBe(4);
    expect(parsed.omitted).toBe(0);
    const types = parsed.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual(["corrupt-session", "partial-session", "turn-cancelled", "turn-completed"]);
    // Corrupt is the most urgent item and sorts first.
    expect(parsed.items[0].type).toBe("corrupt-session");
    expect(JSON.stringify(parsed)).not.toContain(wsB);
  });

  it("scopes from the other workspace symmetrically", async () => {
    await seedMixedState();
    const r = await runCli(["--attention", "--workspace", wsB], baseEnv);
    expect(r.code).toBe(0);
    // Only the foreign session (completed) belongs to wsB.
    expect(r.stdout).toContain("1 item(s)");
    expect(r.stdout).toContain("turn-completed");
    expect(r.stdout).not.toContain("corrupt-session");
  });

  it("reports the explicit empty state for a workspace with no sessions", async () => {
    const r = await runCli(["--attention", "--workspace", wsA], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing needs attention in this workspace.");
  });

  it("rejects an invalid --output format (exit 2)", async () => {
    const r = await runCli(["--attention", "--workspace", wsA, "--output", "yaml"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
