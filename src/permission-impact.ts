// Permission-impact preview for a single pending tool call.
//
// Produces a concise, redacted summary of what a tool call will touch
// (filesystem, network, process, external state) so a user can make an
// informed allow/deny decision without parsing raw arguments. Secrets are
// redacted and oversized payloads collapsed, but the requested target class
// (the file path, the command) is preserved.

export interface PermissionImpact {
  tool: string;
  filesystem?: { access: "read" | "write"; paths: string[] };
  process: boolean;
  network: boolean;
  externalState: string[];
  commandPreview?: string;
  collapsed: string[];
  redactions: number;
}

const MAX_PAYLOAD = 200;
const MAX_COMMAND = 160;

const NET_TOKENS = [
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat",
  "telnet", "ftp", "lftp", "ping", "dig", "nslookup", "kubectl", "helm",
  "gcloud", "aws",
];
const NET_TOKEN_RE = new RegExp(`\\b(${NET_TOKENS.join("|")})\\b`);
const NET_MULTI = [
  "git push", "git pull", "git fetch", "git clone",
  "npm publish", "npm install", "npm i ",
  "yarn publish", "pnpm publish", "docker push",
  "pip install", "pip3 install",
];
const URL_SCHEME_RE = /\b(?:https?|ftp):\/\//;

// Secret-bearing argument shapes. The flag/assignment name is preserved so the
// requested target stays visible; only the value is replaced.
const SECRET_FLAG_RE =
  /(--?(?:password|passwd|pass|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth|authorization|credential|credentials|client[_-]?secret|username|user)[=\s]+)(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi;
const ENV_SECRET_RE =
  /(\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/g;
const URL_CRED_RE = /(\/\/)[^/@\s]+:[^/@\s]+@/g;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._\-]+=*/gi;
const BASIC_RE = /\b(Basic\s+)[A-Za-z0-9._\-]+=*/gi;
const KNOWN_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function redactSecrets(input: string): { text: string; count: number } {
  let count = 0;
  let text = input;
  text = text.replace(URL_CRED_RE, (_m, p1: string) => { count++; return `${p1}[REDACTED]@`; });
  text = text.replace(BEARER_RE, (_m, p1: string) => { count++; return `${p1}[REDACTED]`; });
  text = text.replace(BASIC_RE, (_m, p1: string) => { count++; return `${p1}[REDACTED]`; });
  text = text.replace(SECRET_FLAG_RE, (_m, p1: string) => { count++; return `${p1}[REDACTED]`; });
  text = text.replace(ENV_SECRET_RE, (_m, p1: string) => { count++; return `${p1}=[REDACTED]`; });
  text = text.replace(KNOWN_TOKEN_RE, () => { count++; return "[REDACTED]"; });
  return { text, count };
}

export function analyzeImpact(tool: string, args: Record<string, unknown>): PermissionImpact {
  const impact: PermissionImpact = {
    tool,
    process: false,
    network: false,
    externalState: [],
    collapsed: [],
    redactions: 0,
  };

  switch (tool) {
    case "read": {
      impact.filesystem = { access: "read", paths: pathList(args.path) };
      break;
    }
    case "write": {
      impact.filesystem = { access: "write", paths: pathList(args.path) };
      if (isOversized(args.content)) impact.collapsed.push("content");
      break;
    }
    case "edit": {
      impact.filesystem = { access: "write", paths: pathList(args.path) };
      if (isOversized(args.oldText)) impact.collapsed.push("oldText");
      if (isOversized(args.newText)) impact.collapsed.push("newText");
      break;
    }
    case "shell": {
      impact.process = true;
      let cmd = strArg(args.command) ?? "";
      const red = redactSecrets(cmd);
      cmd = red.text;
      impact.redactions += red.count;
      if (detectsNetwork(cmd)) impact.network = true;
      const collapsed = collapseCommand(cmd);
      impact.commandPreview = collapsed.text;
      if (collapsed.collapsed) impact.collapsed.push("command");
      impact.externalState.push("Runs an arbitrary shell command; may modify files, environment, and external services.");
      break;
    }
    default: {
      // Unknown tool: do not echo raw args. Flag as opaque external state.
      impact.externalState.push("Unrecognized tool; treat as an opaque external-state change.");
      break;
    }
  }

  return impact;
}

export function formatImpact(impact: PermissionImpact): string {
  const lines: string[] = [];
  lines.push(`Permission impact for "${impact.tool}":`);

  if (impact.filesystem) {
    const paths = impact.filesystem.paths.length > 0
      ? impact.filesystem.paths.join(", ")
      : "(unspecified path)";
    lines.push(`  Filesystem (${impact.filesystem.access}): ${paths}`);
  }
  if (impact.process) {
    lines.push(`  Process: spawns a child process`);
  }
  if (impact.network) {
    lines.push(`  Network: potential network access`);
  }
  if (impact.commandPreview) {
    lines.push(`  Command: ${impact.commandPreview}`);
  }
  for (const note of impact.externalState) {
    lines.push(`  External: ${note}`);
  }
  if (impact.collapsed.length > 0) {
    lines.push(`  Collapsed (size): ${impact.collapsed.join(", ")}`);
  }
  if (impact.redactions > 0) {
    lines.push(`  Redacted ${impact.redactions} secret-like value(s).`);
  }
  if (!impact.filesystem && !impact.process && !impact.network && impact.externalState.length === 0) {
    lines.push(`  No filesystem, network, or process impact detected.`);
  }

  return lines.join("\n");
}

function strArg(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isOversized(v: unknown): boolean {
  return typeof v === "string" && v.length > MAX_PAYLOAD;
}

function pathList(v: unknown): string[] {
  const p = strArg(v);
  return p ? [redactPath(p)] : [];
}

function collapseCommand(cmd: string): { text: string; collapsed: boolean } {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_COMMAND) {
    return { text: oneLine, collapsed: false };
  }
  const remaining = oneLine.length - MAX_COMMAND;
  return { text: `${oneLine.slice(0, MAX_COMMAND)} …[+${remaining} chars]`, collapsed: true };
}

function detectsNetwork(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  if (NET_TOKEN_RE.test(lower)) return true;
  if (URL_SCHEME_RE.test(lower)) return true;
  return NET_MULTI.some((m) => lower.includes(m));
}

function redactPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
