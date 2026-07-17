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

// Read-only classification of a session's canonical checkpoint.
export type SessionIntegrityStatus = "ok" | "partial" | "corrupt" | "missing";

export interface SessionIntegrity {
  status: SessionIntegrityStatus;
  messageCount: number;
  badLines: number;
}

// Outcome of a deterministic recovery attempt for a single session.
export type RecoveryAction = "none" | "promoted-temp" | "discarded-temp" | "quarantined";

export interface RecoveryResult {
  action: RecoveryAction;
  ok: boolean;
  detail: string;
  /** Set when a corrupt canonical was moved aside; the original bytes live here. */
  quarantinePath?: string;
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

  // Sibling temp file used for atomic checkpoint writes. Same directory as the
  // canonical file so the final rename stays on one filesystem and is atomic.
  tempPath(id: string): string {
    return this.filePath(id) + ".tmp";
  }

  // Sibling sidecar holding a compaction summary. A distinct extension keeps it
  // out of listIds() (which matches *.jsonl) so a compacted session is still
  // enumerated exactly once.
  compactPath(id: string): string {
    return path.join(this.dir, `${id}.compact.json`);
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

  // Atomically replace a session's checkpoint with meta + messages. The whole
  // content is written to a sibling temp file and then renamed over the
  // canonical path, so a crash before the rename leaves the previous checkpoint
  // intact and a crash after it leaves the new one — never a half-written file.
  // Unlike append(), this fully supersedes prior content.
  checkpoint(
    id: string,
    messages: SessionMessage[],
    meta: SessionMeta | Omit<SessionMeta, "meta"> | null = null,
  ): void {
    const fp = this.filePath(id);
    const tmp = this.tempPath(id);
    const lines: string[] = [];
    if (meta) {
      const full: Record<string, unknown> = { ...(meta as SessionMeta) };
      delete full.meta;
      lines.push(JSON.stringify({ meta: true, ...full }));
    }
    for (const message of messages) {
      lines.push(JSON.stringify(message));
    }
    const data = lines.length > 0 ? lines.join("\n") + "\n" : "";
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, fp);
  }

  load(id: string): SessionMessage[] {
    return this.loadWithDiagnostics(id).messages;
  }

  // Read a session, separating conversation messages from its metadata line and
  // reporting corruption. A single trailing incomplete line (a crash mid-write)
  // is tolerated and does not mark the session corrupt; any other unparseable
  // line does. Reading never mutates the file.
  loadWithDiagnostics(id: string): SessionDiagnostics {
    return this.diagnosePath(this.filePath(id));
  }

  // Diagnose an arbitrary JSONL file. Shared by load and recovery so a canonical
  // file and an interrupted-checkpoint temp are judged by identical rules.
  private diagnosePath(fp: string): SessionDiagnostics {
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

  // Classify a session's canonical checkpoint without mutating it. A single
  // trailing incomplete line is "partial" (recoverable by load); any other
  // unparseable line is "corrupt".
  integrity(id: string): SessionIntegrity {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) {
      return { status: "missing", messageCount: 0, badLines: 0 };
    }
    const diag = this.loadWithDiagnostics(id);
    if (diag.corrupt) {
      return { status: "corrupt", messageCount: diag.messages.length, badLines: diag.badLines };
    }
    if (diag.badLines > 0) {
      return { status: "partial", messageCount: diag.messages.length, badLines: diag.badLines };
    }
    return { status: "ok", messageCount: diag.messages.length, badLines: 0 };
  }

  // Deterministically recover a single session's checkpoint. Acts only on this
  // session's own canonical and temp files; sibling sessions are never read or
  // touched. Steps:
  //   1. A complete temp left by an interrupted checkpoint is promoted.
  //   2. A partial temp (crash mid-write) is discarded.
  //   3. A corrupt canonical is quarantined (renamed aside, never deleted) so
  //      the operator can inspect it; the session then starts fresh.
  // Re-running is safe: once healed, a second call reports no action.
  recover(id: string): RecoveryResult {
    const fp = this.filePath(id);
    const tmp = this.tempPath(id);

    if (fs.existsSync(tmp)) {
      const tempDiag = this.diagnosePath(tmp);
      const tempComplete =
        tempDiag.badLines === 0 && (tempDiag.messages.length > 0 || tempDiag.meta !== null);
      if (tempComplete) {
        fs.renameSync(tmp, fp);
        return {
          action: "promoted-temp",
          ok: true,
          detail: "promoted a complete checkpoint left by an interrupted write",
        };
      }
      // A partial or empty temp is not a usable session; dropping it is safe.
      fs.rmSync(tmp, { force: true });
      if (fs.existsSync(fp) && this.loadWithDiagnostics(id).corrupt) {
        return this.quarantine(fp);
      }
      return {
        action: "discarded-temp",
        ok: true,
        detail: "discarded a partial checkpoint left by an interrupted write",
      };
    }

    if (fs.existsSync(fp) && this.loadWithDiagnostics(id).corrupt) {
      return this.quarantine(fp);
    }

    return { action: "none", ok: true, detail: "no recovery needed" };
  }

  // Move a corrupt canonical aside without deleting it. The timestamped name
  // keeps repeated quarantines distinct and preserves the original bytes.
  private quarantine(fp: string): RecoveryResult {
    const quarantinePath = `${fp}.corrupt-${Date.now()}`;
    fs.renameSync(fp, quarantinePath);
    return {
      action: "quarantined",
      ok: true,
      detail: `isolated a corrupt checkpoint as ${path.basename(quarantinePath)}`,
      quarantinePath,
    };
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
