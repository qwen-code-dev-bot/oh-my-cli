import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

interface ReqMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ function: { name: string } }>;
}

function requestMessages(body: unknown): ReqMessage[] {
  const b = body as { messages?: ReqMessage[] };
  return Array.isArray(b.messages) ? b.messages : [];
}

describe("Integration: session compaction", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-compact-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-compact-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    // Each test starts with no sessions so ids are unambiguous.
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function singleSessionId(): string {
    const ids = fs.readdirSync(sessionsHome()).filter((f) => f.endsWith(".jsonl"));
    expect(ids.length).toBe(1);
    return ids[0].slice(0, -".jsonl".length);
  }

  it("--compact writes a sidecar, prints a report, and preserves the original", async () => {
    // A manually authored session: a goal, a completed write, a final answer.
    const id = "11111111-1111-1111-1111-111111111111";
    fs.mkdirSync(sessionsHome(), { recursive: true });
    const lines = [
      JSON.stringify({ meta: true, createdAt: Date.now() }),
      JSON.stringify({ role: "system", content: "You are a coding agent." }),
      JSON.stringify({ role: "user", content: "Add the feature." }),
      JSON.stringify({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "src/x.ts", content: "x" }) } }] }),
      JSON.stringify({ role: "tool", tool_call_id: "c1", content: "Wrote src/x.ts" }),
      JSON.stringify({ role: "assistant", content: "Done." }),
    ];
    fs.writeFileSync(path.join(sessionsHome(), `${id}.jsonl`), lines.join("\n") + "\n");
    const before = fs.readFileSync(path.join(sessionsHome(), `${id}.jsonl`), "utf-8");

    const result = await runCli(["--compact", id], baseEnv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Compaction summary");
    expect(result.stdout).toContain("Completed receipts: 1");

    // Sidecar created; original transcript byte-for-byte unchanged.
    expect(fs.existsSync(path.join(sessionsHome(), `${id}.compact.json`))).toBe(true);
    expect(fs.readFileSync(path.join(sessionsHome(), `${id}.jsonl`), "utf-8")).toBe(before);
  });

  it("--compact on a missing session exits 2", async () => {
    const result = await runCli(["--compact", "no-such-session"], baseEnv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no such session");
  });

  it("resume consumes the compaction contract and does not replay a completed mutation", async () => {
    // Run a real session that writes a file, then answers.
    fs.writeFileSync(path.join(tmpDir, "created.txt"), "");
    fs.rmSync(path.join(tmpDir, "created.txt"));
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_w", name: "write", arguments: JSON.stringify({ path: "created.txt", content: "original" }) }],
      },
      { type: "text", content: "Created the file." },
    ]);
    const first = await runCli(
      ["-p", "Create created.txt", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(first.code).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, "created.txt"), "utf-8")).toBe("original");

    const id = singleSessionId();

    // Compact it.
    const compact = await runCli(["--compact", id], baseEnv);
    expect(compact.code).toBe(0);

    // Resume: the model only answers (no tool call). Inspect what the provider
    // actually received. Clear the request log so request[0] is the resume call.
    server.requests.length = 0;
    server.setResponses([{ type: "text", content: "The file already exists; nothing to redo." }]);
    const resume = await runCli(
      ["--resume", id, "-p", "What is left to do?", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(resume.code).toBe(0);
    expect(resume.stdout).toContain("The file already exists; nothing to redo.");

    // The resumed provider request carried the compacted context: a summary note
    // and NO replay of the completed write tool_call.
    const msgs = requestMessages(server.requests[0].body);
    const hasCompactionNote = msgs.some(
      (m) => typeof m.content === "string" && m.content.includes("[oh-my-cli.compaction"),
    );
    expect(hasCompactionNote).toBe(true);
    const replaysWrite = msgs.some((m) =>
      m.tool_calls?.some((tc) => tc.function.name === "write"),
    );
    expect(replaysWrite).toBe(false);
    // The summary references the completed write as a receipt.
    const note = msgs.find((m) => typeof m.content === "string" && m.content.includes("[oh-my-cli.compaction"));
    expect(note?.content).toContain("created.txt");
    expect(note?.content).toContain("do NOT repeat");

    // The completed mutation was not re-run: the file is unchanged.
    expect(fs.readFileSync(path.join(tmpDir, "created.txt"), "utf-8")).toBe("original");
  });

  it("auto-compacts in-memory once context pressure crosses the threshold", async () => {
    // Each fake call reports prompt_tokens=5; threshold 5 trips after round 0.
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "echo one" }) }] },
      { type: "tool_calls", toolCalls: [{ id: "c2", name: "shell", arguments: JSON.stringify({ command: "echo two" }) }] },
      { type: "text", content: "All done." },
    ]);

    const result = await runCli(
      ["-p", "Do a long task", "--approval-mode", "yolo", "--workspace", tmpDir, "--compact-threshold", "5"],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("All done.");

    // A provider request after the first carried the compacted summary.
    const compactedRequest = server.requests.slice(1).find((r) =>
      requestMessages(r.body).some(
        (m) => typeof m.content === "string" && m.content.includes("[oh-my-cli.compaction"),
      ),
    );
    expect(compactedRequest).toBeDefined();
  });

  it("does not auto-compact without a threshold", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "echo one" }) }] },
      { type: "text", content: "Done." },
    ]);
    const result = await runCli(
      ["-p", "Do a task", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    const anyCompacted = server.requests.some((r) =>
      requestMessages(r.body).some(
        (m) => typeof m.content === "string" && m.content.includes("[oh-my-cli.compaction"),
      ),
    );
    expect(anyCompacted).toBe(false);
  });
});
