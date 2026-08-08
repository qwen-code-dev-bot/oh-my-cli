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

function userContent(request: { body: unknown }): unknown {
  const body = request.body as { messages?: Array<{ role: string; content?: unknown }> };
  const user = (body.messages ?? []).find((m) => m.role === "user");
  return user?.content;
}

function png(): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1, 16);
  b.writeUInt32BE(1, 20);
  return b;
}

describe("Integration: --attach text files (Issue #797)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-attach-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-attach-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "line 1\nline 2 — 数据\n");
    fs.writeFileSync(path.join(tmpDir, "big.txt"), "x".repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(tmpDir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
    fs.writeFileSync(path.join(tmpDir, "pic.png"), png());
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("pins an attached text file verbatim into the request and the persisted session", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "review this", "--attach", "notes.md", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(server.requests.length).toBeGreaterThan(0);

    const content = userContent(server.requests[0]) as string;
    expect(typeof content).toBe("string");
    expect(content.startsWith("review this\n\n")).toBe(true);
    expect(content).toContain('<attached-file path="notes.md" name="notes.md">');
    expect(content).toContain("line 1\nline 2 — 数据\n");

    // The session persists exactly what the model saw.
    const sessDir = path.join(sessionDir, ".oh-my-cli", "sessions");
    const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
    const all = files.flatMap((f) =>
      fs.readFileSync(path.join(sessDir, f), "utf8").split("\n").filter(Boolean),
    );
    const userLines = all
      .map((l) => JSON.parse(l) as { role?: string; content?: string })
      .filter((m) => m.role === "user");
    expect(userLines.some((m) => (m.content ?? "").includes("<attached-file"))).toBe(true);
  });

  it("sends the prompt byte-for-byte without --attach (default unchanged)", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(["-p", "plain prompt", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(0);
    expect(userContent(server.requests[0])).toBe("plain prompt");
  });

  it("fails closed on an oversized attachment before any provider spend", async () => {
    const r = await runCli(
      ["-p", "review", "--attach", "big.txt", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/byte.*limit/i);
    expect(server.requests.length).toBe(0);
  });

  it("fails closed on a binary attachment before any provider spend", async () => {
    const r = await runCli(
      ["-p", "review", "--attach", "bin.dat", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/utf-8/i);
    expect(server.requests.length).toBe(0);
  });

  it("routes an image through --attach to the multimodal path (--image untouched)", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const viaAttach = await runCli(
      ["-p", "look", "--attach", "pic.png", "--workspace", tmpDir],
      baseEnv,
    );
    expect(viaAttach.code).toBe(0);
    const attachContent = userContent(server.requests[0]);
    expect(Array.isArray(attachContent)).toBe(true);
    expect(JSON.stringify(attachContent)).toContain("image_url");

    server.requests.length = 0;
    const viaImage = await runCli(
      ["-p", "look", "--image", "pic.png", "--workspace", tmpDir],
      baseEnv,
    );
    expect(viaImage.code).toBe(0);
    const imageContent = userContent(server.requests[0]);
    expect(Array.isArray(imageContent)).toBe(true);
    expect(JSON.stringify(imageContent)).toContain("image_url");
  });
});
