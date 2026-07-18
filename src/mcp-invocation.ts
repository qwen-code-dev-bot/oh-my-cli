// MCP server extension invocation: governed, non-interactive connection to
// exactly one resolved-`ready` versioned MCP server through its contract (#120),
// the MCP `initialize` handshake and tool listing over the safe local stdio
// transport, and the call of exactly one tool — gated by the command trust
// policy (#51) and the existing approval mode, confined to the workspace, bounded
// by a hard timeout and an output-size cap, and redacted. The result is emitted
// as text or JSON. This is the "invoke" step of the MCP server lifecycle that the
// read-only MCP contract (mcp-contract.ts) deliberately deferred; it reuses #120's
// version negotiation, deterministic selection, and lifecycle resolution and #51's
// policy decision rather than re-implementing them, and mirrors the governed tool
// invocation path (tool-invocation.ts).
//
// Trust boundary: the MCP server process and every byte it returns are untrusted
// input. The selected server must resolve to `ready` (a disabled, misconfigured,
// or missing command is never connected). The declared command and its arguments
// are evaluated against the command policy with untrusted (`repository`)
// provenance, so dangerous shapes (destructive git, credential access, path
// escape, destructive removal, device overwrite) are denied before the process is
// spawned. The command is run directly (no shell) so its arguments cannot be
// reinterpreted; it is confined to the workspace (cwd) and bounded in time and
// output. The server speaks newline-delimited JSON-RPC 2.0 over stdio; responses
// are matched to requests by id and notifications/log lines are ignored. Any
// failure — unresolved readiness, policy denial, missing approval, spawn error,
// handshake failure, timeout, oversized output, tool-selection ambiguity, or a
// tool-level error — fails closed with a safe redacted result and never crashes
// the run.

import path from "node:path";
import { spawn } from "node:child_process";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { evaluateCommandPolicy, policyDenialMessage } from "./command-policy.js";
import type { ApprovalMode } from "./approval.js";
import { needsApproval, promptApproval } from "./approval.js";
import { resolveSelectedMcpServer, type ResolvedMcpServer } from "./mcp-contract.js";
import {
  clampInvokeTimeout,
  buildPolicyCommand,
  redactToolOutput,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./tool-invocation.js";

export const MCP_INVOCATION_SCHEMA = "oh-my-cli.mcp-invocation";
export const MCP_INVOCATION_VERSION = 1;

// The MCP protocol version this client advertises in the initialize handshake.
// The server's negotiated version is accepted as-is (not enforced): this slice
// only needs the handshake to succeed against a safe local server, not to police
// protocol versions.
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_CLIENT_NAME = "oh-my-cli";
const MCP_CLIENT_VERSION = "0.1.0";

// The command policy treats a declared server command as untrusted input: the
// same denial rules that govern a repository-derived command apply, so a server
// can never widen the trust boundary by being declared in settings.
const MCP_COMMAND_PROVENANCE = "repository" as const;

// Connecting to a server spawns an arbitrary local command, so it is gated as the
// most cautious built-in category (a shell mutation). Under `default`/`auto-edit`
// it therefore requires approval; only `yolo` auto-approves it.
const MCP_APPROVAL_CATEGORY = "mutate-shell" as const;

// The gate that decided whether the server was connected:
//   passed        — resolved-`ready`, policy-allowed, and approved; connected.
//   not-ready     — lifecycle was `declared` or `isolated`; never connected.
//   policy-denied — the command policy (#51) denied the command; never connected.
//   unapproved    — approval was required and not granted; never connected.
export type McpInvocationGate = "passed" | "not-ready" | "policy-denied" | "unapproved";

// The runtime outcome of a connected session. Only `called` (with isError false)
// is a success; every other value is a bounded, fail-closed failure.
export type McpOutcome =
  | "called" // a tool was invoked and returned a result (isError may still be true)
  | "no-tools" // the server exposed zero tools
  | "tool-not-found" // the requested tool name is not exposed by the server
  | "ambiguous" // no tool name given and the server exposes multiple tools
  | "tool-error" // tools/call returned isError or a JSON-RPC error
  | "handshake-failed" // initialize or tools/list failed or returned no result
  | "timeout" // the session exceeded the hard timeout
  | "output-capped" // captured output exceeded the output-size cap
  | "spawn-error"; // the server process could not be started

// A minimal JSON-RPC 2.0 message as read from the server's stdout. Only the
// fields this client inspects are typed; everything else is ignored.
interface JsonRpcMessage {
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
}

export interface McpRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Explicit tool to call; when omitted the sole exposed tool is used. */
  toolName?: string;
  /** Arguments passed to tools/call (an MCP arguments object). */
  toolArguments: Record<string, unknown>;
}

// The raw, unredacted outcome of one bounded MCP session. Redaction happens when
// the report is built, never here.
export interface McpRunResult {
  outcome: McpOutcome;
  /** The tool actually selected/called, or null when none was. */
  toolName: string | null;
  /** Tool names the server exposed (used for the report's count and tests). */
  availableTools: string[];
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  /** Raw tool result text (redacted later). */
  content: string;
  /** The MCP tool-level isError flag. */
  isError: boolean;
  elapsedMs: number;
  /** Raw reason (redacted later). */
  reason: string;
}

// Runs the bounded MCP session and reports its raw outcome. Injectable so tests
// can drive the gate and selection logic deterministically without a live server.
export type McpRunner = (opts: McpRunOptions) => Promise<McpRunResult>;

// Default runner: spawn the declared command directly (no shell), confined to
// `cwd`, perform the initialize handshake, list tools, and call exactly one tool —
// all bounded by a single hard timeout (covering connect, handshake, list, and
// call) and an output-size cap. On timeout or cap the process is killed; every
// outcome is reported, never thrown.
export const stdioMcpRunner: McpRunner = async (opts) => {
  const start = Date.now();
  const proc = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env });

  let buffer = "";
  let total = 0;
  let outputCapped = false;
  let timedOut = false;
  let spawnError: string | undefined;
  let exitCode: number | null = null;
  let dead = false;
  let deadReason = "";
  const discovered: string[] = [];
  const pending = new Map<
    number,
    { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void }
  >();
  let nextId = 1;

  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process already exited; nothing to kill.
    }
  };

  // Reject every in-flight request and mark the session dead so a later
  // awaitResponse rejects immediately instead of hanging until the timeout.
  const failAll = (reason: string) => {
    dead = true;
    deadReason = reason;
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    failAll("timeout");
    kill();
  }, opts.timeoutMs);

  proc.on("error", (err: Error) => {
    spawnError = err.message;
    failAll("spawn-error");
    kill();
  });

  proc.on("close", (code) => {
    exitCode = code;
    failAll("closed");
  });

  proc.stdout.on("data", (chunk: Buffer) => {
    if (outputCapped || timedOut) return;
    const text = chunk.toString("utf8");
    if (total + text.length > opts.maxOutputBytes) {
      const remaining = Math.max(0, opts.maxOutputBytes - total);
      buffer += text.slice(0, remaining);
      total = opts.maxOutputBytes;
      outputCapped = true;
      kill();
      return;
    }
    buffer += text;
    total += text.length;
    // Dispatch every complete newline-delimited JSON-RPC message; ignore partial
    // lines, non-JSON log noise, notifications, and responses to unknown ids.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const cb = pending.get(msg.id)!;
        pending.delete(msg.id);
        cb.resolve(msg);
      }
    }
  });

  // Drain stderr so the server never blocks writing logs; its contents are
  // untrusted and intentionally ignored (never captured into the report).
  proc.stderr.on("data", () => {});

  const send = (method: string, params: unknown): number => {
    const id = nextId++;
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch {
      // The server may have already exited; awaitResponse will reject.
    }
    return id;
  };

  const notify = (method: string): void => {
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {
      // Best-effort notification; ignore a closed stream.
    }
  };

  const awaitResponse = (id: number): Promise<JsonRpcMessage> =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(new Error(deadReason));
        return;
      }
      pending.set(id, { resolve, reject });
    });

  const result = (
    outcome: McpOutcome,
    toolName: string | null,
    reason: string,
    extra: { content?: string; isError?: boolean } = {},
  ): McpRunResult => ({
    outcome,
    toolName,
    availableTools: discovered.slice(),
    exitCode,
    timedOut,
    outputCapped,
    content: extra.content ?? "",
    isError: extra.isError ?? false,
    elapsedMs: Date.now() - start,
    reason,
  });

  try {
    // Handshake: initialize, then the required initialized notification.
    const initResp = await awaitResponse(
      send("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      }),
    );
    if (!initResp.result) {
      return result("handshake-failed", null, "initialize returned no result");
    }
    notify("notifications/initialized");

    // List the server's tools.
    const listResp = await awaitResponse(send("tools/list", {}));
    if (!listResp.result) {
      return result("handshake-failed", null, "tools/list returned no result");
    }
    const tools = parseToolNames(listResp);
    discovered.push(...tools);
    if (tools.length === 0) {
      return result("no-tools", null, "server exposed no tools");
    }

    // Deterministically select exactly one tool: an explicit name wins, then the
    // sole exposed tool. Ambiguity and unknown names fail closed.
    const wanted = opts.toolName && opts.toolName.trim() ? opts.toolName.trim() : undefined;
    let selected: string | undefined;
    if (wanted !== undefined) {
      selected = tools.find((name) => name === wanted);
      if (selected === undefined) {
        return result("tool-not-found", null, `tool "${wanted}" is not exposed by the server`);
      }
    } else if (tools.length === 1) {
      selected = tools[0];
    } else {
      return result(
        "ambiguous",
        null,
        "server exposes multiple tools; select one via --mcp-tool <name>",
      );
    }

    // Call the selected tool with the bounded arguments object.
    const callResp = await awaitResponse(
      send("tools/call", { name: selected, arguments: opts.toolArguments }),
    );
    if (callResp.error) {
      return result(
        "tool-error",
        selected,
        `tool call failed: ${rpcErrorMessage(callResp.error)}`,
        { isError: true },
      );
    }
    const { content, isError } = parseCallContent(callResp);
    if (isError) {
      return result("tool-error", selected, "tool reported an error", { content, isError: true });
    }
    return result("called", selected, "tool call succeeded", { content });
  } catch (err) {
    // The session died while a request was in flight: classify by the flag the
    // failure path set, falling back to a generic handshake failure.
    if (timedOut) {
      return result("timeout", null, `MCP session exceeded the ${opts.timeoutMs}ms hard timeout`);
    }
    if (outputCapped) {
      return result(
        "output-capped",
        null,
        `MCP output exceeded the ${opts.maxOutputBytes}-byte output cap`,
      );
    }
    if (spawnError) {
      return result("spawn-error", null, `MCP server failed to start: ${spawnError}`);
    }
    return result(
      "handshake-failed",
      null,
      `MCP session ended before completing the call: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
    try {
      proc.stdin.end();
    } catch {
      // The stream is already gone.
    }
    kill();
  }
};

// Extract the tool names from a tools/list response. A malformed result yields an
// empty list (fail closed) rather than throwing.
function parseToolNames(resp: JsonRpcMessage): string[] {
  const result = resp.result;
  if (!result || typeof result !== "object") return [];
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (tool && typeof tool === "object") {
      const name = (tool as Record<string, unknown>).name;
      if (typeof name === "string" && name) names.push(name);
    }
  }
  return names;
}

// Extract the redactable text content and the isError flag from a tools/call
// response. Only `text` content parts are concatenated; other part types are
// ignored so a server cannot smuggle unbounded or binary data into the report.
function parseCallContent(resp: JsonRpcMessage): { content: string; isError: boolean } {
  const result = resp.result;
  if (!result || typeof result !== "object") return { content: "", isError: false };
  const obj = result as Record<string, unknown>;
  const isError = obj.isError === true;
  const parts = obj.content;
  if (!Array.isArray(parts)) return { content: "", isError };
  const texts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === "object") {
      const po = part as Record<string, unknown>;
      if (po.type === "text" && typeof po.text === "string") texts.push(po.text);
    }
  }
  return { content: texts.join("\n"), isError };
}

// A redactable, human-readable message from a JSON-RPC error object.
function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string" && e.message) {
      return typeof e.code === "number" ? `${e.message} (code ${e.code})` : e.message;
    }
  }
  return "unknown JSON-RPC error";
}

export interface McpInvocationReport {
  schema: string;
  version: number;
  contractVersion: number;
  serverId: string;
  transport: "stdio";
  command: string;
  argCount: number;
  workspace: string;
  gate: McpInvocationGate;
  invoked: boolean;
  /** The tool actually called, or null when none was. */
  toolName: string | null;
  /** How many tools the server exposed (bounded metadata, no names). */
  availableToolCount: number;
  /** The McpOutcome when invoked, or the gate value when refused. */
  outcome: string;
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  outputCapBytes: number;
  timeoutMs: number;
  elapsedMs: number;
  content: string;
  isError: boolean;
  reason: string;
  settings: string;
}

// Map a resolved invocation report to a process exit code:
//   2 — refused before connecting (not ready, policy-denied, or unapproved).
//   1 — connected but failed at runtime (no-tools, tool-not-found, ambiguous,
//       tool-error, handshake-failed, timeout, oversized output, spawn error).
//   0 — connected and the tool call succeeded (outcome `called`, not isError).
// Contract/selection/version errors are thrown by resolveSelectedMcpServer and
// mapped to exit 2 by the caller, distinct from a session runtime failure.
export function mcpInvocationExitCode(report: McpInvocationReport): number {
  if (report.gate !== "passed") return 2;
  if (report.timedOut || report.outputCapped) return 1;
  return report.outcome === "called" && !report.isError ? 0 : 1;
}

export interface InvokeMcpOptions {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
  serverId?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  workspace: string;
  approvalMode: ApprovalMode;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Override the MCP session runner (tests). Defaults to the stdio client. */
  runner?: McpRunner;
}

// Resolve, gate, and (if every gate passes) connect to one MCP server and call
// one of its tools. Throws the same redacted errors as the read-only contract for
// contract/selection/version failures (caller maps to exit 2); every other
// failure resolves to a safe redacted report (gate refusal or bounded runtime
// failure) and never throws.
export async function invokeMcpServer(opts: InvokeMcpOptions): Promise<McpInvocationReport> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? stdioMcpRunner;
  const timeoutMs = clampInvokeTimeout(opts.timeoutMs);
  const maxOutputBytes =
    typeof opts.maxOutputBytes === "number" && opts.maxOutputBytes > 0
      ? Math.floor(opts.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  const workspace = path.resolve(opts.workspace);
  const toolArguments = opts.toolArguments ?? {};

  // Resolve via #120's contract (version negotiation, selection, lifecycle). A
  // contract/selection/version error throws here (caller → exit 2).
  const resolved: ResolvedMcpServer = resolveSelectedMcpServer({
    settingsPath: opts.settingsPath,
    env,
    serverId: opts.serverId,
    probe: true,
  });
  const entry = resolved.entry;
  const args = entry.args ?? [];

  const base = {
    schema: MCP_INVOCATION_SCHEMA,
    version: MCP_INVOCATION_VERSION,
    contractVersion: resolved.contractVersion,
    serverId: entry.id,
    transport: "stdio" as const,
    command: redactHomePath(entry.command),
    argCount: args.length,
    workspace: redactHomePath(workspace),
    timeoutMs,
    outputCapBytes: maxOutputBytes,
    settings: resolved.settingsFound
      ? redactHomePath(resolved.settingsPath)
      : `${redactHomePath(resolved.settingsPath)} (not found)`,
  };

  const refused = (gate: McpInvocationGate, reason: string): McpInvocationReport => ({
    ...base,
    gate,
    invoked: false,
    toolName: null,
    availableToolCount: 0,
    outcome: gate,
    exitCode: null,
    timedOut: false,
    outputCapped: false,
    elapsedMs: 0,
    content: "",
    isError: false,
    reason,
  });

  // Gate 1 — readiness: only a resolved-`ready` server may be connected.
  if (resolved.lifecycle.state !== "ready") {
    return refused(
      "not-ready",
      `server lifecycle is "${resolved.lifecycle.state}": ${resolved.lifecycle.reason}; ` +
        'invocation requires "ready"',
    );
  }

  // Gate 2 — command policy (#51): evaluate the declared command + args as
  // untrusted input, confined to the workspace. A denied command is not spawned.
  const policyCommand = buildPolicyCommand(entry.command, args);
  const decision = evaluateCommandPolicy(policyCommand, {
    provenance: MCP_COMMAND_PROVENANCE,
    workspace,
  });
  if (!decision.allowed) {
    return refused("policy-denied", policyDenialMessage(decision));
  }

  // Gate 3 — approval mode: connecting to a server is gated as a shell mutation.
  // When approval is required, an interactive terminal may grant it; a
  // non-interactive run fails closed unless the mode is `yolo`.
  if (needsApproval(opts.approvalMode, MCP_APPROVAL_CATEGORY)) {
    const approved = await promptApproval("shell", { command: policyCommand });
    if (!approved) {
      return refused(
        "unapproved",
        `server invocation requires approval under approval mode "${opts.approvalMode}"; not connected`,
      );
    }
  }

  // Every gate passed: connect, handshake, list, and call one tool — confined and
  // bounded.
  const run = await runner({
    command: entry.command,
    args,
    cwd: workspace,
    env,
    timeoutMs,
    maxOutputBytes,
    toolName: opts.toolName,
    toolArguments,
  });

  return {
    ...base,
    gate: "passed",
    invoked: true,
    toolName: run.toolName,
    availableToolCount: run.availableTools.length,
    outcome: run.outcome,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    outputCapped: run.outputCapped,
    elapsedMs: run.elapsedMs,
    content: redactToolOutput(run.content, workspace),
    isError: run.isError,
    reason: redactToolOutput(run.reason, workspace),
  };
}

// A redacted, human-readable summary of an MCP server invocation.
export function formatMcpInvocation(report: McpInvocationReport): string {
  const command = redactSecrets(report.command).text;
  const reason = redactSecrets(report.reason).text;
  const lines: string[] = [
    `Server:       ${report.serverId}`,
    `Contract:     ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
    `Transport:    ${report.transport}`,
    `Command:      ${command}`,
    `Arguments:    ${report.argCount}`,
    `Workspace:    ${report.workspace}`,
    `Gate:         ${report.gate}`,
    `Invoked:      ${report.invoked}`,
  ];
  if (report.invoked) {
    lines.push(`Tool:         ${report.toolName ?? "(none)"}`);
    lines.push(`Tools seen:   ${report.availableToolCount}`);
    lines.push(`Outcome:      ${report.outcome}`);
    lines.push(
      `Bounds:       ${report.elapsedMs}ms (timeout ${report.timeoutMs}ms, output cap ${report.outputCapBytes} bytes)`,
    );
    if (report.timedOut) lines.push("Timed out:    yes");
    if (report.outputCapped) lines.push("Output cap:   exceeded");
  }
  lines.push(`Reason:       ${reason}`);
  if (report.invoked && report.content) {
    lines.push(`Result:       ${collapse(report.content)}`);
  }
  lines.push(`Settings:     ${report.settings}`);
  return lines.join("\n");
}

// Collapse whitespace and bound a captured result for the one-line text view.
const MAX_DISPLAY_OUTPUT = 240;
function collapse(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_DISPLAY_OUTPUT) return oneLine;
  return `${oneLine.slice(0, MAX_DISPLAY_OUTPUT)} …[+${oneLine.length - MAX_DISPLAY_OUTPUT} chars]`;
}
