import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizePlatform,
  isSupportedPlatform,
  checkNodeVersion,
  checkCliResolution,
  checkStateDirectory,
  checkPlatformSupport,
  collectDoctorReport,
  formatDoctorReport,
} from "../../src/doctor.js";
import type { DoctorReport } from "../../src/doctor.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("doctor: platform normalization", () => {
  it("maps known platforms to friendly names", () => {
    expect(normalizePlatform("linux")).toBe("Linux");
    expect(normalizePlatform("darwin")).toBe("macOS");
    expect(normalizePlatform("win32")).toBe("Windows");
  });

  it("passes through unknown platforms and handles empty input", () => {
    expect(normalizePlatform("freebsd")).toBe("freebsd");
    expect(normalizePlatform("")).toBe("unknown");
  });

  it("recognizes supported vs unsupported platforms", () => {
    expect(isSupportedPlatform("linux")).toBe(true);
    expect(isSupportedPlatform("darwin")).toBe(true);
    expect(isSupportedPlatform("win32")).toBe(true);
    expect(isSupportedPlatform("sunos")).toBe(false);
  });
});

describe("doctor: checkNodeVersion", () => {
  it("passes at or above the minimum major", () => {
    expect(checkNodeVersion("v22.5.0").status).toBe("pass");
    expect(checkNodeVersion("v23.0.0").status).toBe("pass");
    expect(checkNodeVersion("v22.0.0", 22).status).toBe("pass");
  });

  it("fails below the minimum major", () => {
    const c = checkNodeVersion("v20.11.0");
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("Upgrade Node.js");
  });

  it("warns on an unrecognized version string", () => {
    expect(checkNodeVersion("not-a-version").status).toBe("warn");
  });

  it("honors a custom minimum", () => {
    expect(checkNodeVersion("v18.0.0", 18).status).toBe("pass");
    expect(checkNodeVersion("v18.0.0", 20).status).toBe("fail");
  });
});

describe("doctor: checkCliResolution", () => {
  it("passes when the entry exists", () => {
    expect(checkCliResolution("/any/entry.js", () => true).status).toBe("pass");
  });

  it("fails with remediation when the entry is missing", () => {
    const c = checkCliResolution("/missing/entry.js", () => false);
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("npm run build");
  });
});

describe("doctor: checkStateDirectory (cross-platform fixtures)", () => {
  it("fails when HOME is unknown", () => {
    const c = checkStateDirectory("/whatever/.oh-my-cli", { home: null });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("HOME not set");
  });

  it("passes when an existing state dir is writable (Linux/macOS fixture)", () => {
    const c = checkStateDirectory("/home/u/.oh-my-cli", {
      home: "/home/u",
      exists: () => true,
      isWritable: () => true,
    });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("(writable)");
  });

  it("fails when an existing state dir is not writable", () => {
    const c = checkStateDirectory("C:\\Users\\u\\.oh-my-cli", {
      home: "C:\\Users\\u",
      exists: () => true,
      isWritable: () => false,
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("not writable");
  });

  it("passes (creatable) when the dir is absent but its parent is writable", () => {
    const c = checkStateDirectory("/home/u/.oh-my-cli", {
      home: "/home/u",
      exists: () => false,
      isWritable: () => true,
    });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("(creatable)");
  });

  it("fails when the dir is absent and the parent is not writable", () => {
    const c = checkStateDirectory("/home/u/.oh-my-cli", {
      home: "/home/u",
      exists: () => false,
      isWritable: () => false,
    });
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("can be created");
  });
});

describe("doctor: checkPlatformSupport", () => {
  it("passes on supported platforms", () => {
    expect(checkPlatformSupport("linux").status).toBe("pass");
    expect(checkPlatformSupport("darwin").status).toBe("pass");
    expect(checkPlatformSupport("win32").status).toBe("pass");
  });

  it("warns on an untested platform with remediation", () => {
    const c = checkPlatformSupport("sunos");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("untested");
    expect(c.remediation).toContain("Linux");
    expect(c.remediation).toContain("macOS");
    expect(c.remediation).toContain("Windows");
  });
});

describe("doctor: collectDoctorReport", () => {
  let tmpDir: string;
  let entryFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-doctor-"));
    entryFile = path.join(tmpDir, "index.js");
    fs.writeFileSync(entryFile, "// entry");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports all checks passing on a healthy host fixture", () => {
    const report = collectDoctorReport({
      nodeVersion: "v22.5.0",
      entryPath: entryFile,
      home: tmpDir,
      stateBaseDir: path.join(tmpDir, ".oh-my-cli"),
      platform: "linux",
    });
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(report.ok).toBe(true);
  });

  it("marks the report not ok when any check fails", () => {
    const report = collectDoctorReport({
      nodeVersion: "v18.0.0",
      entryPath: entryFile,
      home: tmpDir,
      stateBaseDir: path.join(tmpDir, ".oh-my-cli"),
      platform: "linux",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "node-version")!.status).toBe("fail");
  });

  it("stays ok with only warnings (untested platform)", () => {
    const report = collectDoctorReport({
      nodeVersion: "v22.5.0",
      entryPath: entryFile,
      home: tmpDir,
      stateBaseDir: path.join(tmpDir, ".oh-my-cli"),
      platform: "aix",
    });
    expect(report.checks.find((c) => c.id === "platform-support")!.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("fails when the CLI entry is missing", () => {
    const report = collectDoctorReport({
      nodeVersion: "v22.5.0",
      entryPath: path.join(tmpDir, "does-not-exist.js"),
      home: tmpDir,
      stateBaseDir: path.join(tmpDir, ".oh-my-cli"),
      platform: "linux",
    });
    expect(report.checks.find((c) => c.id === "cli-resolution")!.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("doctor: formatDoctorReport", () => {
  const mk = (over: Partial<DoctorReport> = {}): DoctorReport => ({
    checks: [
      { id: "node-version", label: "Node runtime", status: "pass", detail: "v22.5.0 (>= 22)" },
      { id: "cli-resolution", label: "CLI entry", status: "pass", detail: "dist/index.js" },
      { id: "state-directory", label: "State directory", status: "pass", detail: "~/.oh-my-cli (writable)" },
      { id: "platform-support", label: "Platform", status: "pass", detail: "Linux" },
    ],
    ok: true,
    ...over,
  });

  it("renders symbols, labels, and a summary", () => {
    const out = formatDoctorReport(mk());
    expect(out).toContain("Doctor");
    expect(out).toContain("✓ Node runtime");
    expect(out).toContain("✓ Platform");
    expect(out).toMatch(/Summary: 4 passed, 0 warnings, 0 failed/);
  });

  it("shows remediation only for non-passing checks", () => {
    const out = formatDoctorReport(
      mk({
        checks: [
          { id: "node-version", label: "Node runtime", status: "fail", detail: "v18.0.0 (< 22)", remediation: "Upgrade Node.js to v22 or newer." },
          { id: "platform-support", label: "Platform", status: "warn", detail: "SunOS (untested)", remediation: "Supported platforms: Linux, macOS, Windows." },
        ],
        ok: false,
      }),
    );
    expect(out).toContain("✗ Node runtime");
    expect(out).toContain("⚠ Platform");
    expect(out).toContain("→ Upgrade Node.js to v22 or newer.");
    expect(out).toMatch(/Summary: 0 passed, 1 warnings, 1 failed/);
  });

  it("redacts secret-like values in details", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const out = formatDoctorReport(
      mk({ checks: [{ id: "x", label: "State directory", status: "fail", detail: `bad ${token}`, remediation: "fix" }] }),
    );
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });
});
