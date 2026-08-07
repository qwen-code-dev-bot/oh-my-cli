// Headless prompt resolution (Issues #759, #761, #763). `-p`/`--prompt`
// accepts its value as an argument or — when the value is omitted — from
// piped stdin, the composition pattern every trusted coding CLI supports
// (`git diff | cli -p`). When BOTH are present the pipe carries context
// for the instruction: one combined prompt, recorded verbatim (#761). The
// decisions here are pure so the wiring in index.ts stays a thin reader;
// errors are honest and bounded: a TTY cannot be a pipe, an empty pipe is
// not a prompt, and neither is a whitespace-only argument (#763).

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

// A prompt argument plus piped stdin is one request (#761): the instruction
// first, a blank line, then the piped content — the ordering trusted coding
// CLIs use for `cat thing | cli -p "instruction"`. A null pipe (absent,
// empty, or whitespace-only) conveys nothing and the argument stands alone.
export function combinePromptAndStdin(value: string, stdinText: string | null): string {
  if (stdinText === null) return value;
  return `${value}\n\n${stdinText}`;
}

// A prompt that is empty by content cannot mean anything (#763): it must
// become one honest error instead of a provider call — the piped path has
// rejected the identical emptiness since #759. Content with surrounding
// whitespace is real and stays verbatim; only content-less values are
// rejected. Returns the error message, or null when the value is usable.
export function promptValueError(value: string): string | null {
  if (value.trim() === "") {
    return "Error: the prompt is empty — pass text with -p or pipe it in.";
  }
  return null;
}
