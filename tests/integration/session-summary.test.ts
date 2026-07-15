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

function sessionIds(sessionDir: string): string[] {
  const dir = path.join(sessionDir, ".oh-my-cli", "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}

describe("Integration: session listing and resume", () => {
  let server: FakeServer;
  let sessionDir: string;
  let workspaceDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-list-sess-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-list-ws-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("lists two sessions with metadata and resumes the intended one", async () => {
    // Create two distinct sessions.
    server.setResponses([{ type: "text", content: "first answer" }]);
    const r1 = await runCli(["-p", "Alpha task", "--workspace", workspaceDir], baseEnv);
    expect(r1.stdout).toContain("first answer");

    server.setResponses([{ type: "text", content: "second answer" }]);
    const r2 = await runCli(["-p", "Beta task", "--workspace", workspaceDir], baseEnv);
    expect(r2.stdout).toContain("second answer");

    const ids = sessionIds(sessionDir);
    expect(ids.length).toBe(2);

    // The metadata line is recorded as the first line of each session.
    for (const id of ids) {
      const firstLine = fs
        .readFileSync(path.join(sessionDir, ".oh-my-cli", "sessions", `${id}.jsonl`), "utf-8")
        .split("\n")[0];
      const meta = JSON.parse(firstLine);
      expect(meta.meta).toBe(true);
      expect(meta.model).toBe("fake-model");
      expect(meta.workspace).toBe(fs.realpathSync(workspaceDir));
    }

    // Listing identifies both sessions from their metadata.
    const list = await runCli(["--list-sessions"], baseEnv);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Sessions");
    expect(list.stdout).toContain("fake-model");
    expect(list.stdout).toContain("Summary: 2 resumable, 0 corrupt (2 total)");
    for (const id of ids) expect(list.stdout).toContain(id);

    // Resume one specific session; its next interaction is preserved.
    server.setResponses([{ type: "text", content: "resumed alpha" }]);
    const resumed = await runCli(["--resume", ids[0], "-p", "Continue alpha"], baseEnv);
    expect(resumed.stdout).toContain("resumed alpha");
    expect(resumed.code).toBe(0);
  });

  it("reports an empty store without sessions", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-empty-"));
    try {
      const list = await runCli(["--list-sessions"], { ...baseEnv, HOME: emptyDir });
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("No resumable sessions found.");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("isolates a corrupt checkpoint from healthy siblings", async () => {
    // A healthy session.
    server.setResponses([{ type: "text", content: "healthy answer" }]);
    const r = await runCli(["-p", "Healthy task", "--workspace", workspaceDir], baseEnv);
    expect(r.stdout).toContain("healthy answer");

    const healthyIds = sessionIds(sessionDir);
    const healthyId = healthyIds[healthyIds.length - 1];

    // A corrupt checkpoint dropped into the same store.
    const sessDir = path.join(sessionDir, ".oh-my-cli", "sessions");
    const corruptId = "corrupt-checkpoint";
    const corruptPath = path.join(sessDir, `${corruptId}.jsonl`);
    fs.writeFileSync(corruptPath, "{not valid json}\n{also broken}\n");
    const corruptBefore = fs.readFileSync(corruptPath, "utf-8");

    // Listing flags the corrupt one and keeps the healthy one resumable.
    const list = await runCli(["--list-sessions"], baseEnv);
    expect(list.stdout).toContain("✗");
    expect(list.stdout).toContain("corrupt");
    expect(list.stdout).toContain("✓");
    expect(list.stdout).toContain(corruptId);
    expect(list.stdout).toContain(healthyId);

    // Listing is read-only: the corrupt checkpoint is untouched.
    expect(fs.readFileSync(corruptPath, "utf-8")).toBe(corruptBefore);

    // The healthy sibling still resumes normally despite the corrupt neighbor.
    server.setResponses([{ type: "text", content: "still works" }]);
    const resumed = await runCli(["--resume", healthyId, "-p", "go on"], baseEnv);
    expect(resumed.stdout).toContain("still works");
    expect(resumed.code).toBe(0);
  });
});
