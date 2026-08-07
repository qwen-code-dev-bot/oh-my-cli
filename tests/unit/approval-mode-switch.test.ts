import { describe, it, expect } from "vitest";
import {
  APPROVAL_MODES,
  approvalModeCommandDecision,
  decisionAppliesMode,
  nextPendingEscalation,
  formatApprovalModeNotice,
  parseApprovalMode,
} from "../../src/approval-mode-switch.js";

describe("approval mode switch: parsing (Issue #715)", () => {
  it("accepts the three valid modes case-insensitively with surrounding space", () => {
    expect(parseApprovalMode("default")).toBe("default");
    expect(parseApprovalMode(" auto-edit ")).toBe("auto-edit");
    expect(parseApprovalMode("YOLO")).toBe("yolo");
  });

  it("rejects anything else", () => {
    expect(parseApprovalMode("")).toBeNull();
    expect(parseApprovalMode("yolo-ish")).toBeNull();
    expect(parseApprovalMode("sudo")).toBeNull();
  });
});

describe("approval mode switch: decision matrix (Issue #715)", () => {
  it("reports the effective mode with no argument", () => {
    expect(approvalModeCommandDecision("yolo", "", null)).toEqual({
      kind: "report",
      mode: "yolo",
    });
    expect(approvalModeCommandDecision("default", "   ", null).kind).toBe("report");
  });

  it("rejects an unknown mode naming it, changing nothing", () => {
    expect(approvalModeCommandDecision("default", "sudo", null)).toEqual({
      kind: "invalid",
      requested: "sudo",
    });
  });

  it("rejects trailing words other than confirm", () => {
    expect(approvalModeCommandDecision("default", "yolo please", null)).toEqual({
      kind: "invalid",
      requested: "please",
    });
  });

  it("reports unchanged when the requested mode is already effective", () => {
    expect(approvalModeCommandDecision("auto-edit", "auto-edit", null)).toEqual({
      kind: "unchanged",
      mode: "auto-edit",
    });
    // confirm of the already-effective mode is also plain unchanged, never an
    // escalation.
    expect(approvalModeCommandDecision("yolo", "yolo confirm", null).kind).toBe("unchanged");
  });

  it("applies de-escalation immediately (every strictly tighter pair)", () => {
    expect(approvalModeCommandDecision("yolo", "auto-edit", null)).toEqual({
      kind: "de-escalate",
      mode: "auto-edit",
    });
    expect(approvalModeCommandDecision("yolo", "default", null)).toEqual({
      kind: "de-escalate",
      mode: "default",
    });
    expect(approvalModeCommandDecision("auto-edit", "default", null)).toEqual({
      kind: "de-escalate",
      mode: "default",
    });
    // De-escalation never needs (or accepts) a pending escalation.
    expect(approvalModeCommandDecision("yolo", "default", "yolo").kind).toBe("de-escalate");
  });

  it("never applies an escalation without the confirm form", () => {
    expect(approvalModeCommandDecision("default", "auto-edit", null)).toEqual({
      kind: "escalation-needs-confirm",
      mode: "auto-edit",
    });
    expect(approvalModeCommandDecision("default", "yolo", null)).toEqual({
      kind: "escalation-needs-confirm",
      mode: "yolo",
    });
    expect(approvalModeCommandDecision("auto-edit", "yolo", null)).toEqual({
      kind: "escalation-needs-confirm",
      mode: "yolo",
    });
  });

  it("applies an escalation only when confirm matches the pending request", () => {
    expect(approvalModeCommandDecision("default", "yolo confirm", "yolo")).toEqual({
      kind: "escalation-confirmed",
      mode: "yolo",
    });
    expect(approvalModeCommandDecision("default", "auto-edit confirm", "auto-edit")).toEqual({
      kind: "escalation-confirmed",
      mode: "auto-edit",
    });
  });

  it("refuses confirm when there is no matching pending escalation", () => {
    expect(approvalModeCommandDecision("default", "yolo confirm", null)).toEqual({
      kind: "escalation-unconfirmed",
      mode: "yolo",
    });
    // Pending was auto-edit; confirming yolo applies nothing.
    expect(approvalModeCommandDecision("default", "yolo confirm", "auto-edit")).toEqual({
      kind: "escalation-unconfirmed",
      mode: "yolo",
    });
  });
});

describe("approval mode switch: state transitions (Issue #715)", () => {
  it("decisionAppliesMode is true only for immediate-apply outcomes", () => {
    expect(decisionAppliesMode({ kind: "de-escalate", mode: "default" })).toBe(true);
    expect(decisionAppliesMode({ kind: "escalation-confirmed", mode: "yolo" })).toBe(true);
    expect(decisionAppliesMode({ kind: "escalation-needs-confirm", mode: "yolo" })).toBe(false);
    expect(decisionAppliesMode({ kind: "report", mode: "default" })).toBe(false);
    expect(decisionAppliesMode({ kind: "invalid", requested: "x" })).toBe(false);
    expect(decisionAppliesMode({ kind: "unchanged", mode: "yolo" })).toBe(false);
    expect(decisionAppliesMode({ kind: "escalation-unconfirmed", mode: "yolo" })).toBe(false);
  });

  it("pending escalation is set only by an escalation request and cleared by everything else", () => {
    expect(nextPendingEscalation({ kind: "escalation-needs-confirm", mode: "yolo" })).toBe("yolo");
    expect(nextPendingEscalation({ kind: "escalation-confirmed", mode: "yolo" })).toBeNull();
    expect(nextPendingEscalation({ kind: "de-escalate", mode: "default" })).toBeNull();
    expect(nextPendingEscalation({ kind: "report", mode: "default" })).toBeNull();
    expect(nextPendingEscalation({ kind: "invalid", requested: "x" })).toBeNull();
    expect(nextPendingEscalation({ kind: "unchanged", mode: "yolo" })).toBeNull();
    expect(nextPendingEscalation({ kind: "escalation-unconfirmed", mode: "yolo" })).toBeNull();
  });

  it("a replaced escalation request supersedes the previous pending one", () => {
    // Request yolo, then request auto-edit before confirming: pending becomes
    // auto-edit, and `yolo confirm` afterwards applies nothing.
    const first = approvalModeCommandDecision("default", "yolo", null);
    const pending = nextPendingEscalation(first);
    expect(pending).toBe("yolo");
    const second = approvalModeCommandDecision("default", "auto-edit", pending);
    expect(second.kind).toBe("escalation-needs-confirm");
    const pending2 = nextPendingEscalation(second);
    expect(pending2).toBe("auto-edit");
    expect(
      approvalModeCommandDecision("default", "yolo confirm", pending2).kind,
    ).toBe("escalation-unconfirmed");
  });
});

describe("approval mode switch: shared honest notices (Issue #715)", () => {
  it("report names the effective mode and the valid modes", () => {
    const text = formatApprovalModeNotice({ kind: "report", mode: "default" });
    expect(text).toContain("Approval mode: default");
    for (const mode of APPROVAL_MODES) expect(text).toContain(mode);
  });

  it("invalid names the valid modes and the usage", () => {
    const text = formatApprovalModeNotice({ kind: "invalid", requested: "sudo" });
    expect(text).toContain('"sudo"');
    expect(text).toContain("default, auto-edit, yolo");
    expect(text).toContain("/approval-mode");
  });

  it("escalation warning says NOT applied and names the exact confirm form", () => {
    const text = formatApprovalModeNotice({ kind: "escalation-needs-confirm", mode: "yolo" });
    expect(text).toContain("Not applied");
    expect(text).toContain("/approval-mode yolo confirm");
    expect(text).toContain("without approval");
  });

  it("unconfirmed says nothing changed", () => {
    const text = formatApprovalModeNotice({ kind: "escalation-unconfirmed", mode: "yolo" });
    expect(text).toContain("Nothing confirmed");
    expect(text).toContain("no pending escalation to yolo");
  });

  it("confirmed and de-escalation state the new gating explicitly", () => {
    expect(
      formatApprovalModeNotice({ kind: "escalation-confirmed", mode: "yolo" }),
    ).toContain("Approval mode set to yolo");
    expect(
      formatApprovalModeNotice({ kind: "de-escalate", mode: "default" }),
    ).toContain("Approval mode set to default");
  });
});
