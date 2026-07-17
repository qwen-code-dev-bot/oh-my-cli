// Folder trust and effective-sandbox enforcement.
//
// Before project-controlled instructions, settings, tools, hooks, extensions, or
// mutations can affect a run, the CLI must decide whether the workspace folder
// is trusted. This module is the single trust authority: it distinguishes four
// startup states (trusted, untrusted, sandbox-enforced, sandbox-unavailable),
// records durable trust in a user-owned store that a project can never write,
// and produces a fail-closed decision about whether mutating tools may run.
//
// Trust model (see AUTONOMY.md safety boundary #5 and the folder-trust rule):
//   * A workspace is untrusted by default. Trust is granted only by an explicit
//     user act — adding it to the user-owned trust store, the `--trust` flag for
//     a single run, or launching inside an effective sandbox.
//   * The trust store lives under the user's home directory and is never a
//     project-local path, so an untrusted repository cannot trust itself or
//     select its own model endpoint, credential source, or mutating tools.
//   * The decision is fail closed: anything that is not explicitly trusted or
//     sandbox-enforced denies mutation, and approval modes (default, auto-edit,
//     yolo) are subordinate to it — yolo cannot widen the boundary.
//   * The canonical workspace key collapses symlink aliases and linked git
//     worktrees to one identity, so a subagent or leased worktree inherits its
//     parent's trust (equal isolation) rather than escaping it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceIdentity } from "./workspace-guard.js";
import { redactHomePath } from "./permission-impact.js";

export const FOLDER_TRUST_SCHEMA = "oh-my-cli.folder-trust";
export const FOLDER_TRUST_VERSION = 1;

// The four startup trust states the CLI distinguishes in interactive and
// headless modes.
export type TrustState =
  | "trusted"
  | "untrusted"
  | "sandbox-enforced"
  | "sandbox-unavailable";

// Whether an effective sandbox is advertised around tool execution. The CLI does
// not itself create an OS sandbox; a launcher that does advertises it.
export type SandboxAvailability = "none" | "enforced";

// The user-owned trust store. Never a project-local path: an untrusted
// repository must not be able to trust itself.
export function defaultTrustStorePath(): string {
  return path.join(os.homedir(), ".oh-my-cli", "trust.json");
}

export interface TrustStore {
  schema: string;
  version: number;
  /** Canonical workspace keys (see workspaceTrustKey). */
  trusted: string[];
}

export function emptyTrustStore(): TrustStore {
  return { schema: FOLDER_TRUST_SCHEMA, version: FOLDER_TRUST_VERSION, trusted: [] };
}

// Load and structurally validate the trust store. A missing or malformed store
// fails closed to empty (no workspace trusted) rather than throwing, so a
// corrupt store never silently widens trust.
export function loadTrustStore(storePath: string): TrustStore {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf-8");
  } catch {
    return emptyTrustStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTrustStore();
  }
  if (!isTrustStore(parsed)) return emptyTrustStore();
  return parsed;
}

function isTrustStore(v: unknown): v is TrustStore {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schema === FOLDER_TRUST_SCHEMA &&
    o.version === FOLDER_TRUST_VERSION &&
    Array.isArray(o.trusted) &&
    o.trusted.every((k) => typeof k === "string")
  );
}

export function isTrusted(store: TrustStore, key: string): boolean {
  return store.trusted.includes(key);
}

// Return a new store with the key added (deduplicated, order preserved).
export function addTrusted(store: TrustStore, key: string): TrustStore {
  if (store.trusted.includes(key)) return store;
  return { ...store, trusted: [...store.trusted, key] };
}

export function saveTrustStore(storePath: string, store: TrustStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

// Canonical workspace key: collapses symlink aliases and linked git worktrees to
// one identity, so a child in a worktree shares its parent's trust.
export function workspaceTrustKey(workspacePath: string): string {
  return workspaceIdentity(workspacePath).key;
}

// Detect an effective sandbox from a documented launcher signal. A launcher that
// runs tool execution inside an OS sandbox sets OMC_SANDBOX=enforced.
export function detectSandbox(
  env: Record<string, string | undefined> = process.env,
): SandboxAvailability {
  return env.OMC_SANDBOX === "enforced" ? "enforced" : "none";
}

export interface FolderTrustInput {
  /** Whether the workspace key is trusted (store membership or `--trust`). */
  trusted: boolean;
  sandbox: SandboxAvailability;
  /** Policy: an untrusted folder must run under a sandbox to mutate. */
  requireSandbox: boolean;
}

export interface FolderTrustDecision {
  state: TrustState;
  /** Whether mutating tools may run; false fails closed regardless of mode. */
  mutatingAllowed: boolean;
  /** Bounded, redacted explanation. */
  reason: string;
}

// Decide the effective trust state and whether mutating tools may run. Trust is
// fail closed: only an enforced sandbox or an explicitly trusted folder permits
// mutation; every other case denies regardless of the approval mode.
export function decideFolderTrust(input: FolderTrustInput): FolderTrustDecision {
  if (input.sandbox === "enforced") {
    return {
      state: "sandbox-enforced",
      mutatingAllowed: true,
      reason: "An effective sandbox is enforced around tool execution.",
    };
  }
  if (input.trusted) {
    return {
      state: "trusted",
      mutatingAllowed: true,
      reason: "Workspace is present in the user trust store.",
    };
  }
  if (input.requireSandbox) {
    return {
      state: "sandbox-unavailable",
      mutatingAllowed: false,
      reason: "Workspace is untrusted and no effective sandbox is available.",
    };
  }
  return {
    state: "untrusted",
    mutatingAllowed: false,
    reason: "Workspace is not trusted; mutating tools fail closed.",
  };
}

export interface ResolveFolderTrustOptions {
  workspacePath: string;
  storePath?: string;
  env?: Record<string, string | undefined>;
  /** `--trust`: trust this workspace for this run only (not persisted). */
  trustThisRun?: boolean;
  /** `--require-sandbox` / OMC_REQUIRE_SANDBOX=1. */
  requireSandbox?: boolean;
}

export interface ResolvedFolderTrust {
  key: string;
  store: TrustStore;
  sandbox: SandboxAvailability;
  decision: FolderTrustDecision;
}

// Resolve the full folder-trust decision for a workspace in one call.
export function resolveFolderTrust(opts: ResolveFolderTrustOptions): ResolvedFolderTrust {
  const env = opts.env ?? process.env;
  const storePath = opts.storePath ?? defaultTrustStorePath();
  const store = loadTrustStore(storePath);
  const key = workspaceTrustKey(opts.workspacePath);
  const trusted = opts.trustThisRun === true || isTrusted(store, key);
  const sandbox = detectSandbox(env);
  const requireSandbox = opts.requireSandbox === true || env.OMC_REQUIRE_SANDBOX === "1";
  const decision = decideFolderTrust({ trusted, sandbox, requireSandbox });
  return { key, store, sandbox, decision };
}

// A bounded, redacted, human-readable summary. Never leaks an unredacted home
// path or any secret.
export function formatFolderTrust(opts: {
  workspacePath: string;
  decision: FolderTrustDecision;
  sandbox: SandboxAvailability;
  enforcing: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Folder Trust");
  lines.push("─".repeat(40));
  lines.push(`Workspace:   ${redactHomePath(opts.workspacePath)}`);
  lines.push(`Trust state: ${opts.decision.state}`);
  lines.push(`Sandbox:     ${opts.sandbox}`);
  lines.push(
    `Mutation:    ${opts.decision.mutatingAllowed ? "permitted (approval mode still applies)" : "DENIED (fail closed)"}`,
  );
  lines.push(`Enforcing:   ${opts.enforcing ? "yes" : "no (advisory only)"}`);
  lines.push(`Reason:      ${opts.decision.reason}`);
  return lines.join("\n");
}

// The fail-closed message returned when a mutating tool is denied because the
// folder is untrusted. Actionable and free of host paths or secrets.
export function folderTrustDenialMessage(): string {
  return (
    "Tool denied: this workspace is untrusted and folder-trust enforcement is " +
    "active, so mutating tools fail closed. Trust it for this run with --trust, " +
    "persist trust with --trust-workspace, or run inside an effective sandbox " +
    "(OMC_SANDBOX=enforced). Read-only tools are unaffected."
  );
}
