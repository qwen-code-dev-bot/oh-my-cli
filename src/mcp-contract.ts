// MCP server extension contract: declare one or more MCP servers as a versioned
// section of the unified user settings file (settings.ts), then negotiate the
// contract version, deterministically select one server, and resolve its
// lifecycle state (declared / ready / isolated) with safe failure defaults — all
// without changing core code. This is the MCP-lifecycle slice of the secure-
// extensibility roadmap (Issue #34), complementing the provider extension
// contract (provider-contract.ts) and the bounded health inventory
// (health-inventory.ts).
//
// Distinct from the health inventory: health-inventory.ts lists *every*
// configured integration with a health category (a read-only snapshot of the
// loose `mcpServers` map). This module governs *one* selected server through a
// versioned contract — declaration, version negotiation, deterministic
// selection, and a lifecycle state machine — so the core and automation can
// depend on a managed MCP server without forking or weakening safety.
//
// Trust boundary: MCP server definitions are untrusted input. The same
// user-owned settings file backs the model section (settings.ts), the provider
// contract (provider-contract.ts), and the health inventory; project-local files
// are never discovered automatically. This slice is limited to safe local/stdio
// transport — a stdio server's command is resolved on PATH but never executed,
// so probing cannot run arbitrary code. Remote (http/sse) transports are refused
// (fail closed) in contract version 1. Raw credential fields inside a server
// entry are rejected rather than ignored, and an unsupported contract version
// fails closed instead of being silently coerced. A server that is disabled,
// misconfigured, or whose command is unavailable resolves to `isolated` and
// never crashes the run.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";

export const MCP_CONTRACT_SCHEMA = "oh-my-cli.mcp-contract";
export const MCP_CONTRACT_VERSION = 1;

// The contract versions this build can negotiate. A settings file declaring a
// version outside this range is refused (fail closed) rather than coerced, so a
// future format change cannot silently reinterpret an older or newer definition.
export const SUPPORTED_MCP_CONTRACT_VERSIONS: readonly number[] = [1];

// Raw secret field names that must never appear in a server entry. The parser
// rejects (rather than ignores) them so a plaintext secret cannot become a
// supported configuration path that users are encouraged to commit.
const FORBIDDEN_MCP_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// Bounded probe window (milliseconds) for resolving a stdio command. Mirrors the
// health inventory so a lifecycle probe never hangs the run.
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const MIN_PROBE_TIMEOUT_MS = 50;
const MAX_PROBE_TIMEOUT_MS = 30000;

// Bounded, optional capability flags. Unknown flags are ignored (forward
// compatible within a contract version); these are advisory metadata only and
// never widen the trust boundary.
export interface McpCapabilityFlags {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
}

// The lifecycle state of a selected server:
//   declared  — valid contract entry, lifecycle not yet probed.
//   ready     — probed; the declared command is resolvable and safe to start.
//   isolated  — safe failure default: disabled, misconfigured, command missing,
//               or the probe exceeded its bound. The core must skip it, never
//               crash, and never bypass approvals/confinement/redaction.
export type McpLifecycleState = "declared" | "ready" | "isolated";

// One declared MCP server. Only safe local/stdio transport is supported in
// contract version 1: `command` is resolved on PATH but never executed.
export interface McpServerEntry {
  id: string;
  transport?: "stdio";
  command: string;
  args?: string[];
  enabled?: boolean;
  probeTimeoutMs?: number;
  capabilities?: McpCapabilityFlags;
}

// The validated `mcp` section: a negotiated contract version, an optional
// default server id, and the validated entries (ids guaranteed unique).
export interface McpContract {
  contractVersion: number;
  default?: string;
  entries: McpServerEntry[];
}

const CapabilitySchema = z
  .object({
    tools: z.boolean().optional(),
    resources: z.boolean().optional(),
    prompts: z.boolean().optional(),
  })
  .optional();

const McpServerEntrySchema = z.object({
  id: z.string().min(1, "mcp.entries[].id must be a non-empty string"),
  transport: z.literal("stdio").optional(),
  command: z.string().min(1, "mcp.entries[].command is required"),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  probeTimeoutMs: z
    .number({ invalid_type_error: "mcp.entries[].probeTimeoutMs must be a number" })
    .int()
    .min(MIN_PROBE_TIMEOUT_MS, `mcp.entries[].probeTimeoutMs must be >= ${MIN_PROBE_TIMEOUT_MS}`)
    .max(MAX_PROBE_TIMEOUT_MS, `mcp.entries[].probeTimeoutMs must be <= ${MAX_PROBE_TIMEOUT_MS}`)
    .optional(),
  capabilities: CapabilitySchema,
});

function clampProbeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.floor(value)));
}

interface McpSection {
  found: boolean;
  section?: unknown;
}

// Read and return only the optional `mcp` section of the settings file. Throws a
// redacted, actionable error on invalid JSON or a non-object root — before any
// probe. A missing file or absent `mcp` section is not an error here; the caller
// decides how to treat that.
function readMcpSection(settingsPath: string): McpSection {
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

  const root = parsed as Record<string, unknown>;
  const mcp = root.mcp;
  if (mcp === undefined) {
    return { found: true };
  }
  return { found: true, section: mcp };
}

// Validate an untrusted `mcp` section into an McpContract. Negotiates the
// contract version (fail closed on an unsupported version), rejects raw
// credential fields per entry, refuses non-stdio transports in this slice,
// enforces unique ids, and validates that any declared default references a
// defined entry. Every failure raises a redacted, deterministic error.
export function parseMcpContract(section: unknown): McpContract {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.mcp must be an object");
  }
  const obj = section as Record<string, unknown>;

  // Version negotiation: a required integer within the supported range.
  const version = obj.contractVersion;
  if (version === undefined) {
    throw new Error("Settings error: settings.mcp.contractVersion is required");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Settings error: settings.mcp.contractVersion must be an integer");
  }
  if (!SUPPORTED_MCP_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `Settings error: mcp contract version ${version} is not supported; ` +
        `supported versions: ${SUPPORTED_MCP_CONTRACT_VERSIONS.join(", ")}`,
    );
  }

  let def: string | undefined;
  if (obj.default !== undefined) {
    if (typeof obj.default !== "string" || obj.default.trim() === "") {
      throw new Error("Settings error: settings.mcp.default must be a non-empty string");
    }
    def = obj.default;
  }

  const rawEntries = obj.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error("Settings error: settings.mcp.entries must be a non-empty array");
  }

  const entries: McpServerEntry[] = [];
  const seen = new Set<string>();
  rawEntries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Settings error: settings.mcp.entries[${index}] must be an object`);
    }
    const entryObj = entry as Record<string, unknown>;
    const label =
      typeof entryObj.id === "string" && entryObj.id ? `"${entryObj.id}"` : `[${index}]`;
    for (const forbidden of FORBIDDEN_MCP_KEYS) {
      if (forbidden in entryObj) {
        throw new Error(
          `Settings error: mcp server ${label} field "${forbidden}" is a raw credential field; ` +
            "do not inline secrets in an MCP server definition",
        );
      }
    }
    // This slice is limited to safe local/stdio transport. Refuse remote
    // transports (fail closed) rather than silently dropping them.
    if (
      entryObj.url !== undefined ||
      (entryObj.transport !== undefined && entryObj.transport !== "stdio")
    ) {
      throw new Error(
        `Settings error: mcp server ${label} declares an unsupported transport; ` +
          'only "stdio" is allowed in contract version 1',
      );
    }
    const result = McpServerEntrySchema.safeParse(entryObj);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: ${issues}`);
    }
    if (seen.has(result.data.id)) {
      throw new Error(`Settings error: duplicate mcp server id "${result.data.id}"`);
    }
    seen.add(result.data.id);
    entries.push(result.data);
  });

  if (def !== undefined && !seen.has(def)) {
    throw new Error(`Settings error: settings.mcp.default "${def}" is not a defined mcp server id`);
  }

  return { contractVersion: version, default: def, entries };
}

// Deterministically select one server entry: an explicit id wins, then the
// declared default, then the sole entry. Ambiguity (multiple entries, no id, no
// default) and unknown ids fail closed with a clear reason.
export function selectMcpServer(
  contract: McpContract,
  opts: { serverId?: string } = {},
): McpServerEntry {
  const wanted = opts.serverId && opts.serverId.trim() ? opts.serverId.trim() : undefined;
  if (wanted !== undefined) {
    const found = contract.entries.find((e) => e.id === wanted);
    if (!found) {
      throw new Error(`MCP error: server "${wanted}" is not defined in settings.mcp`);
    }
    return found;
  }
  if (contract.default !== undefined) {
    const found = contract.entries.find((e) => e.id === contract.default);
    if (!found) {
      throw new Error(
        `MCP error: default server "${contract.default}" is not defined in settings.mcp`,
      );
    }
    return found;
  }
  if (contract.entries.length === 1) {
    return contract.entries[0];
  }
  throw new Error(
    "MCP error: multiple servers defined; select one via --server <id> or settings.mcp.default",
  );
}

// The outcome of a bounded lifecycle probe for one server.
export interface McpLifecycle {
  state: McpLifecycleState;
  reason: string;
  probeMs: number | null;
}

type CommandResolution = "found" | "missing" | "timeout";

// Resolve the lifecycle state of a selected server. Never throws: a disabled,
// misconfigured, missing, or slow server resolves to `isolated` (the safe
// failure default) so the run never crashes. `probe: false` reports `declared`
// without probing. `deadline` (absolute epoch ms) bounds the probe; collectMcp-
// Contract computes it from the entry's timeout, and tests may inject a past
// deadline to exercise the timeout branch deterministically.
export function resolveMcpLifecycle(
  entry: McpServerEntry,
  opts: { probe?: boolean; deadline?: number } = {},
): McpLifecycle {
  const probe = opts.probe ?? true;
  if (!probe) {
    return { state: "declared", reason: "declared (not probed)", probeMs: null };
  }
  if (entry.enabled === false) {
    return { state: "isolated", reason: "disabled", probeMs: null };
  }
  const start = Date.now();
  const deadline = opts.deadline ?? start + clampProbeTimeout(entry.probeTimeoutMs);
  const resolution = resolveCommand(entry.command, deadline);
  const probeMs = Date.now() - start;
  switch (resolution) {
    case "found":
      return { state: "ready", reason: "command resolved", probeMs };
    case "timeout":
      return { state: "isolated", reason: "probe timed out", probeMs };
    default:
      return { state: "isolated", reason: "command not found", probeMs };
  }
}

// Resolve a command on PATH without executing it — probing must not run
// arbitrary code, only confirm the binary is available. Honors an absolute
// deadline so a pathological PATH cannot hang the probe.
function resolveCommand(command: string, deadline: number): CommandResolution {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? "found" : "missing";
  }
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"]
      : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    if (Date.now() > deadline) return "timeout";
    for (const ext of exts) {
      if (isExecutable(path.join(dir, command + ext))) return "found";
    }
  }
  return "missing";
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The redacted, serializable result of inspecting an MCP server contract. No
// secret value, no argument values (only their count), and no unredacted home
// path. The command is home-redacted; the lifecycle state and reason are safe,
// fixed strings.
export interface McpContractReport {
  schema: string;
  version: number;
  contractVersion: number;
  serverId: string;
  transport: "stdio";
  command: string;
  argCount: number;
  enabled: boolean;
  state: McpLifecycleState;
  reason: string;
  probeMs: number | null;
  probeTimeoutMs: number;
  capabilities: McpCapabilityFlags;
  settings: string;
}

// Pure builder for the redacted report from already-resolved facts.
export function buildMcpContractReport(facts: {
  contractVersion: number;
  entry: McpServerEntry;
  lifecycle: McpLifecycle;
  settingsPath: string;
  settingsFound: boolean;
}): McpContractReport {
  return {
    schema: MCP_CONTRACT_SCHEMA,
    version: MCP_CONTRACT_VERSION,
    contractVersion: facts.contractVersion,
    serverId: facts.entry.id,
    transport: "stdio",
    command: redactHomePath(facts.entry.command),
    argCount: facts.entry.args?.length ?? 0,
    enabled: facts.entry.enabled !== false,
    state: facts.lifecycle.state,
    reason: facts.lifecycle.reason,
    probeMs: facts.lifecycle.probeMs,
    probeTimeoutMs: clampProbeTimeout(facts.entry.probeTimeoutMs),
    capabilities: facts.entry.capabilities ?? {},
    settings: facts.settingsFound
      ? redactHomePath(facts.settingsPath)
      : `${redactHomePath(facts.settingsPath)} (not found)`,
  };
}

// Read the user settings file, negotiate the MCP contract, select one server,
// resolve its lifecycle state, and build the redacted report. Throws a redacted
// error when no `mcp` section exists or the contract is invalid (exit 2). A
// server that is disabled or whose command is unavailable resolves to `isolated`
// (a successful resolution, not an error) so the consumer can apply safe failure
// defaults.
export function collectMcpContract(
  opts: {
    settingsPath?: string;
    env?: Record<string, string | undefined>;
    serverId?: string;
    probe?: boolean;
  } = {},
): McpContractReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readMcpSection(settingsPath);
  if (section === undefined) {
    throw new Error(
      found
        ? "MCP error: settings file has no settings.mcp section"
        : `MCP error: settings file not found at ${redactHomePath(settingsPath)}`,
    );
  }
  const contract = parseMcpContract(section);
  const entry = selectMcpServer(contract, { serverId: opts.serverId });
  const probe = opts.probe ?? true;
  const deadline = probe ? Date.now() + clampProbeTimeout(entry.probeTimeoutMs) : undefined;
  const lifecycle = resolveMcpLifecycle(entry, { probe, deadline });
  return buildMcpContractReport({
    contractVersion: contract.contractVersion,
    entry,
    lifecycle,
    settingsPath,
    settingsFound: found,
  });
}

// A redacted, human-readable summary of the resolved MCP server contract.
export function formatMcpContract(report: McpContractReport): string {
  const capabilities = Object.entries(report.capabilities)
    .filter(([, value]) => value)
    .map(([name]) => name);
  const command = redactSecrets(report.command).text;
  const reason = redactSecrets(report.reason).text;
  const lines: Array<string | null> = [
    `Server:       ${report.serverId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Transport:    ${report.transport}`,
    `Command:      ${command}`,
    `Arguments:    ${report.argCount}`,
    `Enabled:      ${report.enabled}`,
    `State:        ${report.state} [${reason}]`,
    report.probeMs !== null
      ? `Probe:        ${report.probeMs}ms (timeout ${report.probeTimeoutMs}ms)`
      : `Probe:        skipped (timeout ${report.probeTimeoutMs}ms)`,
    capabilities.length ? `Capabilities: ${capabilities.join(", ")}` : null,
    `Settings:     ${report.settings}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}
