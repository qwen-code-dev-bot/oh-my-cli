// Tool extension contract: declare one or more external tools as a versioned
// section of the unified user settings file (settings.ts), then negotiate the
// contract version, deterministically select one tool, and resolve its readiness
// state (declared / ready / isolated) with safe failure defaults — all without
// changing core code. This is the tool member of the provider/tool/MCP contract
// triad of the secure-extensibility roadmap (Issue #34), complementing the
// provider extension contract (provider-contract.ts) and the MCP server
// extension contract (mcp-contract.ts).
//
// Distinct from the built-in tool registry (tools.ts): tools.ts defines the
// agent's own built-in capabilities (read/write/shell). This module governs an
// *external* tool declared by an operator as a managed extension — declaration,
// version negotiation, deterministic selection, and a readiness state machine —
// so the core and non-interactive automation can depend on a declared tool
// without forking the core or weakening safety. It is also distinct from the
// command trust policy (command-policy.ts), which decides whether a given
// *command* may run; this slice never executes anything, it only resolves
// whether a declared tool is reachable and safe to hand off.
//
// Trust boundary: tool definitions are untrusted input. The same user-owned
// settings file backs the model section (settings.ts), the provider contract
// (provider-contract.ts), the MCP contract (mcp-contract.ts), and the health
// inventory; project-local files are never discovered automatically. This slice
// is limited to a safe local execution kind — a `command` tool's binary is
// resolved on PATH but never executed, so probing cannot run arbitrary code.
// Remote/network tools (a `url` field or a non-`command` kind) are refused (fail
// closed) in contract version 1. Raw credential fields inside a tool entry are
// rejected rather than ignored, and an unsupported contract version fails closed
// instead of being silently coerced. A tool that is disabled, misconfigured, or
// whose command is unavailable resolves to `isolated` and never crashes the run.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";

export const TOOL_CONTRACT_SCHEMA = "oh-my-cli.tool-contract";
export const TOOL_CONTRACT_VERSION = 1;

// The contract versions this build can negotiate. A settings file declaring a
// version outside this range is refused (fail closed) rather than coerced, so a
// future format change cannot silently reinterpret an older or newer definition.
export const SUPPORTED_TOOL_CONTRACT_VERSIONS: readonly number[] = [1];

// Raw secret field names that must never appear in a tool entry. The parser
// rejects (rather than ignores) them so a plaintext secret cannot become a
// supported configuration path that users are encouraged to commit.
const FORBIDDEN_TOOL_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// Bounded probe window (milliseconds) for resolving a command. Mirrors the MCP
// contract and health inventory so a readiness probe never hangs the run.
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const MIN_PROBE_TIMEOUT_MS = 50;
const MAX_PROBE_TIMEOUT_MS = 30000;

// Bounded, optional capability/permission flags. Unknown flags are ignored
// (forward compatible within a contract version); these are advisory metadata
// only and never widen the trust boundary.
export interface ToolCapabilityFlags {
  readOnly?: boolean;
  network?: boolean;
  filesystem?: boolean;
}

// The readiness state of a selected tool:
//   declared  — valid contract entry, readiness not yet probed.
//   ready     — probed; the declared command is resolvable and safe to hand off.
//   isolated  — safe failure default: disabled, misconfigured, command missing,
//               or the probe exceeded its bound. The core must skip it, never
//               crash, and never bypass approvals/confinement/redaction.
export type ToolReadinessState = "declared" | "ready" | "isolated";

// One declared tool. Only the safe local `command` kind is supported in contract
// version 1: `command` is resolved on PATH but never executed.
export interface ToolEntry {
  id: string;
  kind?: "command";
  command: string;
  args?: string[];
  enabled?: boolean;
  probeTimeoutMs?: number;
  capabilities?: ToolCapabilityFlags;
}

// The validated `tools` section: a negotiated contract version, an optional
// default tool id, and the validated entries (ids guaranteed unique).
export interface ToolContract {
  contractVersion: number;
  default?: string;
  entries: ToolEntry[];
}

const CapabilitySchema = z
  .object({
    readOnly: z.boolean().optional(),
    network: z.boolean().optional(),
    filesystem: z.boolean().optional(),
  })
  .optional();

const ToolEntrySchema = z.object({
  id: z.string().min(1, "tools.entries[].id must be a non-empty string"),
  kind: z.literal("command").optional(),
  command: z.string().min(1, "tools.entries[].command is required"),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  probeTimeoutMs: z
    .number({ invalid_type_error: "tools.entries[].probeTimeoutMs must be a number" })
    .int()
    .min(MIN_PROBE_TIMEOUT_MS, `tools.entries[].probeTimeoutMs must be >= ${MIN_PROBE_TIMEOUT_MS}`)
    .max(MAX_PROBE_TIMEOUT_MS, `tools.entries[].probeTimeoutMs must be <= ${MAX_PROBE_TIMEOUT_MS}`)
    .optional(),
  capabilities: CapabilitySchema,
});

function clampProbeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.floor(value)));
}

interface ToolsSection {
  found: boolean;
  section?: unknown;
}

// Read and return only the optional `tools` section of the settings file. Throws
// a redacted, actionable error on invalid JSON or a non-object root — before any
// probe. A missing file or absent `tools` section is not an error here; the
// caller decides how to treat that.
function readToolsSection(settingsPath: string): ToolsSection {
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
  const tools = root.tools;
  if (tools === undefined) {
    return { found: true };
  }
  return { found: true, section: tools };
}

// Validate an untrusted `tools` section into a ToolContract. Negotiates the
// contract version (fail closed on an unsupported version), rejects raw
// credential fields per entry, refuses non-`command` kinds in this slice,
// enforces unique ids, and validates that any declared default references a
// defined entry. Every failure raises a redacted, deterministic error.
export function parseToolContract(section: unknown): ToolContract {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.tools must be an object");
  }
  const obj = section as Record<string, unknown>;

  // Version negotiation: a required integer within the supported range.
  const version = obj.contractVersion;
  if (version === undefined) {
    throw new Error("Settings error: settings.tools.contractVersion is required");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Settings error: settings.tools.contractVersion must be an integer");
  }
  if (!SUPPORTED_TOOL_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `Settings error: tools contract version ${version} is not supported; ` +
        `supported versions: ${SUPPORTED_TOOL_CONTRACT_VERSIONS.join(", ")}`,
    );
  }

  let def: string | undefined;
  if (obj.default !== undefined) {
    if (typeof obj.default !== "string" || obj.default.trim() === "") {
      throw new Error("Settings error: settings.tools.default must be a non-empty string");
    }
    def = obj.default;
  }

  const rawEntries = obj.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    throw new Error("Settings error: settings.tools.entries must be a non-empty array");
  }

  const entries: ToolEntry[] = [];
  const seen = new Set<string>();
  rawEntries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Settings error: settings.tools.entries[${index}] must be an object`);
    }
    const entryObj = entry as Record<string, unknown>;
    const label =
      typeof entryObj.id === "string" && entryObj.id ? `"${entryObj.id}"` : `[${index}]`;
    for (const forbidden of FORBIDDEN_TOOL_KEYS) {
      if (forbidden in entryObj) {
        throw new Error(
          `Settings error: tool ${label} field "${forbidden}" is a raw credential field; ` +
            "do not inline secrets in a tool definition",
        );
      }
    }
    // This slice is limited to the safe local `command` kind. Refuse remote or
    // network tools (fail closed) rather than silently dropping them.
    if (
      entryObj.url !== undefined ||
      (entryObj.kind !== undefined && entryObj.kind !== "command")
    ) {
      throw new Error(
        `Settings error: tool ${label} declares an unsupported kind; ` +
          'only "command" (a safe local executable) is allowed in contract version 1',
      );
    }
    const result = ToolEntrySchema.safeParse(entryObj);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: ${issues}`);
    }
    if (seen.has(result.data.id)) {
      throw new Error(`Settings error: duplicate tool id "${result.data.id}"`);
    }
    seen.add(result.data.id);
    entries.push(result.data);
  });

  if (def !== undefined && !seen.has(def)) {
    throw new Error(`Settings error: settings.tools.default "${def}" is not a defined tool id`);
  }

  return { contractVersion: version, default: def, entries };
}

// Deterministically select one tool entry: an explicit id wins, then the
// declared default, then the sole entry. Ambiguity (multiple entries, no id, no
// default) and unknown ids fail closed with a clear reason.
export function selectTool(contract: ToolContract, opts: { toolId?: string } = {}): ToolEntry {
  const wanted = opts.toolId && opts.toolId.trim() ? opts.toolId.trim() : undefined;
  if (wanted !== undefined) {
    const found = contract.entries.find((e) => e.id === wanted);
    if (!found) {
      throw new Error(`Tool error: tool "${wanted}" is not defined in settings.tools`);
    }
    return found;
  }
  if (contract.default !== undefined) {
    const found = contract.entries.find((e) => e.id === contract.default);
    if (!found) {
      throw new Error(`Tool error: default tool "${contract.default}" is not defined in settings.tools`);
    }
    return found;
  }
  if (contract.entries.length === 1) {
    return contract.entries[0];
  }
  throw new Error(
    "Tool error: multiple tools defined; select one via --tool <id> or settings.tools.default",
  );
}

// The outcome of a bounded readiness probe for one tool.
export interface ToolReadiness {
  state: ToolReadinessState;
  reason: string;
  probeMs: number | null;
}

type CommandResolution = "found" | "missing" | "timeout";

// Resolve the readiness state of a selected tool. Never throws: a disabled,
// misconfigured, missing, or slow tool resolves to `isolated` (the safe failure
// default) so the run never crashes. `probe: false` reports `declared` without
// probing. `deadline` (absolute epoch ms) bounds the probe; collectToolContract
// computes it from the entry's timeout, and tests may inject a past deadline to
// exercise the timeout branch deterministically.
export function resolveToolReadiness(
  entry: ToolEntry,
  opts: { probe?: boolean; deadline?: number } = {},
): ToolReadiness {
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

// The redacted, serializable result of inspecting a tool contract. No secret
// value, no argument values (only their count), and no unredacted home path. The
// command is home-redacted; the readiness state and reason are safe, fixed
// strings.
export interface ToolContractReport {
  schema: string;
  version: number;
  contractVersion: number;
  toolId: string;
  kind: "command";
  command: string;
  argCount: number;
  enabled: boolean;
  state: ToolReadinessState;
  reason: string;
  probeMs: number | null;
  probeTimeoutMs: number;
  capabilities: ToolCapabilityFlags;
  settings: string;
}

// Pure builder for the redacted report from already-resolved facts.
export function buildToolContractReport(facts: {
  contractVersion: number;
  entry: ToolEntry;
  readiness: ToolReadiness;
  settingsPath: string;
  settingsFound: boolean;
}): ToolContractReport {
  return {
    schema: TOOL_CONTRACT_SCHEMA,
    version: TOOL_CONTRACT_VERSION,
    contractVersion: facts.contractVersion,
    toolId: facts.entry.id,
    kind: "command",
    command: redactHomePath(facts.entry.command),
    argCount: facts.entry.args?.length ?? 0,
    enabled: facts.entry.enabled !== false,
    state: facts.readiness.state,
    reason: facts.readiness.reason,
    probeMs: facts.readiness.probeMs,
    probeTimeoutMs: clampProbeTimeout(facts.entry.probeTimeoutMs),
    capabilities: facts.entry.capabilities ?? {},
    settings: facts.settingsFound
      ? redactHomePath(facts.settingsPath)
      : `${redactHomePath(facts.settingsPath)} (not found)`,
  };
}

export interface ToolResolutionOptions {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  toolId?: string;
  probe?: boolean;
}

// The resolved, unredacted facts for one selected tool: the negotiated contract
// version, the chosen entry (command and args), its readiness state, and the
// settings location. Shared by the read-only report (collectToolContract) and the
// governed invocation path (tool-invocation.ts) so both reuse the same version
// negotiation, deterministic selection, and readiness resolution rather than
// re-reading or re-parsing the contract. Throws the same redacted errors as
// collectToolContract when no `tools` section exists or the contract is invalid.
export interface ResolvedTool {
  contractVersion: number;
  entry: ToolEntry;
  readiness: ToolReadiness;
  settingsPath: string;
  settingsFound: boolean;
}

// Read the user settings file, negotiate the tool contract, deterministically
// select one tool, and resolve its readiness state — returning the raw facts.
// Throws a redacted error when no `tools` section exists or the contract is
// invalid (exit 2). A tool that is disabled or whose command is unavailable
// resolves to `isolated` (a successful resolution, not an error) so the consumer
// can apply safe failure defaults.
export function resolveSelectedTool(opts: ToolResolutionOptions = {}): ResolvedTool {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readToolsSection(settingsPath);
  if (section === undefined) {
    throw new Error(
      found
        ? "Tool error: settings file has no settings.tools section"
        : `Tool error: settings file not found at ${redactHomePath(settingsPath)}`,
    );
  }
  const contract = parseToolContract(section);
  const entry = selectTool(contract, { toolId: opts.toolId });
  const probe = opts.probe ?? true;
  const deadline = probe ? Date.now() + clampProbeTimeout(entry.probeTimeoutMs) : undefined;
  const readiness = resolveToolReadiness(entry, { probe, deadline });
  return {
    contractVersion: contract.contractVersion,
    entry,
    readiness,
    settingsPath,
    settingsFound: found,
  };
}

// Read the user settings file, negotiate the tool contract, select one tool,
// resolve its readiness state, and build the redacted report. Throws a redacted
// error when no `tools` section exists or the contract is invalid (exit 2). A
// tool that is disabled or whose command is unavailable resolves to `isolated`
// (a successful resolution, not an error) so the consumer can apply safe failure
// defaults.
export function collectToolContract(opts: ToolResolutionOptions = {}): ToolContractReport {
  const resolved = resolveSelectedTool(opts);
  return buildToolContractReport({
    contractVersion: resolved.contractVersion,
    entry: resolved.entry,
    readiness: resolved.readiness,
    settingsPath: resolved.settingsPath,
    settingsFound: resolved.settingsFound,
  });
}

// A redacted, human-readable summary of the resolved tool contract.
export function formatToolContract(report: ToolContractReport): string {
  const capabilities = Object.entries(report.capabilities)
    .filter(([, value]) => value)
    .map(([name]) => name);
  const command = redactSecrets(report.command).text;
  const reason = redactSecrets(report.reason).text;
  const lines: Array<string | null> = [
    `Tool:         ${report.toolId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Kind:         ${report.kind}`,
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
