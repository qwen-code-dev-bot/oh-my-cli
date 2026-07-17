import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";

describe("Workspace path confinement", () => {
  const ws = new Workspace("/workspace");

  it("resolves relative paths within workspace", () => {
    expect(ws.resolve("foo/bar.txt")).toBe("/workspace/foo/bar.txt");
  });

  it("rejects path escape with ..", () => {
    expect(() => ws.resolve("../etc/passwd")).toThrow("Path escape rejected");
  });

  it("rejects absolute path outside workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrow("Path escape rejected");
  });

  it("allows the workspace root itself", () => {
    expect(ws.resolve(".")).toBe("/workspace");
  });
});

describe("Workspace symlink guard", () => {
  const tmpDirs: string[] = [];
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("accepts in-workspace files when the root sits behind a symlinked prefix", () => {
    // Reproduces the macOS false positive (e.g. /var -> /private/var): the
    // workspace root is a symlink alias, so ancestor realpaths resolve to the
    // canonical target rather than the raw root.
    const base = tmp();
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "hello.txt"), "hi");
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);

    const ws = new Workspace(link);
    expect(ws.resolveSafe("hello.txt")).toBe(path.join(link, "hello.txt"));
  });

  it("still rejects an in-workspace symlink that escapes outside the root", () => {
    const base = tmp();
    const wsRoot = path.join(base, "ws");
    fs.mkdirSync(wsRoot);
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(wsRoot, "escape"));

    const ws = new Workspace(wsRoot);
    expect(() => ws.resolveSafe("escape/secret.txt")).toThrow(
      "Symlink path escape rejected",
    );
  });
});
