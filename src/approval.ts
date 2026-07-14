import readline from "node:readline";
import { analyzeImpact, formatImpact } from "./permission-impact.js";

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
  const summary = formatImpact(analyzeImpact(toolName, args));
  return new Promise((resolve) => {
    rl.question(`\n⚠ Tool "${toolName}" requires approval.\n${summary}\nAllow? (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}
