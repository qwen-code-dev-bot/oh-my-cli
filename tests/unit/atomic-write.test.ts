import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteFile } from "../../src/atomic-write.js";

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-atomic-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes content and creates parent directories", () => {
    const target = path.join(tmpDir, "deep", "dir", "file.txt");
    atomicWriteFile(target, "hello atomic");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello atomic");
  });

  it("replaces existing content through rename, not truncation", () => {
    const target = path.join(tmpDir, "file.txt");
    fs.writeFileSync(target, "original content");
    atomicWriteFile(target, "new");
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    // No temp litter is left behind.
    expect(fs.readdirSync(tmpDir)).toEqual(["file.txt"]);
  });

  it("preserves the mode of an existing file", () => {
    const target = path.join(tmpDir, "script.sh");
    fs.writeFileSync(target, "#!/bin/sh\necho one\n");
    fs.chmodSync(target, 0o755);
    atomicWriteFile(target, "#!/bin/sh\necho two\n");
    expect(fs.readFileSync(target, "utf-8")).toContain("echo two");
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("fails closed without touching other files or leaving temp litter", () => {
    const precious = path.join(tmpDir, "file.txt");
    fs.writeFileSync(precious, "precious");
    // Deterministic failure: the "parent directory" of the target is a file,
    // so directory creation throws ENOTDIR before any write happens.
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "in the way");
    const impossible = path.join(blocker, "file.txt");
    expect(() => atomicWriteFile(impossible, "x")).toThrow();
    expect(fs.readFileSync(blocker, "utf-8")).toBe("in the way");
    expect(fs.readFileSync(precious, "utf-8")).toBe("precious");
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("overwrites atomically even for large content", () => {
    const target = path.join(tmpDir, "big.txt");
    fs.writeFileSync(target, "small");
    const big = "x".repeat(2_000_000);
    atomicWriteFile(target, big);
    expect(fs.readFileSync(target, "utf-8")).toBe(big);
    expect(fs.readdirSync(tmpDir)).toEqual(["big.txt"]);
  });
});

describe("atomicWriteFile rename failure (Issue #862)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-atomic-862-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws and preserves prior content when the final rename fails", () => {
    const target = path.join(dir, "store.json");
    fs.writeFileSync(target, '{"prior":true}\n', "utf-8");
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated crash during rename");
    });
    try {
      expect(() => atomicWriteFile(target, '{"next":true}\n')).toThrow("simulated crash during rename");
      expect(fs.readFileSync(target, "utf-8")).toBe('{"prior":true}\n');
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
