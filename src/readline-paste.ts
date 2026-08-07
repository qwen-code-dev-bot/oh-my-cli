// Multi-line paste guard for the readline surface (Issue #727). Readline
// splits one pasted input chunk into multiple line events, and the pending
// question dispatches the FIRST line as a prompt — so pasting an error trace
// or snippet silently auto-submits its first line without any Enter. These
// pure helpers let the entry point detect a paste chunk (before the
// interface splits it) and flatten it into reviewable composer text instead:
// nothing reaches the provider without an explicit submit.

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Index of the first line terminator, treating CRLF as one.
function firstTerminatorEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return i + 1;
    if (ch === "\r") return text[i + 1] === "\n" ? i + 2 : i + 1;
  }
  return -1;
}

// A chunk is a paste when it carries bracketed-paste markers or when content
// FOLLOWS the first line terminator. Typed input reaches readline one key per
// chunk (raw mode), and an Enter ends the line — typing never produces
// post-terminator content in the same chunk, while a paste of two or more
// lines always does ("first\nsecond…"). Terminator-only tails (a trailing
// newline, or a coalesced double-Enter) are NOT content and stay treated as
// typing, so a fast double-Enter keeps its submit semantics.
export function isMultilinePasteChunk(chunk: Buffer): boolean {
  if (chunk.length === 0) return false;
  const text = chunk.toString("utf8");
  if (text.includes(BRACKETED_PASTE_START) || text.includes(BRACKETED_PASTE_END)) {
    return true;
  }
  const end = firstTerminatorEnd(text);
  if (end === -1) return false;
  return /[^\r\n]/.test(text.slice(end));
}

// Flatten a pasted chunk into one composer line: strip bracketed-paste
// markers, split on terminators, trim, drop blanks, and join with single
// spaces in the original line order. True multi-line composition stays the
// full-screen shell's territory (Alt+Enter); this keeps paste content
// reviewable and submittable as one deliberate prompt.
export function flattenPastedChunk(chunk: Buffer): string {
  const text = chunk
    .toString("utf8")
    .split(BRACKETED_PASTE_START)
    .join("")
    .split(BRACKETED_PASTE_END)
    .join("");
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}
