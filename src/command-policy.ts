// Deterministic, offline pre-execution policy for shell commands.
//
// The agent's shell tool runs an arbitrary `/bin/bash -c <command>`. Before a
// command executes we want a fast, dependency-free decision that:
//   1. distinguishes trusted built-in commands from commands that originate in
//      an untrusted repository or Issue ("provenance"), and
//   2. classifies what the command will do (network, writes, credential access,
//      destructive Git, path escape) and
//   3. denies a small set of known-dangerous shapes without running them,
//      naming the violated rule.
//
// This is intentionally NOT a general shell parser. It is a bounded,
// quote/substitution-aware tokenizer over the already-compiled command string,
// good enough to catch the dangerous shapes the approval prompt cannot reason
// about on its own. A denial here cannot be bypassed by approval mode (see the
// wiring in agent.ts): yolo still skips the interactive prompt, but never the
// policy gate.
//
// Everything emitted is redacted: secrets are masked and the host home path is
// collapsed to ~ so the decision can be logged or shared safely.

import path from "node:path";
import { redactSecrets, redactHomePath, neutralizeSpoofing } from "./permission-impact.js";

export const COMMAND_POLICY_SCHEMA = "oh-my-cli.command-policy" as const;
export const COMMAND_POLICY_VERSION = 1 as const;

// Where a command came from. "builtin" commands (the agent's own trusted
// vocabulary) are classified but never denied; "repository"/"issue" commands are
// untrusted and subject to the denial rules.
export type CommandProvenance = "builtin" | "repository" | "issue";

export interface CommandClassifications {
  network: boolean;
  write: boolean;
  credential: boolean;
  destructiveGit: boolean;
  pathEscape: boolean;
}

export type PolicyRuleId =
  | "destructive_git"
  | "credential_access"
  | "path_escape"
  | "destructive_removal"
  | "device_overwrite";

export interface PolicyViolation {
  rule: PolicyRuleId;
  detail: string;
}

export interface CommandPolicyDecision {
  schema: typeof COMMAND_POLICY_SCHEMA;
  v: typeof COMMAND_POLICY_VERSION;
  allowed: boolean;
  provenance: CommandProvenance;
  command: string;
  classifications: CommandClassifications;
  violations: PolicyViolation[];
}

export interface CommandPolicyOptions {
  provenance?: CommandProvenance;
  workspace?: string;
}

const MAX_PREVIEW = 300;

// Command wrappers that do not change what the underlying program does; we skip
// them so `sudo rm -rf /` is judged as `rm`.
const WRAPPERS = new Set([
  "sudo", "doas", "nohup", "time", "env", "command", "exec",
  "stdbuf", "nice", "ionice", "setsid",
]);

// Commands that read file contents (used to flag credential reads / exfil).
const READ_CMDS = new Set([
  "cat", "bat", "head", "tail", "less", "more", "nl", "od", "xxd",
  "strings", "cp", "mv", "dd", "source", "awk", "sed", "grep", "rg",
  "ag", "open", "scp", "rsync", "tar", "zip", "base64", "tr", "cut", "rev",
]);

// Commands that create/modify filesystem state.
const WRITE_CMDS = new Set([
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "ln", "tee", "dd", "truncate", "install", "shred", "sed", "patch",
]);

// Network-capable single tokens.
const NET_TOKENS = [
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat",
  "telnet", "ftp", "lftp", "kubectl", "helm", "gcloud", "aws", "socat",
];
const NET_TOKEN_RE = new RegExp(`\\b(${NET_TOKENS.join("|")})\\b`);
const NET_MULTI = [
  "git push", "git pull", "git fetch", "git clone",
  "npm publish", "npm install", "npm i ",
  "yarn publish", "pnpm publish", "docker push",
  "pip install", "pip3 install",
];
const URL_SCHEME_RE = /\b(?:https?|ftp):\/\//;

// Paths that commonly hold credentials. Matched against a path token, so the
// surrounding directory is preserved for the (redacted) explanation. Suffix
// extensions (.env, .pem, .key) match anywhere in a filename; named files
// (.ssh/, id_rsa, .netrc, …) must occupy a whole path segment.
const CRED_PATH_RE = new RegExp(
  [
    "(^|/)\\.ssh(/|$)",
    "(^|/)id_(rsa|dsa|ecdsa|ed25519)\\b",
    "(^|/)[^/]*\\.env(\\b|\\.|$)",
    "(^|/)\\.aws/credentials",
    "(^|/)(\\.netrc|\\.npmrc|\\.pgpass|\\.htpasswd|\\.git-credentials)\\b",
    "(^|/)\\.docker/config\\.json",
    "(^|/)\\.kube/config",
    "(^|/)[^/]*\\.(pem|key)\\b",
    "(^|/)credentials\\b",
    "/etc/shadow\\b",
  ].join("|"),
  "i",
);

// Environment variable names that bear secrets.
const SECRET_VAR_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|APIKEY|API_KEY)/i;

/**
 * Evaluate a command string against the policy. Pure and synchronous: it never
 * executes anything and never touches the filesystem (path-escape uses pure
 * path arithmetic against the supplied workspace).
 */
export function evaluateCommandPolicy(
  command: string,
  opts: CommandPolicyOptions = {},
): CommandPolicyDecision {
  const provenance = opts.provenance ?? "repository";
  const workspace = opts.workspace ? path.resolve(opts.workspace) : undefined;

  const classifications: CommandClassifications = {
    network: false,
    write: false,
    credential: false,
    destructiveGit: false,
    pathEscape: false,
  };
  const violations: PolicyViolation[] = [];
  const seen = new Set<PolicyRuleId>();
  const addViolation = (rule: PolicyRuleId, detail: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    violations.push({ rule, detail: neutralizeSpoofing(redactSecrets(detail).text).text });
  };

  for (const seg of splitSegments(command)) {
    const n = normalizeSegment(seg);
    if (!n.exe) continue;

    const argvPaths = n.argv.filter((a) => !a.startsWith("-")).map(stripQuotes);
    const outTargets = redirectTargets(seg).map(stripQuotes);
    const inTargets = inputRedirectTargets(seg).map(stripQuotes);

    // Classifications are always computed (even for builtin provenance).
    if (detectsNetwork(seg)) classifications.network = true;
    if (WRITE_CMDS.has(n.exe) || outTargets.length > 0) classifications.write = true;

    const credHit = findCredential(n.exe, [...argvPaths, ...inTargets]);
    const secretEnv = matchSecretEnv(n);
    if (credHit || secretEnv) classifications.credential = true;

    if (matchDestructiveGit(n)) classifications.destructiveGit = true;

    const escapeTokens = [...argvPaths, ...outTargets];
    if (workspace && escapeTokens.some((t) => isOutsideWorkspace(t, workspace))) {
      classifications.pathEscape = true;
    }

    // Denial rules apply only to untrusted provenance.
    if (provenance === "builtin") continue;

    const git = matchDestructiveGit(n);
    if (git) addViolation("destructive_git", git);

    if (credHit) addViolation("credential_access", credHit);
    if (secretEnv) addViolation("credential_access", secretEnv);

    if (workspace) {
      const writeOut = outTargets.find((t) => isOutsideWorkspace(t, workspace));
      if (writeOut) {
        addViolation("path_escape", `redirects output outside the workspace: ${redactPathToken(writeOut)}`);
      }
      if (WRITE_CMDS.has(n.exe)) {
        const writeArg = argvPaths.find((t) => isOutsideWorkspace(t, workspace));
        if (writeArg) {
          addViolation("path_escape", `${n.exe} writes outside the workspace: ${redactPathToken(writeArg)}`);
        }
      }
    }

    const removal = matchDestructiveRemoval(n);
    if (removal) addViolation("destructive_removal", removal);

    const device = matchDeviceOverwrite(n, outTargets);
    if (device) addViolation("device_overwrite", device);
  }

  return {
    schema: COMMAND_POLICY_SCHEMA,
    v: COMMAND_POLICY_VERSION,
    allowed: violations.length === 0,
    provenance,
    command: previewCommand(command),
    classifications,
    violations,
  };
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

// Split a command into top-level segments on `;`, `&&`, `||`, `|`, `&`, and
// newlines, then descend into command substitutions (`$(...)`, backticks) and
// subshells (`(...)`) so dangerous content hidden inside them is still judged.
function splitSegments(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      const end = close === -1 ? input.length : close + 1;
      const body = close === -1 ? input.slice(i + 1) : input.slice(i + 1, close);
      cur += input.slice(i, end);
      for (const s of splitSegments(body)) out.push(s);
      i = end;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") {
      const { body, end } = extractParen(input, i + 1);
      cur += input.slice(i, end + 1);
      for (const s of splitSegments(body)) out.push(s);
      i = end + 1;
      continue;
    }
    if (ch === "(") {
      const { body, end } = extractParen(input, i);
      cur += input.slice(i, end + 1);
      for (const s of splitSegments(body)) out.push(s);
      i = end + 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      flush();
      i++;
      continue;
    }
    if (ch === "&") {
      flush();
      i += input[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "|") {
      flush();
      i += input[i + 1] === "|" ? 2 : 1;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return out;
}

// Given input[open] === "(", return the body and index of the matching ")",
// respecting quotes and nested parens (including `$(...)`).
function extractParen(input: string, open: number): { body: string; end: number } {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      const c = input.indexOf("`", i + 1);
      i = c === -1 ? input.length : c;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return { body: input.slice(open + 1, i), end: i };
    }
  }
  return { body: input.slice(open + 1), end: input.length };
}

// Split a single segment into words on unquoted whitespace, keeping quoted
// strings and substitutions (`$(...)`, `` `...` ``, `${...}`) intact within a
// word so they are not mistaken for separate arguments or operators.
function words(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };
  while (i < seg.length) {
    const ch = seg[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      const c = seg.indexOf("`", i + 1);
      const end = c === -1 ? seg.length : c + 1;
      cur += seg.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "(") {
      const { end } = extractParen(seg, i + 1);
      cur += seg.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "{") {
      const c = seg.indexOf("}", i + 2);
      const end = c === -1 ? seg.length : c + 1;
      cur += seg.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return out;
}

// Strip leading `VAR=val` assignments and transparent wrappers to reach the
// program that actually runs, returning its name and remaining argv.
function normalizeSegment(seg: string): { exe: string; argv: string[] } {
  const toks = words(seg);
  let i = 0;
  while (i < toks.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) {
      i++;
      continue;
    }
    if (WRAPPERS.has(toks[i])) {
      i++;
      continue;
    }
    break;
  }
  return { exe: toks[i] ?? "", argv: toks.slice(i + 1) };
}

// ── Classifiers / rule matchers ──────────────────────────────────────────────

function detectsNetwork(seg: string): boolean {
  const lower = seg.toLowerCase();
  if (NET_TOKEN_RE.test(lower)) return true;
  if (URL_SCHEME_RE.test(lower)) return true;
  return NET_MULTI.some((m) => lower.includes(m));
}

// A destructive Git shape that can discard commits, rewrite history, or force
// remote state. Returns a redacted explanation or null.
function matchDestructiveGit(n: { exe: string; argv: string[] }): string | null {
  if (n.exe !== "git") return null;
  const a = n.argv;
  const has = (x: string) => a.includes(x);
  const sub = a.find((x) => !x.startsWith("-"));

  if (sub === "push") {
    const refspecs = a.filter((x) => !x.startsWith("-"));
    const forced = has("--force") || has("-f") || has("--force-with-lease") ||
      has("--delete") || has("--mirror") ||
      // A leading '+' force-updates a ref; an empty-source ':branch' deletes it.
      refspecs.some((x) => x.startsWith("+") || x.startsWith(":"));
    if (forced) return "git push --force / --delete / refspec rewrites remote history";
  }
  if (sub === "reset" && has("--hard")) {
    return "git reset --hard discards uncommitted changes";
  }
  if (sub === "clean") {
    if (a.some((x) => /^-[a-z]*[fd][a-z]*$/i.test(x))) {
      return "git clean -f/-d deletes untracked files";
    }
  }
  if (sub === "branch" && (has("-D") || has("--delete") || has("--force"))) {
    return "git branch -D force-deletes a branch";
  }
  if (sub === "checkout" && (has(".") || has("--"))) {
    return "git checkout discards working-tree changes";
  }
  if (sub === "filter-branch" || sub === "filter-repo") {
    return "git filter-branch rewrites repository history";
  }
  return null;
}

// A credential read/exfil shape: a read command touching a credential path.
function findCredential(exe: string, paths: string[]): string | null {
  const isRead = READ_CMDS.has(exe) || exe === "." || exe === "source";
  for (const p of paths) {
    if (CRED_PATH_RE.test(p)) {
      return isRead
        ? `reads a credential path: ${redactPathToken(p)}`
        : `references a credential path: ${redactPathToken(p)}`;
    }
  }
  return null;
}

// Printing secret-bearing environment variables.
function matchSecretEnv(n: { exe: string; argv: string[] }): string | null {
  if ((n.exe === "printenv" || n.exe === "set") && n.argv.some((a) => SECRET_VAR_RE.test(a))) {
    return "prints secret-bearing environment variables";
  }
  if (n.exe === "echo" && n.argv.some((a) => /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(a) && SECRET_VAR_RE.test(a))) {
    return "echoes a secret environment variable";
  }
  return null;
}

// `rm -r/-R` aimed at a root/home/relative-root target.
function matchDestructiveRemoval(n: { exe: string; argv: string[] }): string | null {
  if (n.exe !== "rm") return null;
  const recursive = n.argv.some(
    (a) => a === "--recursive" || /^-[a-z]*[rR][a-z]*$/.test(a),
  );
  if (!recursive) return null;
  const targets = n.argv.filter((a) => !a.startsWith("-")).map(stripQuotes);
  const dangerous = targets.find((t) =>
    t === "/" || t === "/*" || t === "/." ||
    t === "~" || t === "~/" || t === "~/*" ||
    t === "$HOME" || t === "${HOME}" ||
    t === "." || t === "..",
  );
  if (dangerous) return `rm -r/-R targets ${dangerous}`;
  return null;
}

// Direct device formatting/overwriting.
function matchDeviceOverwrite(
  n: { exe: string; argv: string[] },
  outTargets: string[],
): string | null {
  if (n.exe === "dd" && n.argv.some((a) => /^of=\/dev\//i.test(a))) {
    return "dd writes directly to a device";
  }
  if (outTargets.some((t) => /^\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/i.test(t))) {
    return "redirects onto a block device";
  }
  if (["mkfs", "fdisk", "parted", "wipefs"].includes(n.exe) || /^mkfs\./.test(n.exe)) {
    return "formats or partitions a disk";
  }
  return null;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function stripQuotes(t: string): string {
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') ||
      (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (p === "~") return home || p;
  if (p.startsWith("~/")) return home ? home + p.slice(1) : p;
  return p;
}

// Pure path arithmetic: does this token resolve to a location outside the
// workspace? Dynamic (unresolved) paths are treated as not-outside to avoid
// false positives on `$VAR`/`$(...)`.
function isOutsideWorkspace(token: string, workspace: string): boolean {
  const raw = expandHome(token);
  if (raw.includes("$") || raw.includes("`")) return false;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
  const rel = path.relative(workspace, abs);
  return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel));
}

// Output redirection targets: `> file`, `>> file`.
function redirectTargets(seg: string): string[] {
  const targets: string[] = [];
  const re = />{1,2}\s*([^\s;|&<>()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) targets.push(m[1]);
  return targets;
}

// Input redirection targets: `< file` (a credential could be fed in this way).
function inputRedirectTargets(seg: string): string[] {
  const targets: string[] = [];
  const re = /<\s*([^\s;|&<>()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) targets.push(m[1]);
  return targets;
}

// ── Redaction / formatting ───────────────────────────────────────────────────

function redactPathToken(p: string): string {
  return redactHomePath(p);
}

function previewCommand(cmd: string): string {
  // Redact secrets first (on the raw command), then neutralize spoofing
  // Unicode before the whitespace collapse so an invisible character such as
  // U+FEFF (which \s would otherwise silently eat) becomes an observable marker.
  const redacted = redactSecrets(cmd).text;
  const oneLine = neutralizeSpoofing(redacted).text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PREVIEW ? `${oneLine.slice(0, MAX_PREVIEW)}…` : oneLine;
}

// Human-readable rendering of a decision (used by the CLI diagnostic mode and
// the shell-tool denial message). Redacted throughout.
export function formatCommandPolicyDecision(d: CommandPolicyDecision): string {
  const lines: string[] = [];
  lines.push(`Command policy (${d.schema} v${d.v})`);
  lines.push(`  decision:     ${d.allowed ? "allow" : "deny"}`);
  lines.push(`  provenance:   ${d.provenance}`);
  lines.push(`  command:      ${d.command}`);
  const c = d.classifications;
  const flag = (b: boolean) => (b ? "yes" : "no");
  lines.push(
    `  classify:     network=${flag(c.network)} write=${flag(c.write)} ` +
      `credential=${flag(c.credential)} destructive-git=${flag(c.destructiveGit)} ` +
      `path-escape=${flag(c.pathEscape)}`,
  );
  if (d.violations.length === 0) {
    lines.push("  violations:   (none)");
  } else {
    lines.push("  violations:");
    for (const v of d.violations) {
      lines.push(`    - ${v.rule}: ${v.detail}`);
    }
  }
  return lines.join("\n");
}

// Concise one-line denial message for a tool result.
export function policyDenialMessage(d: CommandPolicyDecision): string {
  const rules = d.violations.map((v) => v.rule).join(", ");
  const first = d.violations[0]?.detail ?? "";
  return `Command denied by policy (${rules})${first ? `: ${first}` : ""}. The command was not executed.`;
}
