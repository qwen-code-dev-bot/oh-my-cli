import readline from "node:readline";

export type ApprovalMode = "default" | "auto-edit" | "yolo";

export type ToolCategory = "read" | "mutate-file" | "mutate-shell";

export function needsApproval(mode: ApprovalMode, category: ToolCategory): boolean {
  if (category === "read") return false;
  if (mode === "yolo") return false;
  if (mode === "auto-edit" && category === "mutate-file") return false;
  return true;
}

export async function promptApproval(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const summary = JSON.stringify(args, null, 2).slice(0, 500);
  return new Promise((resolve) => {
    rl.question(`\n⚠ Tool "${toolName}" requires approval.\nArgs: ${summary}\nAllow? (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}
