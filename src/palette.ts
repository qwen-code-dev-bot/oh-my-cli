export interface PaletteCommand {
  name: string;
  description: string;
  action: (args?: string) => Promise<string | void> | string | void;
  // Live availability predicate (Issue #566): returns the missing capability,
  // state, or permission when the command cannot run right now, or null when
  // it can. Absent means always available. Purely advisory UI — the execution
  // paths keep their own gates, so a predicate failure can never bypass them.
  disabled?: () => string | null;
}

// Why a command is unavailable right now (Issue #566), or null when it is
// available. A throwing predicate fails open to "available": the truth it
// reports is surfaced again by the execution-time gates it advises.
export function commandDisabledReason(command: PaletteCommand): string | null {
  if (!command.disabled) return null;
  try {
    return command.disabled() ?? null;
  } catch {
    return null;
  }
}

export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query) return [...commands];
  const lower = query.toLowerCase();
  return commands.filter(
    (c) => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower),
  );
}

export function slashPreviewQuery(text: string): string | null {
  return /^\/[^\s/]*$/.test(text) ? text.slice(1) : null;
}

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
// Erase from the cursor to the end of the line (CSI K). The code trails each
// rendered line, so a whole-line erase (CSI 2 K) would delete the line's own
// content; at the cursor's end-of-content position CSI K instead clears any
// residue from a previous longer frame — and in cleanup(), where the cursor
// sits at column 0, it still clears the full line (Issue #566 E2E surfaced
// that the original 2K form left every palette entry invisible).
const CLEAR_LINE = `${ESC}K`;
const MOVE_UP = (n: number) => `${ESC}${n}A`;

export interface PaletteStyle {
  bold: string;
  dim: string;
  reset: string;
  clearLine: string;
}

// Color (SGR) codes are conditional; line-clearing control codes are always
// present so the interactive redraw keeps working when color is disabled.
export function paletteStyle(color: boolean): PaletteStyle {
  return {
    bold: color ? `${ESC}1m` : "",
    dim: color ? `${ESC}2m` : "",
    reset: color ? `${ESC}0m` : "",
    clearLine: CLEAR_LINE,
  };
}

export interface PaletteRenderState {
  query: string;
  selected: number;
  maxVisible?: number;
  // Transient one-line notice (Issue #566): currently the reason shown when
  // the user activates a disabled command. Rendered below the query line.
  notice?: string;
}

// Pure renderer for the palette body. Extracted from the interactive loop so
// color suppression is unit-testable without a TTY.
export function renderPaletteLines(
  filtered: PaletteCommand[],
  state: PaletteRenderState,
  style: PaletteStyle,
): string[] {
  const { bold, dim, reset, clearLine } = style;
  const maxVisible = state.maxVisible ?? 8;
  const lines: string[] = [];
  lines.push(`${bold}⌘ Command Palette${reset}  ${dim}↑↓ navigate · Enter run · Esc close${reset}`);
  lines.push(`  ${dim}> ${reset}${state.query}${clearLine}`);
  if (state.notice) lines.push(`  ${dim}${state.notice}${reset}${clearLine}`);
  lines.push("");

  if (filtered.length === 0) {
    lines.push(`  ${dim}No matching commands${reset}`);
  } else {
    const start = Math.max(0, state.selected - maxVisible + 1);
    const end = Math.min(filtered.length, start + maxVisible);
    for (let i = start; i < end; i++) {
      const cmd = filtered[i];
      const marker = i === state.selected ? `${bold}▸ ` : "  ";
      const reason = commandDisabledReason(cmd);
      if (reason) {
        // Disabled entries stay visible (discoverable) but render dimmed with
        // the concrete reason — readable without color (Issue #566).
        lines.push(`${marker}${dim}${cmd.name}  ${cmd.description} — ${reason}${reset}${clearLine}`);
        continue;
      }
      const nameStyle = i === state.selected ? bold : "";
      lines.push(`${marker}${nameStyle}${cmd.name}${reset}  ${dim}${cmd.description}${reset}${clearLine}`);
    }
    if (filtered.length > maxVisible) {
      lines.push(`  ${dim}… and ${filtered.length - maxVisible} more${reset}`);
    }
  }

  return lines;
}

export interface PaletteResult {
  selected: PaletteCommand | null;
  cancelled: boolean;
}

export async function runPalette(
  commands: PaletteCommand[],
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  opts: { color?: boolean } = {},
): Promise<PaletteResult> {
  return new Promise((resolve) => {
    const style = paletteStyle(opts.color ?? true);
    let query = "";
    let selected = 0;
    let notice = "";
    let filtered = filterCommands(commands, query);
    const maxVisible = 8;

    function render() {
      const lines = renderPaletteLines(
        filtered,
        { query, selected, maxVisible, ...(notice ? { notice } : {}) },
        style,
      );
      const totalLines = lines.length;
      stdout.write(`${MOVE_UP(renderedLines)}${lines.join("\n")}\n`);
      renderedLines = totalLines;
    }

    let renderedLines = 0;

    // Initial render
    stdout.write(HIDE_CURSOR);
    render();

    function cleanup() {
      stdout.write(SHOW_CURSOR);
      // Clear palette output
      stdout.write(`${MOVE_UP(renderedLines)}${CLEAR_LINE}`);
      for (let i = 1; i < renderedLines; i++) {
        stdout.write(`${MOVE_UP(1)}${CLEAR_LINE}`);
      }
    }

    function onKey(data: Buffer) {
      const key = data.toString();

      // Escape or Ctrl+C
      if (key === "\x1b" || key === "\x03") {
        cleanup();
        stdin.setRawMode(false);
        stdin.removeListener("data", onKey);
        resolve({ selected: null, cancelled: true });
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (filtered.length > 0 && selected < filtered.length) {
          const target = filtered[selected];
          const reason = commandDisabledReason(target);
          if (reason) {
            // Activating a disabled command surfaces its reason instead of
            // executing; the palette stays open (Issue #566).
            notice = `${target.name} unavailable — ${reason}`;
            render();
            return;
          }
        }
        cleanup();
        stdin.setRawMode(false);
        stdin.removeListener("data", onKey);
        if (filtered.length > 0 && selected < filtered.length) {
          resolve({ selected: filtered[selected], cancelled: false });
        } else {
          resolve({ selected: null, cancelled: true });
        }
        return;
      }

      // Arrow up
      if (key === "\x1b[A" || key === "\x1bOA") {
        notice = "";
        if (selected > 0) selected--;
        render();
        return;
      }

      // Arrow down
      if (key === "\x1b[B" || key === "\x1bOB") {
        notice = "";
        if (selected < filtered.length - 1) selected++;
        render();
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        notice = "";
        query = query.slice(0, -1);
        filtered = filterCommands(commands, query);
        selected = 0;
        render();
        return;
      }

      // Printable character
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
        notice = "";
        query += key;
        filtered = filterCommands(commands, query);
        selected = 0;
        render();
        return;
      }
    }

    stdin.setRawMode(true);
    stdin.on("data", onKey);
  });
}

export function defaultCommands(): PaletteCommand[] {
  return [
    {
      // Wired to the real restart contract by the interactive entry point
      // (Issue #713). The fallback action is honest instead of hollow: a
      // surface that runs it directly is told it cannot restart the shell.
      name: "/new",
      description: "Start a new conversation session",
      action: async () => "/new runs in the interactive shell; this surface cannot start a new session.",
    },
    {
      // In-shell session switching does not exist; the description and the
      // action state exactly what is supported instead of pretending (Issue
      // #713). The interactive entry point surfaces the same text.
      name: "/resume",
      description: "Resume a session at launch (exit, then --resume <id-or-name> or --browse-sessions)",
      action: async () =>
        "In-shell session switching is not supported. Exit and resume with oh-my-cli --resume <id-or-name> or --browse-sessions.",
    },
    { name: "/clear", description: "Clear the terminal screen", action: () => { process.stdout.write("\x1b[2J\x1b[H"); } },
    { name: "/help", description: "Show available commands and options", action: async () => {} },
    { name: "/exit", description: "Exit the interactive session", action: () => { process.exit(0); } },
    {
      // Real runtime switching is wired by the interactive surfaces (Issue
      // #715): the full-screen shell intercepts the command and the readline
      // fallback replaces this entry with the same live contract. The three
      // former multi-word stubs were hollow — unreachable from typed input
      // and inert from palette selection. The fallback action stays honest:
      // a surface that runs it directly reports that it cannot switch.
      name: "/approval-mode",
      description: "View or change the approval mode (default, auto-edit, yolo)",
      action: async () =>
        "This surface cannot change the approval mode; relaunch with --approval-mode <default|auto-edit|yolo>.",
    },
    { name: "/status", description: "Show current session and workspace info", action: async () => {} },
  ];
}
