// Extension discovery: a single read-only view across the versioned extension
// contracts. Now that providers (provider-contract.ts), tools
// (tool-contract.ts), and MCP servers (mcp-contract.ts) are declared through
// their own contracts, this module composes those resolvers into one redacted
// report of which extension surfaces are declared and ready — without re-probing
// every integration (health-inventory.ts) and without changing core code. It is
// the "discovery" stage of the secure-extensibility roadmap (Issue #34).
//
// Trust boundary: discovery reads only the user-owned settings file (or an
// explicit path), never a project-local file. It composes the existing contract
// parsers, so the same fail-closed guarantees apply: an unsupported contract
// version, a raw credential field, or a malformed section raises a redacted
// error rather than being coerced. A surface with no declared section is reported
// as absent (not an error). No secret value, argument value, or remote response
// body is ever printed; only counts, ids, negotiated versions, and lifecycle
// state appear.

import fs from "node:fs";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { PROVIDER_CONTRACT_SCHEMA, parseProviderContract } from "./provider-contract.js";
import type { ProviderContract } from "./provider-contract.js";
import { MCP_CONTRACT_SCHEMA, parseMcpContract, resolveMcpLifecycle } from "./mcp-contract.js";
import type { McpContract, McpLifecycleState } from "./mcp-contract.js";
import { TOOL_CONTRACT_SCHEMA, parseToolContract, resolveToolReadiness } from "./tool-contract.js";
import type { ToolContract, ToolReadinessState } from "./tool-contract.js";

export const EXTENSION_DISCOVERY_SCHEMA = "oh-my-cli.extension-discovery";
export const EXTENSION_DISCOVERY_VERSION = 1;

// One discovered extension surface. An absent surface carries only `kind` and
// `present: false`. A present surface reports its negotiated contract version,
// declared entry count, and default/selected entry id; the MCP and tool surfaces
// also report the selected entry's lifecycle/readiness state (composed from
// mcp-contract.ts and tool-contract.ts respectively).
export interface DiscoverySurface {
  kind: "provider" | "mcp" | "tool";
  present: boolean;
  schema?: string;
  contractVersion?: number;
  entryCount?: number;
  default?: string | null;
  selectedId?: string | null;
  state?: McpLifecycleState | ToolReadinessState | null;
  stateReason?: string | null;
  probeMs?: number | null;
}

// The redacted, serializable discovery report: the settings source plus the
// provider and MCP surfaces (always both present in the array, each flagged
// present/absent).
export interface ExtensionDiscoveryReport {
  schema: string;
  version: number;
  settings: string;
  settingsFound: boolean;
  surfaces: DiscoverySurface[];
}

interface SettingsRoot {
  found: boolean;
  root?: Record<string, unknown>;
}

// Read and return the settings root object. Throws a redacted, actionable error
// on invalid JSON or a non-object root (fail closed) — before any contract is
// resolved. A missing file is not an error here: discovery then reports every
// surface as absent.
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

// The entry a consumer would select without an explicit id: the declared default,
// then the sole entry. Multiple entries with no default are ambiguous, so no
// selection is reported (the consumer must choose explicitly).
function selectedEntryId(contract: { default?: string; entries: { id: string }[] }): string | null {
  if (contract.default !== undefined) return contract.default;
  if (contract.entries.length === 1) return contract.entries[0].id;
  return null;
}

function buildProviderSurface(contract: ProviderContract): DiscoverySurface {
  return {
    kind: "provider",
    present: true,
    schema: PROVIDER_CONTRACT_SCHEMA,
    contractVersion: contract.contractVersion,
    entryCount: contract.entries.length,
    default: contract.default ?? null,
    selectedId: selectedEntryId(contract),
  };
}

function buildMcpSurface(contract: McpContract, probe: boolean): DiscoverySurface {
  const selectedId = selectedEntryId(contract);
  const surface: DiscoverySurface = {
    kind: "mcp",
    present: true,
    schema: MCP_CONTRACT_SCHEMA,
    contractVersion: contract.contractVersion,
    entryCount: contract.entries.length,
    default: contract.default ?? null,
    selectedId,
    state: null,
    stateReason: null,
    probeMs: null,
  };
  if (selectedId !== null) {
    const entry = contract.entries.find((e) => e.id === selectedId);
    if (entry) {
      const lifecycle = resolveMcpLifecycle(entry, { probe });
      surface.state = lifecycle.state;
      surface.stateReason = lifecycle.reason;
      surface.probeMs = lifecycle.probeMs;
    }
  }
  return surface;
}

function buildToolSurface(contract: ToolContract, probe: boolean): DiscoverySurface {
  const selectedId = selectedEntryId(contract);
  const surface: DiscoverySurface = {
    kind: "tool",
    present: true,
    schema: TOOL_CONTRACT_SCHEMA,
    contractVersion: contract.contractVersion,
    entryCount: contract.entries.length,
    default: contract.default ?? null,
    selectedId,
    state: null,
    stateReason: null,
    probeMs: null,
  };
  if (selectedId !== null) {
    const entry = contract.entries.find((e) => e.id === selectedId);
    if (entry) {
      const readiness = resolveToolReadiness(entry, { probe });
      surface.state = readiness.state;
      surface.stateReason = readiness.reason;
      surface.probeMs = readiness.probeMs;
    }
  }
  return surface;
}

// Discover the declared extension surfaces from the user settings file. Composes
// the provider (#118), MCP (#120), and tool (#135) contract parsers: a present
// section is validated (fail closed on an invalid contract) and summarized; an
// absent section is reported as absent. A missing settings file reports every
// surface absent and is not an error. `probe: false` reports the MCP and tool
// selected entries as `declared` without probing.
export function collectExtensionDiscovery(
  opts: { settingsPath?: string; probe?: boolean } = {},
): ExtensionDiscoveryReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const probe = opts.probe ?? true;
  const { found, root } = readSettingsRoot(settingsPath);

  if (!found || root === undefined) {
    return {
      schema: EXTENSION_DISCOVERY_SCHEMA,
      version: EXTENSION_DISCOVERY_VERSION,
      settings: `${redactHomePath(settingsPath)} (not found)`,
      settingsFound: false,
      surfaces: [
        { kind: "provider", present: false },
        { kind: "mcp", present: false },
        { kind: "tool", present: false },
      ],
    };
  }

  const provider =
    root.providers !== undefined
      ? buildProviderSurface(parseProviderContract(root.providers))
      : { kind: "provider" as const, present: false };
  const mcp =
    root.mcp !== undefined
      ? buildMcpSurface(parseMcpContract(root.mcp), probe)
      : { kind: "mcp" as const, present: false };
  const tool =
    root.tools !== undefined
      ? buildToolSurface(parseToolContract(root.tools), probe)
      : { kind: "tool" as const, present: false };

  return {
    schema: EXTENSION_DISCOVERY_SCHEMA,
    version: EXTENSION_DISCOVERY_VERSION,
    settings: redactHomePath(settingsPath),
    settingsFound: true,
    surfaces: [provider, mcp, tool],
  };
}

// A redacted, human-readable discovery summary. Entry ids are passed through
// secret redaction defensively; no secret, argument value, or remote response
// body is ever printed.
export function formatExtensionDiscovery(report: ExtensionDiscoveryReport): string {
  const lines: string[] = [
    "Extension Discovery",
    "─".repeat(40),
    `Settings:  ${report.settings}`,
    `Schema:    ${report.schema} v${report.version}`,
  ];
  for (const surface of report.surfaces) {
    lines.push("");
    const label =
      surface.kind === "provider"
        ? "Provider contract"
        : surface.kind === "mcp"
          ? "MCP contract"
          : "Tool contract";
    if (!surface.present) {
      lines.push(`${label}: not declared`);
      continue;
    }
    lines.push(
      `${label}: ${surface.entryCount} entr${surface.entryCount === 1 ? "y" : "ies"} ` +
        `(contract version ${surface.contractVersion})`,
    );
    lines.push(`  Default:  ${surface.default ? redactSecrets(surface.default).text : "(none)"}`);
    lines.push(
      `  Selected: ${
        surface.selectedId ? redactSecrets(surface.selectedId).text : "(ambiguous — set a default)"
      }`,
    );
    if ((surface.kind === "mcp" || surface.kind === "tool") && surface.state) {
      lines.push(`  State:    ${surface.state} [${redactSecrets(surface.stateReason ?? "").text}]`);
    }
  }
  return lines.join("\n");
}
