import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTools } from "../../src/tools.js";
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
  });
});
