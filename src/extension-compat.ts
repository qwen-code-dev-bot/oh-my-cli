// Extension compatibility: a single read-only, pre-run verdict across the
// versioned extension contracts. The provider (provider-contract.ts), tool
// (tool-contract.ts), MCP (mcp-contract.ts), and workflow (workflow-contract.ts)
// contracts each negotiate their own version and fail closed at the moment of
// use (discovery, invocation, or run) when a settings file declares an
// unsupported one. This module publishes (a) the supported contract-version
// matrix THIS build accepts — sourced from the existing
// SUPPORTED_*_CONTRACT_VERSIONS constants, no new source of truth — and (b) a
// proactive, machine-readable compatibility verdict for a settings file BEFORE
// an unattended run, so a fleet or CI system can check up front instead of
// triggering a fail-closed error mid-run. It is the "compatibility/versioning"
// stage of the secure-extensibility roadmap (Issue #34).
//
// Trust boundary: compatibility reads only the user-owned settings file (or an
// explicit path), never a project-local file — the same trust boundary as
// extension discovery (extension-discovery.ts). It answers the version question
// only: it reads each section's declared `contractVersion` and compares it to
// the supported range. It does NOT re-validate the full contract structure or
// re-probe readiness (that is discovery's job), and it never executes, invokes,
// or connects to any extension. An unsupported version is reported as a VERDICT
// (exit 0, an audit not a gate); only a malformed settings ROOT (invalid JSON or
// a non-object) fails closed (exit 2), matching the settings-level guarantee of
// discovery. Because the surface reads only `contractVersion` — never entry ids,
// arguments, or secret values — no secret is ever printed; only the home path is
// collapsed.

import fs from "node:fs";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath } from "./permission-impact.js";
import { PROVIDER_CONTRACT_SCHEMA, SUPPORTED_PROVIDER_CONTRACT_VERSIONS } from "./provider-contract.js";
import { TOOL_CONTRACT_SCHEMA, SUPPORTED_TOOL_CONTRACT_VERSIONS } from "./tool-contract.js";
import { MCP_CONTRACT_SCHEMA, SUPPORTED_MCP_CONTRACT_VERSIONS } from "./mcp-contract.js";
import {
  WORKFLOW_CONTRACT_SCHEMA,
  SUPPORTED_WORKFLOW_CONTRACT_VERSIONS,
} from "./workflow-contract.js";

export const EXTENSION_COMPAT_SCHEMA = "oh-my-cli.extension-compat";
export const EXTENSION_COMPAT_VERSION = 1;

// The four extension surface kinds, in the order the roadmap presents them.
export type ExtensionSurfaceKind = "provider" | "tool" | "mcp" | "workflow";

// A per-surface compatibility verdict:
// - "compatible":   the section declares a contract version within the supported
//                    range.
// - "incompatible": the section declares a version outside the supported range
//                    (or no valid integer version at all) — reported as
//                    information, never coerced.
// - "absent":        the section is not declared.
export type CompatVerdict = "compatible" | "incompatible" | "absent";

// One surface in the supported-version matrix and the per-file verdict. The
// matrix portion (kind, schema, supportedVersions) is settings-independent and
// describes what THIS build accepts; the verdict portion (present,
// declaredVersion, verdict, reason) describes the settings file. `declaredVersion`
// is the integer the section declares, or null when the section is absent or does
// not declare a valid integer version.
export interface CompatSurface {
  kind: ExtensionSurfaceKind;
  schema: string;
  supportedVersions: number[];
  present: boolean;
  declaredVersion: number | null;
  verdict: CompatVerdict;
  reason: string;
}

// The redacted, serializable compatibility report: the settings source plus the
// provider, tool, MCP, and workflow surfaces (always all present in the array).
export interface ExtensionCompatReport {
  schema: string;
  version: number;
  settings: string;
  settingsFound: boolean;
  surfaces: CompatSurface[];
}

// The static descriptor for each surface: its schema id, the supported
// contract-version range (sourced directly from the contract constants so it
// cannot drift from what the parsers enforce), and the settings root key the
// section is declared under.
interface SurfaceDescriptor {
  kind: ExtensionSurfaceKind;
  schema: string;
  supportedVersions: readonly number[];
  sectionKey: string;
}

const SURFACE_DESCRIPTORS: readonly SurfaceDescriptor[] = [
  {
    kind: "provider",
    schema: PROVIDER_CONTRACT_SCHEMA,
    supportedVersions: SUPPORTED_PROVIDER_CONTRACT_VERSIONS,
    sectionKey: "providers",
  },
  {
    kind: "tool",
    schema: TOOL_CONTRACT_SCHEMA,
    supportedVersions: SUPPORTED_TOOL_CONTRACT_VERSIONS,
    sectionKey: "tools",
  },
  {
    kind: "mcp",
    schema: MCP_CONTRACT_SCHEMA,
    supportedVersions: SUPPORTED_MCP_CONTRACT_VERSIONS,
    sectionKey: "mcp",
  },
  {
    kind: "workflow",
    schema: WORKFLOW_CONTRACT_SCHEMA,
    supportedVersions: SUPPORTED_WORKFLOW_CONTRACT_VERSIONS,
    sectionKey: "workflows",
  },
];

interface SettingsRoot {
  found: boolean;
  root?: Record<string, unknown>;
}

// Read and return the settings root object. Throws a redacted, actionable error
// on invalid JSON or a non-object root (fail closed) — before any verdict is
// computed. A missing file is not an error here: compatibility then reports
// every surface as absent.
function readSettingsRoot(settingsPath: string): SettingsRoot {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return { found: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} contains invalid JSON`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} must contain a JSON object`);
  }
  return { found: true, root: parsed as Record<string, unknown> };
}

// Determine the compatibility verdict for a present section by reading only its
// declared `contractVersion`. A valid integer within the supported range is
// "compatible"; anything else (out-of-range integer, missing version, non-integer
// version, or a non-object section) is "incompatible" — reported as information,
// never coerced and never thrown. Only valid integer versions are echoed back in
// `declaredVersion`, so no arbitrary untrusted value is reflected.
function verdictForSection(
  section: unknown,
  supported: readonly number[],
): { declaredVersion: number | null; verdict: CompatVerdict; reason: string } {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    return { declaredVersion: null, verdict: "incompatible", reason: "section is not an object" };
  }
  const version = (section as Record<string, unknown>).contractVersion;
  if (version === undefined) {
    return { declaredVersion: null, verdict: "incompatible", reason: "contractVersion is missing" };
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      declaredVersion: null,
      verdict: "incompatible",
      reason: "contractVersion is not an integer",
    };
  }
  if (supported.includes(version)) {
    return {
      declaredVersion: version,
      verdict: "compatible",
      reason: `declared version ${version} is supported`,
    };
  }
  return {
    declaredVersion: version,
    verdict: "incompatible",
    reason: `declared version ${version} is outside the supported range`,
  };
}

function absentSurface(descriptor: SurfaceDescriptor): CompatSurface {
  return {
    kind: descriptor.kind,
    schema: descriptor.schema,
    supportedVersions: [...descriptor.supportedVersions],
    present: false,
    declaredVersion: null,
    verdict: "absent",
    reason: "section not declared",
  };
}

// The supported contract-version matrix THIS build accepts, independent of any
// settings file. Sourced directly from the SUPPORTED_*_CONTRACT_VERSIONS
// constants (single source of truth), so it cannot drift from what the parsers
// enforce. Useful for consumers that want to know the supported ranges without a
// settings file to check.
export function supportedExtensionContractVersions(): CompatSurface[] {
  return SURFACE_DESCRIPTORS.map((descriptor) => absentSurface(descriptor));
}

// Compute the per-surface compatibility verdicts for the user settings file.
// Reads only the user-owned scope (resolveSettingsPath never resolves a
// project-local path) and only each section's declared `contractVersion`. A
// present section is reported as compatible or incompatible; an absent section
// is reported as absent; a missing settings file reports every surface absent and
// is not an error. Throws a redacted error only on a malformed settings root
// (invalid JSON or a non-object), which the caller surfaces as a fail-closed exit.
export function collectExtensionCompat(
  opts: { settingsPath?: string } = {},
): ExtensionCompatReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, root } = readSettingsRoot(settingsPath);

  if (!found || root === undefined) {
    return {
      schema: EXTENSION_COMPAT_SCHEMA,
      version: EXTENSION_COMPAT_VERSION,
      settings: `${redactHomePath(settingsPath)} (not found)`,
      settingsFound: false,
      surfaces: SURFACE_DESCRIPTORS.map(absentSurface),
    };
  }

  const surfaces = SURFACE_DESCRIPTORS.map((descriptor): CompatSurface => {
    const section = root[descriptor.sectionKey];
    if (section === undefined) {
      return absentSurface(descriptor);
    }
    const { declaredVersion, verdict, reason } = verdictForSection(
      section,
      descriptor.supportedVersions,
    );
    return {
      kind: descriptor.kind,
      schema: descriptor.schema,
      supportedVersions: [...descriptor.supportedVersions],
      present: true,
      declaredVersion,
      verdict,
      reason,
    };
  });

  return {
    schema: EXTENSION_COMPAT_SCHEMA,
    version: EXTENSION_COMPAT_VERSION,
    settings: redactHomePath(settingsPath),
    settingsFound: true,
    surfaces,
  };
}

// Render a supported-version range as a compact string. A single version renders
// as itself (e.g. "1"); a contiguous span renders as "min–max". The list is the
// source of truth, so a non-contiguous range is rendered explicitly.
function formatVersionRange(versions: readonly number[]): string {
  if (versions.length === 0) return "(none)";
  const sorted = [...versions].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) return `${min}`;
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  return contiguous ? `${min}–${max}` : sorted.join(", ");
}

const SURFACE_LABELS: Record<ExtensionSurfaceKind, string> = {
  provider: "Provider contract",
  tool: "Tool contract",
  mcp: "MCP contract",
  workflow: "Workflow contract",
};

// A redacted, human-readable compatibility report. The home path is collapsed;
// the surface reads only `contractVersion`, so no entry id, argument, or secret
// value is ever printed.
export function formatExtensionCompat(report: ExtensionCompatReport): string {
  const lines: string[] = [
    "Extension Compatibility",
    "─".repeat(40),
    `Settings:  ${report.settings}`,
    `Schema:    ${report.schema} v${report.version}`,
  ];
  for (const surface of report.surfaces) {
    lines.push("");
    lines.push(`${SURFACE_LABELS[surface.kind]}: ${surface.verdict}`);
    lines.push(`  Schema:    ${surface.schema}`);
    lines.push(`  Supported: ${formatVersionRange(surface.supportedVersions)}`);
    lines.push(
      `  Declared:  ${
        surface.present ? (surface.declaredVersion !== null ? surface.declaredVersion : "(invalid)") : "(not declared)"
      }`,
    );
    lines.push(`  Reason:    ${surface.reason}`);
  }
  return lines.join("\n");
}
