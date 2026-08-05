import { describe, it, expect } from "vitest";
import { storeDoctorStrictExit } from "../../src/store-doctor.js";

describe("storeDoctorStrictExit (Issue #676)", () => {
  it("maps a healthy verdict to exit 0", () => {
    expect(storeDoctorStrictExit("healthy")).toBe(0);
  });

  it("maps an attention-needed verdict to exit 1", () => {
    expect(storeDoctorStrictExit("attention-needed")).toBe(1);
  });

  it("is a pure, stable mapping", () => {
    expect(storeDoctorStrictExit("healthy")).toBe(storeDoctorStrictExit("healthy"));
    expect(storeDoctorStrictExit("attention-needed")).toBe(
      storeDoctorStrictExit("attention-needed"),
    );
  });
});
