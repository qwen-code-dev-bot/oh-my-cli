// Workspace `.env` loading for model configuration (Issue #509).
//
// A trusted workspace's `.env` file participates in model-config resolution as
// a layer under the real environment and over the user settings file, so the
// de facto Node ecosystem convention "project `.env` just works" applies to
// onboarding without weakening the trust model:
//
//   * Trust gated: only a workspace trusted via the user-owned folder-trust
//     store (or `--trust` for this run) has its `.env` read. An untrusted
//     repository can neither redirect the endpoint nor supply credentials
//     through `.env`. A sandbox-enforced-but-untrusted workspace does not
//     qualify: a sandbox constrains tool execution, not endpoint selection.
//   * Parse only: the file is parsed in memory with `node:util` `parseEnv` and
//     merged under the real environment for resolution lookups. `process.env`
//     is never mutated, so `.env` values never leak into spawned tools or
//     child processes.
//   * Secret end to end: values are never logged, serialized, or returned in
//     diagnostics; only the `.env` path may surface (see settings.ts
//     provenance). An untrusted or missing file is a silent no-op.

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  defaultTrustStorePath,
  isTrusted,
  loadTrustStore,
  workspaceTrustKey,
} from "./folder-trust.js";

export interface LoadWorkspaceEnvOptions {
  /** The workspace whose `.env` may be loaded. */
  workspacePath: string;
  /** Trust store to gate against; defaults to the user-owned store. */
  storePath?: string;
  /** `--trust`: trust this workspace for this run only (not persisted). */
  trustThisRun?: boolean;
}

// The result of a workspace `.env` load attempt. `values` carries parsed
// entries only when `loaded` is true; it must never be logged or serialized.
export interface WorkspaceEnvLoad {
  /** Absolute path of the consulted `.env` file (diagnostic-safe). */
  envPath: string;
  /** True only when a trusted workspace's `.env` was read and parsed. */
  loaded: boolean;
  /** Parsed entries; empty unless `loaded`. Never printed anywhere. */
  values: Record<string, string>;
}

const EMPTY_VALUES: Record<string, string> = Object.freeze({});

// Load a trust-gated workspace `.env` for model-config resolution. Untrusted
// workspaces, missing files, and unreadable or malformed files all yield a
// silent no-op (`loaded: false`, empty values) rather than an error, so `.env`
// support can never break startup. Never mutates `process.env`.
export function loadWorkspaceEnv(opts: LoadWorkspaceEnvOptions): WorkspaceEnvLoad {
  const envPath = path.join(opts.workspacePath, ".env");
  const trusted =
    opts.trustThisRun === true ||
    isTrusted(
      loadTrustStore(opts.storePath ?? defaultTrustStorePath()),
      workspaceTrustKey(opts.workspacePath),
    );
  if (!trusted) {
    return { envPath, loaded: false, values: EMPTY_VALUES };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return { envPath, loaded: false, values: EMPTY_VALUES };
  }
  const parsed = parseEnv(raw);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== undefined) values[name] = value;
  }
  return { envPath, loaded: true, values };
}
