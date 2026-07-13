import { z } from "zod";
import type { Workspace } from "./workspace.js";
import type { ApprovalMode } from "./approval.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType;
  jsonSchema: Record<string, unknown>;
  category: "read" | "mutate-file" | "mutate-shell";
  execute: (args: unknown, workspace: Workspace) => Promise<ToolResult>;
}

const ReadParams = z.object({
  path: z.string().describe("Workspace-relative file path"),
  offset: z.number().int().min(0).optional().describe("0-based line offset"),
  limit: z.number().int().min(1).optional().describe("Max lines to return"),
});

const WriteParams = z.object({
  path: z.string().describe("Workspace-relative file path"),
  content: z.string().describe("UTF-8 file content"),
});

const EditParams = z.object({
  path: z.string().describe("Workspace-relative file path"),
  oldText: z.string().describe("Exact text to find"),
  newText: z.string().describe("Replacement text"),
});

const ShellParams = z.object({
  command: z.string().describe("Bash command to execute"),
  timeout: z.number().int().min(1).max(120).optional().describe("Timeout in seconds (max 120)"),
});

export function createTools(): ToolDef[] {
  return [
    {
      name: "read",
      description: "Read a workspace-relative file with optional line offset and limit",
      parameters: ReadParams,
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          offset: { type: "number", description: "0-based line offset" },
          limit: { type: "number", description: "Max lines to return" },
        },
        required: ["path"],
      },
      category: "read",
      execute: async (args, workspace) => {
        const { path: relPath, offset, limit } = ReadParams.parse(args);
        const fs = await import("node:fs");
        const absPath = workspace.resolveSafe(relPath);
        const content = fs.readFileSync(absPath, "utf-8");
        if (offset !== undefined || limit !== undefined) {
          const lines = content.split("\n");
          const start = offset ?? 0;
          const end = limit !== undefined ? start + limit : lines.length;
          return { content: lines.slice(start, end).join("\n") };
        }
        return { content };
      },
    },
    {
      name: "write",
      description: "Create or replace a workspace-relative UTF-8 file",
      parameters: WriteParams,
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "UTF-8 file content" },
        },
        required: ["path", "content"],
      },
      category: "mutate-file",
      execute: async (args, workspace) => {
        const { path: relPath, content } = WriteParams.parse(args);
        const fs = await import("node:fs");
        const pathMod = await import("node:path");
        const absPath = workspace.resolveSafe(relPath);
        fs.mkdirSync(pathMod.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, "utf-8");
        return { content: `Wrote ${content.length} bytes to ${relPath}` };
      },
    },
    {
      name: "edit",
      description: "Replace exactly one occurrence of text in a file; fails on zero or multiple matches",
      parameters: EditParams,
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          oldText: { type: "string", description: "Exact text to find" },
          newText: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldText", "newText"],
      },
      category: "mutate-file",
      execute: async (args, workspace) => {
        const { path: relPath, oldText, newText } = EditParams.parse(args);
        const fs = await import("node:fs");
        const absPath = workspace.resolveSafe(relPath);
        const content = fs.readFileSync(absPath, "utf-8");
        const count = countOccurrences(content, oldText);
        if (count === 0) {
          return { content: "Error: oldText not found in file", isError: true };
        }
        if (count > 1) {
          return { content: `Error: oldText found ${count} times, expected exactly 1`, isError: true };
        }
        const updated = content.replace(oldText, newText);
        fs.writeFileSync(absPath, updated, "utf-8");
        return { content: `Edited ${relPath}: replaced 1 occurrence` };
      },
    },
    {
      name: "shell",
      description: "Execute a command through /bin/bash with timeout and output cap",
      parameters: ShellParams,
      jsonSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          timeout: { type: "number", description: "Timeout in seconds (max 120)" },
        },
        required: ["command"],
      },
      category: "mutate-shell",
      execute: async (args, _workspace) => {
        const { command, timeout } = ShellParams.parse(args);
        const { execSync } = await import("node:child_process");
        const timeoutMs = (timeout ?? 30) * 1000;
        const maxOutput = 1_048_576; // 1 MiB
        try {
          const output = execSync(command, {
            shell: "/bin/bash",
            timeout: timeoutMs,
            maxBuffer: maxOutput,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { content: output || "(no output)" };
        } catch (err: unknown) {
          const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string; status?: number };
          if (e.killed) {
            return { content: `Error: command timed out after ${timeoutMs / 1000}s`, isError: true };
          }
          const combined = [e.stdout ?? "", e.stderr ?? ""].join("\n").trim();
          return {
            content: `Exit code ${e.status ?? "unknown"}\n${combined || (e.message ?? "unknown error")}`,
            isError: true,
          };
        }
      },
    },
  ];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export function toolSchemasForOpenAI(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    },
  }));
}
