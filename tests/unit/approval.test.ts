import { describe, it, expect } from "vitest";
import { needsApproval } from "../../src/approval.js";

describe("Approval modes", () => {
  it("default mode requires approval for mutating tools", () => {
    expect(needsApproval("default", "mutate-file")).toBe(true);
    expect(needsApproval("default", "mutate-shell")).toBe(true);
  });

  it("default mode does not require approval for reads", () => {
    expect(needsApproval("default", "read")).toBe(false);
  });

  it("auto-edit mode allows file mutations but requires shell approval", () => {
    expect(needsApproval("auto-edit", "mutate-file")).toBe(false);
    expect(needsApproval("auto-edit", "mutate-shell")).toBe(true);
    expect(needsApproval("auto-edit", "read")).toBe(false);
  });

  it("yolo mode allows everything", () => {
    expect(needsApproval("yolo", "mutate-file")).toBe(false);
    expect(needsApproval("yolo", "mutate-shell")).toBe(false);
    expect(needsApproval("yolo", "read")).toBe(false);
  });
});
