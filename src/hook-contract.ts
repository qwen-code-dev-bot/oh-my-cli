// Hook contract: declare user-owned `PreToolUse` hooks as a versioned section of
// the unified user settings file (settings.ts), then evaluate them as a deny-only
// gate before a tool executes in the agent loop (agent.ts) — all without changing
// core code. A hook is a named tool matcher plus a bounded local command; before a
// matching tool call runs, the command is invoked with the tool call as JSON
// context and may return a deny decision (process exit code 2, or a JSON
// `permissionDecision` of `deny`) that blocks the call. A hook can only ever make
// a decision MORE restrictive: silence — or an `allow`/`ask` decision — leaves the
// normal approval flow unchanged, so a hook can never relax an approval.
//
// Trust boundary: hook configuration is untrusted input read ONLY from the
// user-owned settings scope (resolveSettingsPath never resolves a project-local
// path), so an untrusted repository cannot define or run a hook. A hook may only
// deny, never approve, so it cannot widen the permission system; it is best-effort
// policy, not a hard security boundary. Raw credential fields inside a hook are
// rejected rather than ignored, matching the workflow/provider contracts. The hook
// command runs directly (no shell, so its arguments cannot be reinterpreted),
// confined to the workspace and bounded by a hard timeout and an output-size cap;
// a timeout or a spawn failure fails closed (the call is denied) before any tool
// side effect. The hook command, its arguments, and any deny reason are redacted
// (no secrets, no home path) in every listing, error, and tool result. An
// unsupported contract version, an unknown/misspelled key, an invalid matcher, or
// a malformed entry fails closed before any side effect, consistent with the
// effective-settings registry (effective-settings.ts) and the workflow contract.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";

export const HOOK_CONTRACT_SCHEMA = "oh-my-cli.hook-contract";
export const HOOK_CONTRACT_VERSION = 1;

// The contract versions this build can negotiate. A settings file declaring a
// version outside this range is refused (fail closed) rather than coerced, so a
// future format change cannot silently reinterpret an older or newer definition.
export const SUPPORTED_HOOK_CONTRACT_VERSIONS: readonly number[] = [1];

// Bounded execution window (milliseconds) for one hook. A hook slower than this is
// killed and the call fails closed, so a hung hook can never block the run or a
// tool side effect.
export const HOOK_TIMEOUT_MS = 5_000;

// Bounded captured decision output (bytes, across stdout + stderr). A hook returns
// its decision as a small JSON object; anything larger is truncated, so an
// unbounded producer cannot exhaust memory or flood the report.
export const HOOK_MAX_OUTPUT_BYTES = 8_192;

// Per-string bound applied to the tool-call context handed to a hook on stdin, so
// a tool with a large argument (e.g. a file's content) cannot stall the hook's
// stdin pipe. The JSON stays valid; long strings are truncated.
const HOOK_INPUT_STRING_MAX = 2_048;

// Raw secret field names that must never appear in a hook entry. The parser rejects
// (rather than ignores) them so a plaintext secret cannot become a supported
// configuration path. Mirrors the workflow/model/provider contracts.
const FORBIDDEN_HOOK_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// A matcher is `"*"` (every tool) or a single built-in tool name. Tool names are
// portable lowercase identifiers; the matcher is validated to that shape so a
// typo or a glob cannot silently match nothing.
export const HOOK_MATCHER_ALL = "*";
export const HOOK_TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const MAX_MATCHER = 128;
const MAX_COMMAND = 4_096;
const MAX_ARG = 4_096;
const MAX_ARGS = 64;
const MAX_REASON = 500;

// One declared PreToolUse hook: a tool matcher and the bounded command to run.
export interface PreToolUseHook {
  /** `"*"` or an exact tool name (validated against HOOK_TOOL_NAME_RE). */
  matcher: string;
  command: string;
  args: string[];
}

// The validated `hooks` section: a negotiated contract version and the validated
// PreToolUse hooks.
export interface HookContract {
  contractVersion: number;
  preToolUse: PreToolUseHook[];
}

const HookEntrySchema = z
  .object({
    matcher: z
      .string()
      .min(1, "hook.matcher must be a non-empty string")
      .max(MAX_MATCHER, "hook.matcher is too long"),
    command: z
      .string()
      .min(1, "hook.command must be a non-empty string")
      .max(MAX_COMMAND, "hook.command is too long"),
    args: z
      .array(z.string().max(MAX_ARG, "hook argument is too long"))
      .max(MAX_ARGS, "too many hook arguments")
      .optional(),
  })
  .strict();

function isValidMatcher(matcher: string): boolean {
  return matcher === HOOK_MATCHER_ALL || HOOK_TOOL_NAME_RE.test(matcher);
}

function assertNoForbiddenKeys(obj: Record<string, unknown>, label: string): void {
  for (const forbidden of FORBIDDEN_HOOK_KEYS) {
    if (forbidden in obj) {
      throw new Error(
        `Settings error: ${label} field "${forbidden}" is a raw credential field; ` +
          "reference credentials via the environment, never inline in a hook",
      );
    }
  }
}

interface HooksSection {
  found: boolean;
  section?: unknown;
}

// Read and return only the optional `hooks` section of the user settings file.
// Throws a redacted, actionable error on invalid JSON or a non-object root — before
// any hook is evaluated. A missing file or absent `hooks` section is not an error
// here; the caller decides how to treat that. Reads only the user-owned scope.
function readHooksSection(settingsPath: string): HooksSection {
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
  const hooks = root.hooks;
  if (hooks === undefined) {
    return { found: true };
  }
  return { found: true, section: hooks };
}

// Validate an untrusted `hooks` section into a HookContract. Negotiates the contract
// version (fail closed on an unsupported version), rejects unknown envelope keys,
// raw credential fields per hook, malformed entries, and invalid matchers. Every
// failure raises a redacted, deterministic error.
export function parseHookContract(section: unknown): HookContract {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.hooks must be an object");
  }
  const obj = section as Record<string, unknown>;

  // Envelope: only contractVersion + PreToolUse are allowed. An unknown key is a
  // typo (e.g. "version", "preToolUse") and is rejected rather than ignored.
  for (const key of Object.keys(obj)) {
    if (key !== "contractVersion" && key !== "PreToolUse") {
      throw new Error(`Settings error: settings.hooks has unknown key "${key}"`);
    }
  }

  // Version negotiation: a required integer within the supported range.
  const version = obj.contractVersion;
  if (version === undefined) {
    throw new Error("Settings error: settings.hooks.contractVersion is required");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Settings error: settings.hooks.contractVersion must be an integer");
  }
  if (!SUPPORTED_HOOK_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `Settings error: hook contract version ${version} is not supported; ` +
        `supported versions: ${SUPPORTED_HOOK_CONTRACT_VERSIONS.join(", ")}`,
    );
  }

  const rawHooks = obj.PreToolUse;
  if (rawHooks === undefined) {
    // A hooks section that declares no PreToolUse event is an empty inventory.
    return { contractVersion: version, preToolUse: [] };
  }
  if (!Array.isArray(rawHooks)) {
    throw new Error("Settings error: settings.hooks.PreToolUse must be an array");
  }

  const preToolUse: PreToolUseHook[] = [];
  rawHooks.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Settings error: settings.hooks.PreToolUse[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    assertNoForbiddenKeys(entry, `settings.hooks.PreToolUse[${index}]`);

    const result = HookEntrySchema.safeParse(entry);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: settings.hooks.PreToolUse[${index}]: ${issues}`);
    }
    if (!isValidMatcher(result.data.matcher)) {
      throw new Error(
        `Settings error: settings.hooks.PreToolUse[${index}].matcher "${result.data.matcher}" ` +
          `must be "*" or a tool name (${HOOK_TOOL_NAME_RE.source})`,
      );
    }
    preToolUse.push({
      matcher: result.data.matcher,
      command: result.data.command,
      args: result.data.args ?? [],
    });
  });

  return { contractVersion: version, preToolUse };
}

// Read the user settings file, negotiate the hook contract, and return the declared
// PreToolUse hooks. Returns an empty array when no `hooks` section exists (or the
// file is missing); throws a redacted error on a present-but-malformed section.
// Reads only the user-owned scope, so a project-local file is never consulted.
export function resolvePreToolUseHooks(opts: { settingsPath?: string } = {}): PreToolUseHook[] {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { section } = readHooksSection(settingsPath);
  if (section === undefined) return [];
  return parseHookContract(section).preToolUse;
}

// Whether a hook's matcher selects a given tool name.
export function hookMatches(hook: PreToolUseHook, toolName: string): boolean {
  return hook.matcher === HOOK_MATCHER_ALL || hook.matcher === toolName;
}

// The raw, unredacted outcome of running one hook. Redaction happens when a reason
// is surfaced, never here.
export interface HookRunResult {
  exitCode: number | null;
  timedOut: boolean;
  outputCapped: boolean;
  stdout: string;
  stderr: string;
  /** Present when the process could not be spawned (e.g. command not found). */
  spawnError?: string;
}

export interface HookRunOptions {
  command: string;
  args: string[];
  /** JSON tool-call context written to the hook's stdin. */
  input: string;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
}

// Runs the declared hook command and reports its raw outcome. Injectable so tests
// can drive the decision logic deterministically without spawning real processes.
export type HookRunner = (opts: HookRunOptions) => Promise<HookRunResult>;

// Default runner: spawn the command directly (no shell, so arguments cannot be
// reinterpreted), confined to `cwd`, bounded by a hard timeout and an output-size
// cap, with no controlling terminal. The tool-call context is written to stdin and
// the stream is closed; a hook that never reads stdin cannot stall the run (a write
// error is swallowed). On timeout or cap the process is killed; the outcome is
// reported, never thrown.
export const spawnHookRunner: HookRunner = (opts) =>
  new Promise<HookRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let total = 0;
    let timedOut = false;
    let outputCapped = false;
    let settled = false;

    const proc = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process already exited; nothing to kill.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (outputCapped || timedOut) return;
      const text = chunk.toString("utf8");
      if (total + text.length > opts.maxOutputBytes) {
        const remaining = Math.max(0, opts.maxOutputBytes - total);
        if (stream === "stdout") stdout += text.slice(0, remaining);
        else stderr += text.slice(0, remaining);
        total = opts.maxOutputBytes;
        outputCapped = true;
        kill();
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
      total += text.length;
    };

    proc.stdout.on("data", onData("stdout"));
    proc.stderr.on("data", onData("stderr"));

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut,
        outputCapped,
        stdout: "",
        stderr: "",
        spawnError: err.message,
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, outputCapped, stdout, stderr });
    });

    // Hand the bounded tool-call context to the hook, then close stdin. A hook that
    // exits before reading (or never reads) must not crash the run on EPIPE.
    try {
      proc.stdin.on("error", () => {
        /* the hook exited early; the context is simply unused */
      });
      proc.stdin.end(opts.input);
    } catch {
      /* ignore */
    }
  });

export interface PreToolUseContext {
  toolName: string;
  toolInput: Record<string, unknown>;
}

// The outcome of evaluating the matching hooks for one tool call: either a deny
// (with a redacted reason) or silence (the normal approval flow applies).
export interface HookDecision {
  denied: boolean;
  reason: string;
}

export interface EvaluateHooksOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Override the hook runner (tests). Defaults to spawning the command. */
  runner?: HookRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const SILENT: HookDecision = { denied: false, reason: "" };

// Evaluate the PreToolUse hooks that match a tool call, in declared order, stopping
// at the first deny. No matching hook ⇒ silence. A hook may only deny; an
// `allow`/`ask` decision or any non-deny outcome is treated as silence so the
// normal approval flow is unchanged. A hook timeout or spawn failure fails closed
// (deny) before any tool side effect.
export async function evaluatePreToolUseHooks(
  hooks: readonly PreToolUseHook[],
  ctx: PreToolUseContext,
  opts: EvaluateHooksOptions,
): Promise<HookDecision> {
  const matching = hooks.filter((h) => hookMatches(h, ctx.toolName));
  if (matching.length === 0) return SILENT;

  const runner = opts.runner ?? spawnHookRunner;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? HOOK_MAX_OUTPUT_BYTES;
  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: ctx.toolName,
    tool_input: boundForHook(ctx.toolInput, HOOK_INPUT_STRING_MAX),
  });

  for (const hook of matching) {
    const run = await runner({
      command: hook.command,
      args: hook.args,
      input,
      cwd: opts.cwd,
      env,
      timeoutMs,
      maxOutputBytes,
    });
    const decision = interpretHookRun(run);
    if (decision.denied) return decision;
  }
  return SILENT;
}

// Interpret one hook run into a deny/silent decision. Fail closed (deny) on a
// timeout or a spawn failure; honor an explicit deny (JSON `permissionDecision`
// or exit code 2); treat everything else as silence (a hook can only ever deny).
function interpretHookRun(run: HookRunResult): HookDecision {
  if (run.timedOut) {
    return {
      denied: true,
      reason: "a PreToolUse hook exceeded its timeout and the call was denied (fail closed)",
    };
  }
  if (run.spawnError) {
    return {
      denied: true,
      reason: "a PreToolUse hook failed to start and the call was denied (fail closed)",
    };
  }
  const parsed = parseDecision(run.stdout);
  if (parsed && parsed.decision === "deny") {
    return {
      denied: true,
      reason: redactReason(parsed.reason) ?? "a PreToolUse hook denied the tool call",
    };
  }
  if (run.exitCode === 2) {
    return {
      denied: true,
      reason: redactReason(parsed?.reason) ?? "a PreToolUse hook denied the tool call (exit 2)",
    };
  }
  return SILENT;
}

// Parse a hook's stdout as a JSON decision object. Returns null when stdout is
// empty, not JSON, or carries no `permissionDecision` — none of which is a deny.
function parseDecision(stdout: string): { decision: string; reason?: string } | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.permissionDecision !== "string") return null;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  return { decision: obj.permissionDecision, reason };
}

// Replace every occurrence of the host home directory with `~`. Unlike
// redactHomePath (which only collapses a leading prefix), an untrusted hook
// reason can embed the home path mid-string, so any occurrence must be redacted.
function redactHomeOccurrences(text: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && home.length > 1 && text.includes(home)) {
    return text.split(home).join("~");
  }
  return text;
}

// Redact an untrusted hook reason for safe surfacing: strip secrets, collapse the
// home path (anywhere it appears), remove control characters, and bound the
// length. Returns undefined when nothing usable remains.
function redactReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  let text = redactSecrets(reason).text;
  text = redactHomeOccurrences(text);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
}

// Deep-copy a tool-call context with long strings truncated, so a tool with a large
// argument cannot stall the hook's stdin while keeping the JSON valid.
function boundForHook(value: unknown, maxLen: number): unknown {
  if (typeof value === "string") {
    return value.length <= maxLen ? value : `${value.slice(0, maxLen)}…`;
  }
  if (Array.isArray(value)) return value.map((v) => boundForHook(v, maxLen));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = boundForHook(v, maxLen);
    return out;
  }
  return value;
}

// The redacted, serializable result of listing the declared hooks. No secret and no
// unredacted home path; the command is home-redacted and arguments are reported as a
// count (their values are never surfaced).
export interface HookListEntry {
  event: "PreToolUse";
  matcher: string;
  command: string;
  args: number;
}

export interface HookListReport {
  schema: string;
  version: number;
  contractVersion: number;
  hooks: HookListEntry[];
  settings: string;
}

// Read the user settings file, negotiate the hook contract, and build the redacted
// list report. Like the workflow/profile listings, listing never throws when no
// `hooks` section exists — it reports an empty inventory — but a
// present-but-malformed section still fails closed.
export function collectHookList(opts: { settingsPath?: string } = {}): HookListReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readHooksSection(settingsPath);
  const contract = section === undefined ? undefined : parseHookContract(section);
  const hooks: HookListEntry[] = (contract?.preToolUse ?? []).map((h) => ({
    event: "PreToolUse" as const,
    matcher: h.matcher,
    command: redactHomePath(h.command),
    args: h.args.length,
  }));
  return {
    schema: HOOK_CONTRACT_SCHEMA,
    version: HOOK_CONTRACT_VERSION,
    contractVersion: contract?.contractVersion ?? HOOK_CONTRACT_VERSION,
    hooks,
    settings: found ? redactHomePath(settingsPath) : `${redactHomePath(settingsPath)} (not found)`,
  };
}

// A redacted, human-readable summary of the declared hooks.
export function formatHookList(report: HookListReport): string {
  const lines: string[] = [];
  lines.push("Hooks");
  lines.push("─".repeat(40));
  lines.push(
    `Contract:  ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
  );
  lines.push(`Settings:  ${report.settings}`);
  if (report.hooks.length === 0) {
    lines.push("PreToolUse: (none)");
  } else {
    lines.push(`PreToolUse: ${report.hooks.length}`);
    for (const h of report.hooks) {
      const command = redactSecrets(h.command).text;
      const argWord = h.args === 1 ? "arg" : "args";
      lines.push(`  ${h.matcher} — ${command} (${h.args} ${argWord})`);
    }
  }
  return lines.join("\n");
}
