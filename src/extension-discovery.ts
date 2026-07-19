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
import {
  WORKFLOW_CONTRACT_SCHEMA,
  parseWorkflowContract,
  resolveWorkflowReadiness,
} from "./workflow-contract.js";
import type { WorkflowContract, WorkflowReadinessState } from "./workflow-contract.js";

export const EXTENSION_DISCOVERY_SCHEMA = "oh-my-cli.extension-discovery";
export const EXTENSION_DISCOVERY_VERSION = 1;

// One discovered extension surface. An absent surface carries only `kind` and
// `present: false`. A present surface reports its negotiated contract version,
// declared entry count, and default/selected entry id; the MCP and tool surfaces
// also report the selected entry's lifecycle/readiness state (composed from
// mcp-contract.ts and tool-contract.ts respectively). The workflow surface reports
// the contract-level readiness (workflow-contract.ts): a workflow has no external
// entrypoint and no implicit selection, so it carries no default/selected id and
// is "ready" whenever the contract negotiates and validates.
export interface DiscoverySurface {
  kind: "provider" | "mcp" | "tool" | "workflow";
  present: boolean;
  schema?: string;
  contractVersion?: number;
  entryCount?: number;
  default?: string | null;
  selectedId?: string | null;
  state?: McpLifecycleState | ToolReadinessState | WorkflowReadinessState | null;
  stateReason?: string | null;
  probeMs?: number | null;
}

// The redacted, serializable discovery report: the settings source plus the
// provider, MCP, tool, and workflow surfaces (always all present in the array,
// each flagged present/absent).
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

// A workflow has no default and no external entrypoint to probe: it is selected by
// explicit name at run time, and a contract that negotiates and validates is
// immediately resolvable by the runner. The surface therefore reports the contract
// version, definition count, and contract-level readiness ("ready") — no
// default/selected id and no probe timing. `probe` is intentionally ignored.
function buildWorkflowSurface(contract: WorkflowContract): DiscoverySurface {
  const readiness = resolveWorkflowReadiness(contract);
  return {
    kind: "workflow",
    present: true,
    schema: WORKFLOW_CONTRACT_SCHEMA,
    contractVersion: contract.contractVersion,
    entryCount: contract.definitions.length,
    default: null,
    selectedId: null,
    state: readiness.state,
    stateReason: readiness.reason,
    probeMs: null,
  };
}

// Discover the declared extension surfaces from the user settings file. Composes
// the provider (#118), MCP (#120), tool (#135), and workflow (#143) contract
// parsers: a present section is validated (fail closed on an invalid contract)
// and summarized; an absent section is reported as absent. A missing settings
// file reports every surface absent and is not an error. `probe: false` reports
// the MCP and tool selected entries as `declared` without probing (the workflow
// surface is always resolved, since it has nothing to probe).
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
        { kind: "workflow", present: false },
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
  const workflow =
    root.workflows !== undefined
      ? buildWorkflowSurface(parseWorkflowContract(root.workflows))
      : { kind: "workflow" as const, present: false };

  return {
    schema: EXTENSION_DISCOVERY_SCHEMA,
    version: EXTENSION_DISCOVERY_VERSION,
    settings: redactHomePath(settingsPath),
    settingsFound: true,
    surfaces: [provider, mcp, tool, workflow],
  };
}

// A redacted, human-readable discovery summary. Entry ids are passed through
// secret redaction defensively; no secret, argument value, or remote response
// body is ever printed.
export function formatExtensionDiscovery(report: ExtensionDiscoveryReport): string {
  const labels: Record<DiscoverySurface["kind"], string> = {
    provider: "Provider contract",
    mcp: "MCP contract",
    tool: "Tool contract",
    workflow: "Workflow contract",
  };
  const lines: string[] = [
    "Extension Discovery",
    "─".repeat(40),
    `Settings:  ${report.settings}`,
    `Schema:    ${report.schema} v${report.version}`,
  ];
  for (const surface of report.surfaces) {
    lines.push("");
    const label = labels[surface.kind];
    if (!surface.present) {
      lines.push(`${label}: not declared`);
      continue;
    }
    const count = surface.entryCount ?? 0;
    const entries =
      surface.kind === "workflow"
        ? `${count} definition${count === 1 ? "" : "s"}`
        : `${count} entr${count === 1 ? "y" : "ies"}`;
    lines.push(`${label}: ${entries} (contract version ${surface.contractVersion})`);
    // Workflows are selected by explicit name at run time: they carry no default
    // and no implicit selection, so only the provider/MCP/tool surfaces report one.
    if (surface.kind !== "workflow") {
      lines.push(`  Default:  ${surface.default ? redactSecrets(surface.default).text : "(none)"}`);
      lines.push(
        `  Selected: ${
          surface.selectedId ? redactSecrets(surface.selectedId).text : "(ambiguous — set a default)"
        }`,
      );
    }
    if (
      (surface.kind === "mcp" || surface.kind === "tool" || surface.kind === "workflow") &&
      surface.state
    ) {
      lines.push(`  State:    ${surface.state} [${redactSecrets(surface.stateReason ?? "").text}]`);
    }
  }
  return lines.join("\n");
}
