// Terminal title (Issue #785). An opt-in orientation signal: at interactive
// startup the terminal is named after the running session, so the user's
// tabs/windows/multiplexer panes tell their sessions apart. Behavior-level
// precedent: trusted terminal apps name themselves after the work in them
// (vim, htop, ssh), and the official qwen-code reference ships the same
// behavior with a session-name-first chain and multiplexer handling. Pure
// composition here; the entry point owns the single startup write.

import path from "node:path";

// BEL terminates the OSC sequence (the widely compatible terminator, matching
// the OSC 52 style already in this codebase).
const BEL = "\x07";

// Characters that must never reach the terminal inside a title: C0 control
// bytes (ESC included — no further sequences can be injected), DEL, the soft
// hyphen, and every BiDi control (LRM/RLM, embeddings/overrides, isolates)
// that could spoof what the user sees in the tab bar. Stricter than the
// fatal-boundary sanitizer on purpose: a title is one line, so tab, newline,
// and carriage return go too.
const TITLE_STRIP_RE =
  /[\u0000-\u001f\u007f\u00ad\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Sanitize title text to one safe line.
export function sanitizeTitleText(text: string): string {
  return text.replace(TITLE_STRIP_RE, "").trim();
}

// Compose the title with an honest precedence chain: the explicit user text
// wins, then the session's user-owned name, then the workspace folder
// basename, then the product default. Each link falls through when it is
// absent or unusable, so the result is never empty. The explicit text is
// fail-closed: it is accepted only when sanitization removes nothing
// (trimming aside) — text that carried control bytes or BiDi overrides is
// not displayed as a mangled remnant; the chain derives an honest title
// instead. Session names are already validated at write time, so they are
// used after plain sanitization.
export function composeTerminalTitle(opts: {
  explicitText?: string;
  sessionName?: string | null;
  workspaceRoot?: string;
}): string {
  const productDefault = "oh-my-cli";
  if (opts.explicitText !== undefined) {
    const explicit = sanitizeTitleText(opts.explicitText);
    if (explicit && explicit === opts.explicitText.trim()) return explicit;
  }
  if (opts.sessionName) {
    const name = sanitizeTitleText(opts.sessionName);
    if (name) return name;
  }
  if (opts.workspaceRoot) {
    const folder = sanitizeTitleText(path.basename(opts.workspaceRoot));
    if (folder) return `${productDefault} — ${folder}`;
  }
  return productDefault;
}

// Multiplexer environments we recognize: under a multiplexer only OSC 2
// (window title) is written so the icon-name channel does not clutter
// multiplexer window lists.
const MULTIPLEXER_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "DVTM"] as const;

export function isMultiplexerEnv(
  env: Record<string, string | undefined>,
): boolean {
  return MULTIPLEXER_ENV_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}

// Build the escape sequence(s) that set the terminal title: OSC 0 (icon name
// + window title) and OSC 2 (window title) on plain terminals; OSC 2 only
// under a multiplexer. The title must already be sanitized.
export function titleEscapeSequences(
  title: string,
  env: Record<string, string | undefined>,
): string {
  const osc2 = `\x1b]2;${title}${BEL}`;
  if (isMultiplexerEnv(env)) return osc2;
  return `\x1b]0;${title}${BEL}${osc2}`;
}
