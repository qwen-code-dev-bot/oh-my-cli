import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export class SessionStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = path.join(baseDir ?? path.join(process.env.HOME ?? "/root", ".oh-my-cli", "sessions"));
    fs.mkdirSync(this.dir, { recursive: true });
  }

  newId(): string {
    return crypto.randomUUID();
  }

  filePath(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  append(id: string, message: SessionMessage): void {
    const line = JSON.stringify(message) + "\n";
    fs.appendFileSync(this.filePath(id), line, "utf-8");
  }

  load(id: string): SessionMessage[] {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, "utf-8");
    const lines = raw.split("\n");
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Tolerate one incomplete trailing line after crash
        if (i < lines.length - 1) {
          // Non-trailing bad line: skip it
        }
        // Trailing bad line: ignore
      }
    }
    return messages;
  }
}
