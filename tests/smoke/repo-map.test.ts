import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Smoke coverage for the automatic repository map (Issue #205, test plan): the
// bounded map is reachable through the built CLI and is clipped to the token
// budget. The same collectRepoMap/formatRepoMap path seeds a fresh session's
// system prompt, so exercising the flag demonstrates the injected context end
// to end. --repo-map is read-only and exits before any provider call.

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

describe("smoke: --repo-map", () => {
  let ws: string;
  const env = { OPENAI_API_KEY: "fake-key" };

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "omc-repomap-smoke-"));
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "src", "index.ts"),
      "export function main() {\nexport class App {\nexport const VERSION = 1;\n",
    );
    fs.writeFileSync(
      path.join(ws, "src", "engine.ts"),
      Array.from({ length: 20 }, (_v, i) => `export function fn${i}() {`).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(ws, "README.md"), "# fixture, no code symbols\n");
    fs.writeFileSync(path.join(ws, ".gitignore"), "node_modules/\n");
  });

  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("emits a bounded repository map of the workspace", async () => {
    const r = await runCli(["--repo-map", "--workspace", ws], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Repository map (oh-my-cli.repo-map v1)");
    expect(r.stdout).toContain("src/index.ts");
    expect(r.stdout).toContain("export function main()");
    // Prose with no symbols is not part of a symbol map.
    expect(r.stdout).not.toContain("README.md");
  });

  it("clips the map to a small token budget", async () => {
    const r = await runCli(["--repo-map", "--workspace", ws, "--map-tokens", "8"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("truncated");
  });

  it("emits JSON with an ok state and usage within budget", async () => {
    const r = await runCli(["--repo-map", "--workspace", ws, "--output", "json"], env);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.stdout);
    expect(snap.schema).toBe("oh-my-cli.repo-map");
    expect(snap.state).toBe("ok");
    expect(snap.files.length).toBeGreaterThan(0);
    expect(snap.usedChars).toBeLessThanOrEqual(snap.budgetChars);
  });

  it("rejects an invalid --map-tokens value", async () => {
    const r = await runCli(["--repo-map", "--workspace", ws, "--map-tokens", "abc"], env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("invalid --map-tokens");
  });
});
