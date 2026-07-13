import { describe, it, expect } from "vitest";
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
