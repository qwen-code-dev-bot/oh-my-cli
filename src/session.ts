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

// Lightweight provenance recorded as the first line of a session so a lister
// can show which model and repository a session belongs to without replaying
// it. It is not a conversation message and is never fed to the model.
export interface SessionMeta {
  meta: true;
  model?: string;
  workspace?: string;
  createdAt: number;
}

export interface SessionDiagnostics {
  messages: SessionMessage[];
  meta: SessionMeta | null;
  /** True when lines other than a single trailing incomplete line failed to parse. */
  corrupt: boolean;
  badLines: number;
}

function isMetaLine(value: unknown): value is SessionMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { meta?: unknown }).meta === true &&
    typeof (value as { createdAt?: unknown }).createdAt === "number"
  );
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

  // Record provenance as the first line of a brand-new session. Best-effort:
  // a failure here must never break the session write path.
  writeMeta(id: string, meta: Omit<SessionMeta, "meta">): void {
    try {
      const line = JSON.stringify({ meta: true, ...meta }) + "\n";
      fs.writeFileSync(this.filePath(id), line, { flag: "a" });
    } catch {
      /* metadata is advisory only */
    }
  }

  load(id: string): SessionMessage[] {
    return this.loadWithDiagnostics(id).messages;
  }

  // Read a session, separating conversation messages from its metadata line and
  // reporting corruption. A single trailing incomplete line (a crash mid-write)
  // is tolerated and does not mark the session corrupt; any other unparseable
  // line does. Reading never mutates the file.
  loadWithDiagnostics(id: string): SessionDiagnostics {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) {
      return { messages: [], meta: null, corrupt: false, badLines: 0 };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(fp, "utf-8");
    } catch {
      return { messages: [], meta: null, corrupt: true, badLines: 0 };
    }

    const lines = raw.split("\n");
    let lastNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) lastNonEmpty = i;
    }

    const messages: SessionMessage[] = [];
    let meta: SessionMeta | null = null;
    let badLines = 0;
    const badAt: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        badLines++;
        badAt.push(i);
        continue;
      }
      if (isMetaLine(parsed)) {
        if (!meta) meta = parsed;
        continue;
      }
      messages.push(parsed as SessionMessage);
    }

    const onlyTrailingBad = badAt.length === 1 && badAt[0] === lastNonEmpty;
    const corrupt = badLines > 0 && !onlyTrailingBad;
    return { messages, meta, corrupt, badLines };
  }

  readMeta(id: string): SessionMeta | null {
    return this.loadWithDiagnostics(id).meta;
  }

  // Enumerate session ids present in the store (file name without extension).
  listIds(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .filter((id) => id.length > 0);
  }
}
