import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const APPEND_LABEL = "<user-run-instructions>";

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

// The provider sees the seeded system message: the honest surface to assert
// what the model actually receives.
function systemMessageOf(request: { body: unknown }): string {
  const body = request.body as { messages?: Array<{ role: string; content?: string }> };
  const system = (body.messages ?? []).find((m) => m.role === "system");
  return system?.content ?? "";
}

describe("Integration: --append-system-prompt (Issue #789)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-asp-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-asp-sess-"));
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
  });

  it("seeds a fresh session with the built-in prompt plus the labeled appended section", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "Say done", "--append-system-prompt", "Use British spelling.", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(server.requests.length).toBeGreaterThan(0);
    const systemContent = systemMessageOf(server.requests[0]);
    // Built-in identity is intact AND the labeled section carries the text.
    expect(systemContent).toContain("oh-my-cli");
    expect(systemContent).toContain(APPEND_LABEL);
    expect(systemContent).toContain("Use British spelling.");
    // The appended section comes after the built-in prompt.
    expect(systemContent.indexOf(APPEND_LABEL)).toBeGreaterThan(systemContent.indexOf("oh-my-cli"));
  });

  it("leaves the system prompt untouched without the flag (default unchanged)", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(["-p", "Say done", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    const systemContent = systemMessageOf(server.requests[0]);
    expect(systemContent).toContain("oh-my-cli");
    expect(systemContent).not.toContain(APPEND_LABEL);
  });

  it("fails closed with --resume and leaves the session store untouched", async () => {
    server.setResponses([{ type: "text", content: "done" }]);
    const seeded = await runCli(["-p", "Say done", "--workspace", tmpDir], baseEnv);
    expect(seeded.code).toBe(0);

    const before = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    expect(before.code).toBe(0);

    const r = await runCli(
      ["-p", "Say more", "--resume", "latest-will-not-matter", "--append-system-prompt", "X", "--workspace", tmpDir],
      baseEnv,
    );
    // The guard fails closed on the combination itself, before resolution.
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-system-prompt applies to fresh sessions only");
    expect(r.stderr).toContain("keep their original system message");

    const after = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    // Compare the stable shape only — ageMs moves with the clock, and the
    // point is that the failed run neither added nor modified any session.
    const stableShape = (raw: string) =>
      JSON.parse(raw).sessions.map((s: { id: string; messageCount: number }) => [s.id, s.messageCount]);
    expect(stableShape(after.stdout)).toEqual(stableShape(before.stdout));
  });

  it("fails closed with --continue", async () => {
    const r = await runCli(
      ["-p", "Say more", "--continue", "--append-system-prompt", "X", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-system-prompt applies to fresh sessions only");
  });

  it("fails closed on empty text", async () => {
    const r = await runCli(
      ["-p", "Say done", "--append-system-prompt", "   ", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires non-empty text");
  });

  it("fails closed on oversized text", async () => {
    const oversized = "x".repeat(8001);
    const r = await runCli(
      ["-p", "Say done", "--append-system-prompt", oversized, "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("exceeds the");
    expect(r.stderr).toContain("8000");
  });
});
