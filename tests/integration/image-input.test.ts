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

// A minimal valid PNG header (signature + IHDR with the given dimensions).
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("Integration: multimodal image input", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-image-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-image-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
    fs.writeFileSync(path.join(tmpDir, "shot.png"), png(8, 8));
    fs.writeFileSync(path.join(tmpDir, "note.txt"), "not an image");
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("sends an attached image to the provider as a multimodal content part", async () => {
    server.setResponse({ type: "text", content: "I see a small square." });

    const result = await runCli(
      ["-p", "describe", "--image", "shot.png", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    expect(server.requests.length).toBe(1);

    const body = server.requests[0].body as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = body.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg).toBeDefined();

    const parts = userMsg!.content as Array<Record<string, unknown>>;
    const textPart = parts.find((p) => p.type === "text") as { text: string } | undefined;
    expect(textPart?.text).toBe("describe");

    const imagePart = parts.find((p) => p.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("persists only a non-secret reference and reports it in the summary", async () => {
    server.setResponse({ type: "text", content: "ok" });

    const result = await runCli(
      ["-p", "describe", "--image", "shot.png", "--summary", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    // The summary surfaces a non-secret reference (name, type, size).
    expect(result.stdout).toContain("images:");
    expect(result.stdout).toContain("shot.png (image/png, 24 bytes)");

    // The session log keeps the reference but never the raw image bytes.
    const sessDir = path.join(sessionDir, ".oh-my-cli", "sessions");
    const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
    const all = files.map((f) => fs.readFileSync(path.join(sessDir, f), "utf-8")).join("\n");
    expect(all).not.toContain("data:image");
    expect(all).toContain("shot.png");

    const messages = all
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => !("meta" in o));
    const userWithImg = messages.find(
      (o) => o.role === "user" && Array.isArray(o.images),
    ) as { images: Array<Record<string, unknown>> } | undefined;
    expect(userWithImg).toBeDefined();
    expect(userWithImg!.images[0]).toMatchObject({
      name: "shot.png",
      mediaType: "image/png",
      bytes: 24,
    });
    expect(userWithImg!.images[0]).not.toHaveProperty("dataUrl");
  });

  it("fails with a clear error and non-zero exit for a missing image", async () => {
    const result = await runCli(
      ["-p", "describe", "--image", "missing.png", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Image not found");
    expect(server.requests.length).toBe(0);
  });

  it("fails with a clear error for an unsupported file type", async () => {
    const result = await runCli(
      ["-p", "describe", "--image", "note.txt", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unsupported image type");
    expect(server.requests.length).toBe(0);
  });
});
