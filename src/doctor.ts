// Read-only installation and platform readiness checks.
//
// Surfaces problems that otherwise only appear mid-task: an unsupported Node
// runtime, a missing CLI build, an unwritable state directory, or an untested
// platform. Every check is non-mutating — it never installs, creates, or edits
// anything — and results are redacted so credentials and host paths stay out of
// the output. Each check is a pure function so platform/permission fixtures for
// Linux, macOS, and Windows can be exercised without running on all three.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./permission-impact.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when no check failed (warnings are tolerated). */
  ok: boolean;
}

const MIN_NODE_MAJOR = 22;
const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;

const SYMBOLS: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗" };

export function normalizePlatform(platform: string): string {
  switch (platform) {
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return platform || "unknown";
  }
}

export function isSupportedPlatform(platform: string, supported: readonly string[] = SUPPORTED_PLATFORMS): boolean {
  return supported.includes(platform);
}

function parseMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

export function checkNodeVersion(version: string, minMajor: number = MIN_NODE_MAJOR): DoctorCheck {
  const id = "node-version";
  const label = "Node runtime";
  const major = parseMajor(version);
  if (major === null) {
    return {
      id,
      label,
      status: "warn",
      detail: `unrecognized version "${version}"`,
      remediation: `Use Node.js v${minMajor} or newer.`,
    };
  }
  if (major >= minMajor) {
    return { id, label, status: "pass", detail: `${version} (>= ${minMajor})` };
  }
  return {
    id,
    label,
    status: "fail",
    detail: `${version} (< ${minMajor})`,
    remediation: `Upgrade Node.js to v${minMajor} or newer.`,
  };
}

export function checkCliResolution(
  entryPath: string,
  exists: (p: string) => boolean = defaultExists,
): DoctorCheck {
  const id = "cli-resolution";
  const label = "CLI entry";
  const shown = redactPath(entryPath);
  if (exists(entryPath)) {
    return { id, label, status: "pass", detail: shown };
  }
  return {
    id,
    label,
    status: "fail",
    detail: `${shown} not found`,
    remediation: "Run 'npm run build' to compile the CLI, or reinstall the package.",
  };
}

export interface StateProbe {
  home: string | null;
  exists?: (p: string) => boolean;
  isWritable?: (p: string) => boolean;
}

export function checkStateDirectory(baseDir: string, probe: StateProbe): DoctorCheck {
  const id = "state-directory";
  const label = "State directory";
  const shown = redactPath(baseDir);
  const exists = probe.exists ?? defaultExists;
  const isWritable = probe.isWritable ?? defaultWritable;

  if (!probe.home) {
    return {
      id,
      label,
      status: "fail",
      detail: "HOME not set; state directory location unknown",
      remediation: "Set HOME (or USERPROFILE) to a writable location.",
    };
  }
  if (exists(baseDir)) {
    if (isWritable(baseDir)) {
      return { id, label, status: "pass", detail: `${shown} (writable)` };
    }
    return {
      id,
      label,
      status: "fail",
      detail: `${shown} not writable`,
      remediation: `Ensure ${shown} is writable.`,
    };
  }
  const parent = path.dirname(baseDir);
  if (isWritable(parent)) {
    return { id, label, status: "pass", detail: `${shown} (creatable)` };
  }
  return {
    id,
    label,
    status: "fail",
    detail: `${redactPath(parent)} not writable`,
    remediation: `Ensure ${redactPath(parent)} is writable so ${shown} can be created.`,
  };
}

export function checkPlatformSupport(
  platform: string,
  supported: readonly string[] = SUPPORTED_PLATFORMS,
): DoctorCheck {
  const id = "platform-support";
  const label = "Platform";
  const name = normalizePlatform(platform);
  if (isSupportedPlatform(platform, supported)) {
    return { id, label, status: "pass", detail: name };
  }
  return {
    id,
    label,
    status: "warn",
    detail: `${name} (untested)`,
    remediation: `Supported platforms: ${supported.map(normalizePlatform).join(", ")}.`,
  };
}

export interface DoctorOptions {
  nodeVersion?: string;
  minNodeMajor?: number;
  entryPath?: string;
  stateBaseDir?: string;
  home?: string | null;
  platform?: string;
}

export function collectDoctorReport(opts: DoctorOptions = {}): DoctorReport {
  const nodeVersion = opts.nodeVersion ?? process.version;
  const minNodeMajor = opts.minNodeMajor ?? MIN_NODE_MAJOR;
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? null;
  const entryPath = opts.entryPath ?? defaultEntryPath();
  const stateBaseDir = opts.stateBaseDir ?? (home ? path.join(home, ".oh-my-cli") : ".oh-my-cli");
  const platform = opts.platform ?? process.platform;

  const checks: DoctorCheck[] = [
    checkNodeVersion(nodeVersion, minNodeMajor),
    checkCliResolution(entryPath),
    checkStateDirectory(stateBaseDir, { home }),
    checkPlatformSupport(platform),
  ];

  const ok = checks.every((c) => c.status !== "fail");
  return { checks, ok };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("Doctor");
  lines.push("─".repeat(40));
  for (const c of report.checks) {
    const detail = redactSecrets(c.detail).text;
    lines.push(`${SYMBOLS[c.status]} ${c.label.padEnd(16)} ${detail}`);
    if (c.status !== "pass" && c.remediation) {
      lines.push(`    → ${redactSecrets(c.remediation).text}`);
    }
  }

  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of report.checks) counts[c.status]++;
  lines.push("");
  lines.push(`Summary: ${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed`);

  return lines.join("\n");
}

function defaultEntryPath(): string {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  } catch {
    return path.resolve("dist", "index.js");
  }
}

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function defaultWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function redactPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
