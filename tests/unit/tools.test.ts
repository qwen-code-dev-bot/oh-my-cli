import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTools, runShellCommand, formatLiveness } from "../../src/tools.js";
import { Workspace } from "../../src/workspace.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Tools", () => {
  let tmpDir: string;
  let workspace: Workspace;
  const tools = createTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-tools-"));
    workspace = new Workspace(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("reads a file", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");
      const result = await toolMap.get("read")!.execute({ path: "hello.txt" }, workspace);
      expect(result.content).toBe("world");
      expect(result.isError).toBeUndefined();
    });

    it("reads with offset and limit", async () => {
      fs.writeFileSync(path.join(tmpDir, "lines.txt"), "a\nb\nc\nd\ne");
      const result = await toolMap.get("read")!.execute({ path: "lines.txt", offset: 1, limit: 2 }, workspace);
      expect(result.content).toBe("b\nc");
    });

    it("rejects path escape", async () => {
      try {
        await toolMap.get("read")!.execute({ path: "../../etc/passwd" }, workspace);
        expect.fail("Should have thrown");
      } catch (err: unknown) {
        expect((err as Error).message).toContain("Path escape");
      }
    });
  });

  describe("write", () => {
    it("creates a file", async () => {
      const result = await toolMap.get("write")!.execute({ path: "new.txt", content: "hello" }, workspace);
      expect(result.content).toContain("Wrote");
      expect(fs.readFileSync(path.join(tmpDir, "new.txt"), "utf-8")).toBe("hello");
    });

    it("creates parent directories", async () => {
      await toolMap.get("write")!.execute({ path: "sub/dir/file.txt", content: "deep" }, workspace);
      expect(fs.readFileSync(path.join(tmpDir, "sub/dir/file.txt"), "utf-8")).toBe("deep");
    });

    it("overwrites existing file", async () => {
      fs.writeFileSync(path.join(tmpDir, "overwrite.txt"), "old");
      await toolMap.get("write")!.execute({ path: "overwrite.txt", content: "new" }, workspace);
      expect(fs.readFileSync(path.join(tmpDir, "overwrite.txt"), "utf-8")).toBe("new");
    });
  });

  describe("edit", () => {
    it("replaces exactly one occurrence", async () => {
      fs.writeFileSync(path.join(tmpDir, "edit.txt"), "foo bar baz");
      const result = await toolMap.get("edit")!.execute(
        { path: "edit.txt", oldText: "bar", newText: "qux" },
        workspace,
      );
      expect(result.content).toContain("replaced 1");
      expect(fs.readFileSync(path.join(tmpDir, "edit.txt"), "utf-8")).toBe("foo qux baz");
    });

    it("fails on zero matches", async () => {
      fs.writeFileSync(path.join(tmpDir, "edit.txt"), "foo bar");
      const result = await toolMap.get("edit")!.execute(
        { path: "edit.txt", oldText: "xyz", newText: "abc" },
        workspace,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("fails on multiple matches", async () => {
      fs.writeFileSync(path.join(tmpDir, "edit.txt"), "foo foo bar");
      const result = await toolMap.get("edit")!.execute(
        { path: "edit.txt", oldText: "foo", newText: "baz" },
        workspace,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("2 times");
    });
  });

  describe("shell", () => {
    it("executes a command", async () => {
      const result = await toolMap.get("shell")!.execute({ command: "echo hello" }, workspace);
      expect(result.content).toContain("hello");
    });

    it("captures stderr on failure", async () => {
      const result = await toolMap.get("shell")!.execute({ command: "ls /nonexistent-path-xyz" }, workspace);
      expect(result.isError).toBe(true);
    });

    it("times out long-running commands", async () => {
      const result = await toolMap.get("shell")!.execute({ command: "sleep 10", timeout: 1 }, workspace);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    });

    it("reports elapsed wall-clock time on the result", async () => {
      const result = await toolMap.get("shell")!.execute({ command: "sleep 0.2" }, workspace);
      expect(result.isError).toBeUndefined();
      expect(typeof result.elapsedMs).toBe("number");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("formatLiveness", () => {
    it("renders a redaction-safe elapsed line (min 1s)", () => {
      expect(formatLiveness(0)).toBe("… still running (1s elapsed)");
      expect(formatLiveness(7_400)).toBe("… still running (7s elapsed)");
      expect(formatLiveness(12_600)).toBe("… still running (13s elapsed)");
    });

    it("never includes command text, output, or paths", () => {
      const line = formatLiveness(9_000);
      expect(line).not.toMatch(/password|\/home|secret/i);
      expect(line).toContain("elapsed");
    });
  });

  describe("runShellCommand", () => {
    it("captures stdout and exit status for a fast command", async () => {
      const beats: number[] = [];
      const r = await runShellCommand({
        command: "echo hi",
        timeoutMs: 5_000,
        onLiveness: (e) => beats.push(e),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("hi");
      expect(r.timedOut).toBe(false);
      expect(r.outputTruncated).toBe(false);
      // A fast command never crosses the (default 5s) liveness threshold.
      expect(beats.length).toBe(0);
    });

    it("emits periodic liveness beats for a slow command", async () => {
      const beats: number[] = [];
      const r = await runShellCommand({
        command: "sleep 0.3",
        timeoutMs: 5_000,
        livenessThresholdMs: 50,
        livenessIntervalMs: 50,
        onLiveness: (e) => beats.push(e),
      });
      expect(r.status).toBe(0);
      expect(beats.length).toBeGreaterThanOrEqual(2);
      // Elapsed is monotonic and every beat is at/after the threshold.
      expect(beats[0]).toBeGreaterThanOrEqual(50);
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i]).toBeGreaterThanOrEqual(beats[i - 1]);
      }
    });

    it("kills the command and flags timedOut when the timeout fires", async () => {
      const r = await runShellCommand({ command: "sleep 5", timeoutMs: 150 });
      expect(r.timedOut).toBe(true);
      expect(r.status).toBeNull();
      expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("bounds each stream to the output cap", async () => {
      const r = await runShellCommand({
        command: "printf 'a%.0s' {1..5000}",
        timeoutMs: 5_000,
        maxOutput: 100,
      });
      expect(r.status).toBe(0);
      expect(r.outputTruncated).toBe(true);
      expect(Buffer.byteLength(r.stdout, "utf-8")).toBeLessThanOrEqual(100);
    });

    it("preserves a non-zero exit code without flagging a timeout", async () => {
      const r = await runShellCommand({ command: "exit 3", timeoutMs: 5_000 });
      expect(r.status).toBe(3);
      expect(r.timedOut).toBe(false);
    });
  });
});
