export interface PaletteCommand {
  name: string;
  description: string;
  action: () => Promise<void> | void;
}

export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query) return commands;
  const lower = query.toLowerCase();
  return commands.filter(
    (c) => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower),
  );
}

const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const MOVE_UP = (n: number) => `${ESC}${n}A`;

export interface PaletteResult {
  selected: PaletteCommand | null;
  cancelled: boolean;
}

export async function runPalette(
  commands: PaletteCommand[],
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<PaletteResult> {
  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let filtered = filterCommands(commands, query);
    const maxVisible = 8;

    function render() {
      const lines: string[] = [];
      lines.push(`${BOLD}⌘ Command Palette${RESET}  ${DIM}↑↓ navigate · Enter run · Esc close${RESET}`);
      lines.push(`  ${DIM}> ${RESET}${query}${CLEAR_LINE}`);
      lines.push("");

      if (filtered.length === 0) {
        lines.push(`  ${DIM}No matching commands${RESET}`);
      } else {
        const start = Math.max(0, selected - maxVisible + 1);
        const end = Math.min(filtered.length, start + maxVisible);
        for (let i = start; i < end; i++) {
          const cmd = filtered[i];
          const marker = i === selected ? `${BOLD}▸ ` : "  ";
          const nameStyle = i === selected ? BOLD : "";
          lines.push(`${marker}${nameStyle}${cmd.name}${RESET}  ${DIM}${cmd.description}${RESET}${CLEAR_LINE}`);
        }
        if (filtered.length > maxVisible) {
          lines.push(`  ${DIM}… and ${filtered.length - maxVisible} more${RESET}`);
        }
      }

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
        if (selected > 0) selected--;
        render();
        return;
      }

      // Arrow down
      if (key === "\x1b[B" || key === "\x1bOB") {
        if (selected < filtered.length - 1) selected++;
        render();
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        filtered = filterCommands(commands, query);
        selected = 0;
        render();
        return;
      }

      // Printable character
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
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
    { name: "/new", description: "Start a new conversation session", action: async () => {} },
    { name: "/resume", description: "Resume a previous session by ID", action: async () => {} },
    { name: "/clear", description: "Clear the terminal screen", action: () => { process.stdout.write("\x1b[2J\x1b[H"); } },
    { name: "/help", description: "Show available commands and options", action: async () => {} },
    { name: "/exit", description: "Exit the interactive session", action: () => { process.exit(0); } },
    { name: "/approval-mode default", description: "Require approval for all mutating tools", action: async () => {} },
    { name: "/approval-mode auto-edit", description: "Auto-approve write/edit, prompt for shell", action: async () => {} },
    { name: "/approval-mode yolo", description: "Auto-approve all tools (unsafe)", action: async () => {} },
    { name: "/status", description: "Show current session and workspace info", action: async () => {} },
  ];
}
