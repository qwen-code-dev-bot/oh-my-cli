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
  neutralized: number;
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

// Spoofing Unicode that can make a displayed approval preview visually differ
// from what will actually run. Untrusted content (a file the agent read, a
// repository, an Issue, a relayed message) can embed bidirectional
// override/isolate controls, zero-width characters, or look-alike quote marks
// to reorder or disguise the visible text — a "Trojan Source"-style attack on
// the approval step. Each such character is replaced with a visible [U+XXXX]
// marker (and counted) so a spoofing attempt is observable rather than silent;
// ordinary visible ASCII/UTF-8 text is left untouched. This is the single
// shared table used by both the permission-impact preview and the command
// policy rendering.

// Bidirectional override/isolate controls and marks (U+202A–U+202E,
// U+2066–U+2069, plus the closely related LRM/RLM/ALM).
const BIDI_CONTROLS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE RLE PDF LRO RLO
  0x2066, 0x2067, 0x2068, 0x2069,         // LRI RLI FSI PDI
  0x200e, 0x200f,                         // LRM RLM
  0x061c,                                 // ALM (Arabic letter mark)
];

// Zero-width / invisible characters (U+200B–U+200D, U+2060, U+FEFF).
const ZERO_WIDTH = [
  0x200b, 0x200c, 0x200d, // ZWSP ZWNJ ZWJ
  0x2060,                 // word joiner
  0xfeff,                 // BOM / zero-width no-break space
];

// Look-alike quote characters that masquerade as ASCII ' " or `.
const LOOKALIKE_QUOTES = [
  0x2018, 0x2019, 0x201a, 0x201b, // single curly quotes
  0x201c, 0x201d, 0x201e, 0x201f, // double curly quotes
  0x2032, 0x2033, 0x2035, 0x2036, // primes / reversed primes
  0xff02, 0xff07,                 // fullwidth " and '
];

const SPOOFING_CODEPOINTS = new Set<number>([
  ...BIDI_CONTROLS,
  ...ZERO_WIDTH,
  ...LOOKALIKE_QUOTES,
]);

export function neutralizeSpoofing(input: string): { text: string; count: number } {
  let count = 0;
  let text = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (SPOOFING_CODEPOINTS.has(cp)) {
      count++;
      text += "[U+" + cp.toString(16).toUpperCase().padStart(4, "0") + "]";
    } else {
      text += ch;
    }
  }
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
    neutralized: 0,
  };

  switch (tool) {
    case "read": {
      const pl = pathList(args.path);
      impact.filesystem = { access: "read", paths: pl.paths };
      impact.neutralized += pl.neutralized;
      break;
    }
    case "write": {
      const pl = pathList(args.path);
      impact.filesystem = { access: "write", paths: pl.paths };
      impact.neutralized += pl.neutralized;
      if (isOversized(args.content)) impact.collapsed.push("content");
      break;
    }
    case "edit": {
      const pl = pathList(args.path);
      impact.filesystem = { access: "write", paths: pl.paths };
      impact.neutralized += pl.neutralized;
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
      const neutral = neutralizeSpoofing(cmd);
      cmd = neutral.text;
      impact.neutralized += neutral.count;
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
  if (impact.neutralized > 0) {
    lines.push(`  Neutralized ${impact.neutralized} spoofing Unicode character(s).`);
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

function pathList(v: unknown): { paths: string[]; neutralized: number } {
  const p = strArg(v);
  if (!p) return { paths: [], neutralized: 0 };
  const neutral = neutralizeSpoofing(redactHomePath(p));
  return { paths: [neutral.text], neutralized: neutral.count };
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

// Collapse a leading home directory to ~ so an absolute path can be shared
// (e.g. in a run summary) without leaking the host's home location.
export function redactHomePath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
