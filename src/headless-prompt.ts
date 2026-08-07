// Headless prompt resolution (Issue #759). `-p`/`--prompt` accepts its value
// as an argument or — when the value is omitted — from piped stdin, the
// composition pattern every trusted coding CLI supports (`git diff | cli -p`).
// The decisions here are pure so the wiring in index.ts stays a thin reader;
// errors are honest and bounded: a TTY cannot be a pipe, and an empty pipe
// is not a prompt.

export type HeadlessPromptSource =
  | { kind: "value"; value: string }
  | { kind: "stdin" }
  | { kind: "error"; message: string };

// commander reports an optional-valued flag as a string when the value is
// present and boolean `true` when the flag stands alone.
export function resolveHeadlessPromptSource(
  promptOption: string | boolean | undefined,
  stdinIsTTY: boolean,
): HeadlessPromptSource {
  if (typeof promptOption === "string") {
    return { kind: "value", value: promptOption };
  }
  if (promptOption === true) {
    if (stdinIsTTY) {
      return {
        kind: "error",
        message:
          "Error: -p needs a prompt argument or piped stdin — e.g. oh-my-cli -p \"...\" or printf \"...\" | oh-my-cli -p.",
      };
    }
    return { kind: "stdin" };
  }
  return {
    kind: "error",
    message: "Error: a prompt is required (use -p or --replay-fixture).",
  };
}

// Piped stdin becomes the prompt verbatim except for surrounding whitespace
// (the shell-pipeline convention); whitespace-only input is not a prompt.
export function normalizeStdinPrompt(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}
