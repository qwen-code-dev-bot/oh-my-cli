import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

interface ChatMessage {
  role: string;
  content?: string | null;
}

// The messages array of the most recent provider request.
function lastSentMessages(server: FakeServer): ChatMessage[] {
  const body = server.requests.at(-1)?.body as { messages?: ChatMessage[] } | undefined;
  return body?.messages ?? [];
}

describe("Integration: session checkpoint recovery on resume", () => {
  let server: FakeServer;
  let homeDir: string;
  let sessDir: string;
  let workspaceDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-recovery-home-"));
    sessDir = path.join(homeDir, ".oh-my-cli", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    // The seeded sessions belong to this workspace; resumes target it too so
    // the workspace binding guard (#554) lets the recovery semantics run.
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-recovery-ws-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
    server.setResponses([{ type: "text", content: "Recovered response" }]);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("promotes a complete checkpoint left by an interrupted write", async () => {
    const id = "interrupted-1";
    // A complete temp left by an atomic checkpoint that crashed before rename;
    // the canonical file was never created.
    fs.writeFileSync(
      path.join(sessDir, `${id}.jsonl.tmp`),
      JSON.stringify({ meta: true, model: "fake-model", workspace: workspaceDir, createdAt: 1 }) + "\n" +
        JSON.stringify({ role: "user", content: "prior turn" }) + "\n" +
        JSON.stringify({ role: "assistant", content: "earlier reply" }) + "\n",
    );

    const r = await runCli(["--resume", id, "-p", "next turn", "--workspace", workspaceDir], baseEnv);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Recovered response");
    // Canonical promoted, temp consumed.
    expect(fs.existsSync(path.join(sessDir, `${id}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(sessDir, `${id}.jsonl.tmp`))).toBe(false);
    // The promoted history was actually fed to the provider.
    const contents = lastSentMessages(server).map((m) => m.content);
    expect(contents).toContain("prior turn");
    expect(contents).toContain("next turn");
  });

  it("fails closed on a corrupt checkpoint, preserving it and the neighbor", async () => {
    const badId = "corrupt-1";
    const goodId = "neighbor-1";
    // Corrupt canonical: a mid-file unparseable line (not a benign trailing one).
    fs.writeFileSync(
      path.join(sessDir, `${badId}.jsonl`),
      JSON.stringify({ role: "user", content: "a" }) + "\n" +
        "{ this is not json }\n" +
        JSON.stringify({ role: "assistant", content: "b" }) + "\n",
    );
    // Healthy neighboring session.
    const goodPath = path.join(sessDir, `${goodId}.jsonl`);
    fs.writeFileSync(
      goodPath,
      JSON.stringify({ meta: true, model: "fake-model", workspace: "/w", createdAt: 1 }) + "\n" +
        JSON.stringify({ role: "user", content: "neighbor history" }) + "\n",
    );
    const goodBytes = fs.readFileSync(goodPath);

    const r = await runCli(["--resume", badId, "-p", "fresh start"], baseEnv);

    // Fail closed (Issue #454): a corrupt checkpoint is refused before any
    // provider interaction instead of silently starting a fresh session.
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("Recovered response");
    expect(r.stderr).toContain("Cannot resume");
    expect(r.stderr).toContain("corrupt");
    // The corrupt bytes were preserved in a quarantine sidecar, not deleted.
    const quarantined = fs.readdirSync(sessDir).filter((f) => f.startsWith(`${badId}.jsonl.corrupt-`));
    expect(quarantined.length).toBe(1);
    expect(fs.readFileSync(path.join(sessDir, quarantined[0]), "utf-8")).toContain("not json");
    // No fresh session replaced the corrupt one.
    expect(fs.existsSync(path.join(sessDir, `${badId}.jsonl`))).toBe(false);
    // The neighbor is byte-for-byte untouched.
    expect(fs.readFileSync(goodPath).equals(goodBytes)).toBe(true);
  });

  it("resumes a benign trailing-partial session without quarantining", async () => {
    const id = "trailing-1";
    fs.writeFileSync(
      path.join(sessDir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: "valid line" }) + "\n" +
        '{"role":"assistant","content":"incomple' + "\n",
    );

    const r = await runCli(["--resume", id, "-p", "continue"], baseEnv);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Recovered response");
    // No quarantine sidecar; the canonical is retained.
    const quarantined = fs.readdirSync(sessDir).filter((f) => f.startsWith(`${id}.jsonl.corrupt-`));
    expect(quarantined.length).toBe(0);
    expect(fs.existsSync(path.join(sessDir, `${id}.jsonl`))).toBe(true);
    expect(r.stderr).not.toContain("corrupt checkpoint");
  });
});
