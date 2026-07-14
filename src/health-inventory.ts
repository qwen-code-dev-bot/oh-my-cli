// Bounded health inventory for configured MCP servers and extensions.
//
// Reads a settings file, normalizes each integration into a typed record, and
// probes each one with a hard timeout. Probes are deliberately shallow: a stdio
// server is resolved on PATH (never executed), an http(s) server is reached with
// a single request whose body is discarded, and an extension path is stat'd. This
// distinguishes healthy / unavailable / misconfigured / disabled integrations
// without running arbitrary code or echoing remote response bodies. Credentials
// in URLs, env, and headers are never printed.

import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./permission-impact.js";

export type HealthCategory = "healthy" | "unavailable" | "misconfigured" | "disabled";

export interface IntegrationRecord {
  kind: "mcp" | "extension";
  name: string;
  enabled: boolean;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  path?: string;
  configError?: string;
}

export interface IntegrationHealth {
  kind: "mcp" | "extension";
  transport?: "stdio" | "http";
  name: string;
  target: string;
  enabled: boolean;
  category: HealthCategory;
  reason: string;
  probeMs: number | null;
}

export interface HealthInventory {
  settingsPath: string;
  settingsFound: boolean;
  parseError?: string;
  probeTimeoutMs: number;
  integrations: IntegrationHealth[];
}

const DEFAULT_TIMEOUT = 3000;
const MIN_TIMEOUT = 50;
const MAX_TIMEOUT = 30000;

const SYMBOLS: Record<HealthCategory, string> = {
  healthy: "✓",
  unavailable: "✗",
  misconfigured: "⚠",
  disabled: "⊘",
};

export function normalizeIntegrations(raw: unknown): {
  records: IntegrationRecord[];
  probeTimeoutMs: number;
  error?: string;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { records: [], probeTimeoutMs: DEFAULT_TIMEOUT, error: "settings root must be an object" };
  }

  const root = raw as Record<string, unknown>;
  let probeTimeoutMs = DEFAULT_TIMEOUT;
  if (typeof root.probeTimeoutMs === "number" && Number.isFinite(root.probeTimeoutMs)) {
    probeTimeoutMs = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.floor(root.probeTimeoutMs)));
  }

  const records: IntegrationRecord[] = [];

  const mcp = root.mcpServers;
  if (mcp !== undefined && typeof mcp === "object" && mcp !== null && !Array.isArray(mcp)) {
    for (const [name, entry] of Object.entries(mcp as Record<string, unknown>)) {
      records.push(normalizeMcp(name, entry));
    }
  }

  const ext = root.extensions;
  if (ext !== undefined && typeof ext === "object" && ext !== null && !Array.isArray(ext)) {
    for (const [name, entry] of Object.entries(ext as Record<string, unknown>)) {
      records.push(normalizeExtension(name, entry));
    }
  }

  return { records, probeTimeoutMs };
}

function normalizeMcp(name: string, entry: unknown): IntegrationRecord {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { kind: "mcp", name, enabled: true, configError: "invalid server entry" };
  }
  const e = entry as Record<string, unknown>;
  const enabled = e.enabled !== false;
  const command = typeof e.command === "string" ? e.command.trim() : "";
  const url = typeof e.url === "string" ? e.url.trim() : "";
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [];

  if (command) {
    return { kind: "mcp", name, enabled, transport: "stdio", command, args };
  }
  if (url) {
    if (!isValidHttpUrl(url)) {
      return { kind: "mcp", name, enabled, transport: "http", url, configError: "invalid url" };
    }
    return { kind: "mcp", name, enabled, transport: "http", url };
  }
  return { kind: "mcp", name, enabled, configError: "missing command or url" };
}

function normalizeExtension(name: string, entry: unknown): IntegrationRecord {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { kind: "extension", name, enabled: true, configError: "invalid extension entry" };
  }
  const e = entry as Record<string, unknown>;
  const enabled = e.enabled !== false;
  const p = typeof e.path === "string" ? e.path.trim() : "";
  if (!p) {
    return { kind: "extension", name, enabled, configError: "missing path" };
  }
  return { kind: "extension", name, enabled, path: p };
}

export async function collectHealthInventory(settingsPath: string): Promise<HealthInventory> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(settingsPath, "utf8");
  } catch {
    return { settingsPath, settingsFound: false, probeTimeoutMs: DEFAULT_TIMEOUT, integrations: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      settingsPath,
      settingsFound: true,
      parseError: "invalid JSON",
      probeTimeoutMs: DEFAULT_TIMEOUT,
      integrations: [],
    };
  }

  const norm = normalizeIntegrations(parsed);
  if (norm.error) {
    return {
      settingsPath,
      settingsFound: true,
      parseError: norm.error,
      probeTimeoutMs: norm.probeTimeoutMs,
      integrations: [],
    };
  }

  const integrations = await Promise.all(norm.records.map((rec) => probeRecord(rec, norm.probeTimeoutMs)));
  return { settingsPath, settingsFound: true, probeTimeoutMs: norm.probeTimeoutMs, integrations };
}

async function probeRecord(rec: IntegrationRecord, timeoutMs: number): Promise<IntegrationHealth> {
  const base = {
    kind: rec.kind,
    transport: rec.transport,
    name: rec.name,
    target: safeTarget(rec),
    enabled: rec.enabled,
  };

  if (rec.configError) {
    return { ...base, category: "misconfigured", reason: rec.configError, probeMs: null };
  }
  if (!rec.enabled) {
    return { ...base, category: "disabled", reason: "disabled", probeMs: null };
  }
  if (rec.kind === "mcp" && rec.transport === "stdio") {
    return { ...base, ...probeStdio(rec.command!) };
  }
  if (rec.kind === "mcp" && rec.transport === "http") {
    return { ...base, ...(await probeHttp(rec.url!, timeoutMs)) };
  }
  if (rec.kind === "extension") {
    return { ...base, ...(await probeExtension(rec.path!)) };
  }
  return { ...base, category: "misconfigured", reason: "unknown integration type", probeMs: null };
}

type ProbeOutcome = { category: HealthCategory; reason: string; probeMs: number };

function probeStdio(command: string): ProbeOutcome {
  // Resolve the binary on PATH without executing it — probing must not run
  // arbitrary code, only confirm the command is available.
  const start = Date.now();
  const found = resolveCommand(command);
  const probeMs = Date.now() - start;
  return found
    ? { category: "healthy", reason: "command resolved", probeMs }
    : { category: "unavailable", reason: "command not found", probeMs };
}

async function probeHttp(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "manual" });
    // Discard the body without buffering it — never echo remote payloads.
    await res.body?.cancel().catch(() => {});
    return { category: "healthy", reason: `reachable (HTTP ${res.status})`, probeMs: Date.now() - start };
  } catch (err) {
    const probeMs = Date.now() - start;
    if (controller.signal.aborted) {
      return { category: "unavailable", reason: "connection timed out", probeMs };
    }
    return { category: "unavailable", reason: classifyNetError(err), probeMs };
  } finally {
    clearTimeout(timer);
  }
}

async function probeExtension(p: string): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    await fs.promises.access(p);
    return { category: "healthy", reason: "path exists", probeMs: Date.now() - start };
  } catch {
    return { category: "unavailable", reason: "path not found", probeMs: Date.now() - start };
  }
}

function resolveCommand(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command);
  }
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"]
      : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (isExecutable(path.join(dir, command + ext))) return true;
    }
  }
  return false;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function classifyNetError(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ENOTFOUND":
      return "host not found";
    case "ECONNRESET":
      return "connection reset";
    case "ETIMEDOUT":
      return "connection timed out";
    default:
      return `network error (${code || "unknown"})`;
  }
}

function isValidHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// A safe-to-display target: the command name, the URL host (no userinfo or
// path), or a home-redacted path. Never includes credentials.
function safeTarget(rec: IntegrationRecord): string {
  if (rec.kind === "mcp" && rec.transport === "stdio") return rec.command ?? "";
  if (rec.kind === "mcp" && rec.transport === "http" && rec.url) {
    try {
      return new URL(rec.url).host;
    } catch {
      return "";
    }
  }
  if (rec.kind === "extension" && rec.path) return redactPath(rec.path);
  return "";
}

export function formatHealthInventory(inv: HealthInventory): string {
  const lines: string[] = [];
  lines.push("Health Inventory");
  lines.push("─".repeat(40));
  lines.push(`Settings:      ${redactPath(inv.settingsPath)}`);
  lines.push(`Probe timeout: ${inv.probeTimeoutMs}ms`);

  if (!inv.settingsFound) {
    lines.push("");
    lines.push("No settings file found; no integrations configured.");
    return lines.join("\n");
  }
  if (inv.parseError) {
    lines.push("");
    lines.push(`Settings error: ${inv.parseError}`);
    return lines.join("\n");
  }
  if (inv.integrations.length === 0) {
    lines.push("");
    lines.push("No integrations configured.");
    return lines.join("\n");
  }

  const mcp = inv.integrations.filter((i) => i.kind === "mcp");
  const ext = inv.integrations.filter((i) => i.kind === "extension");

  if (mcp.length > 0) {
    lines.push("");
    lines.push("MCP servers:");
    for (const i of mcp) lines.push("  " + formatLine(i));
  }
  if (ext.length > 0) {
    lines.push("");
    lines.push("Extensions:");
    for (const i of ext) lines.push("  " + formatLine(i));
  }

  const counts: Record<HealthCategory, number> = {
    healthy: 0,
    unavailable: 0,
    misconfigured: 0,
    disabled: 0,
  };
  for (const i of inv.integrations) counts[i.category]++;
  lines.push("");
  lines.push(
    `Summary: ${counts.healthy} healthy, ${counts.unavailable} unavailable, ` +
      `${counts.disabled} disabled, ${counts.misconfigured} misconfigured ` +
      `(${inv.integrations.length} total)`,
  );

  return lines.join("\n");
}

function formatLine(i: IntegrationHealth): string {
  const symbol = SYMBOLS[i.category];
  const label = i.transport ?? (i.kind === "extension" ? "path" : "");
  const target = redactSecrets(i.target).text;
  const descriptor = label ? (target ? ` (${label}: ${target})` : ` (${label})`) : "";
  const reason = redactSecrets(i.reason).text;
  const timing = i.probeMs !== null ? ` [${i.probeMs}ms]` : "";
  return `${symbol} ${i.name}${descriptor} — ${i.category} [${reason}]${timing}`;
}

function redactPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
