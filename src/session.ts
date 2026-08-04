import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseTaskSnapshot, serializeTaskSnapshot } from "./task-runtime.js";
import type { TaskSnapshot } from "./task-runtime.js";

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  // Marks an assistant turn whose provider stream failed after emitting text
  // (#243). The partial content is preserved durably but the turn is incomplete;
  // it is never reported as a successful final answer. Absent on normal turns.
  interrupted?: boolean;
  // Multimodal image attachments on a user message. Only a non-secret reference
  // (name, media type, size) is persisted; the data URL (raw bytes) lives solely
  // in the in-memory transcript sent to the provider and is stripped before this
  // message reaches the session log.
  images?: Array<{ name: string; mediaType: string; bytes: number; dataUrl?: string }>;
}

// Lightweight provenance recorded as the first line of a session so a lister
// can show which model and repository a session belongs to without replaying
// it. It is not a conversation message and is never fed to the model. The
// optional `profile` records the named model profile (settings.profiles key) the
// session was created under, so a resumed run can detect and explain a profile or
// model change. Like `model`, it is a non-secret identifier, never a credential.
export interface SessionMeta {
  meta: true;
  model?: string;
  profile?: string;
  workspace?: string;
  createdAt: number;
  // Set on sessions created by `--salvage-session` (Issue #546): the id of
  // the corrupt session whose recoverable prefix this session carries.
  salvagedFrom?: string;
  // Set on sessions created by `--fork-session` (Issue #592): the id of the
  // healthy session this one branched from. Like `salvagedFrom`, a
  // non-secret identifier pointing at the provenance transcript.
  forkedFrom?: string;
}

export interface SessionGoal {
  objective: string;
  status: "active" | "paused" | "achieved";
  createdAt: number;
  updatedAt: number;
  // Optional concise label for compact surfaces (Issue #586). The objective
  // remains the authoritative execution instruction.
  title?: string;
}

/**
 * One immutable Goal lifecycle transition (Issue #580). `kind` names the
 * runGoalCommand transition that produced the entry; `legacy` appears only in
 * entries synthesized for display from pre-history sidecars and is never
 * written by a transition. `title` (Issue #586) is an annotation: it records
 * a title set or cleared without bumping the revision or changing the status.
 */
export type GoalHistoryKind = "set" | "pause" | "resume" | "achieve" | "clear" | "title" | "legacy";

export interface GoalHistoryEntry {
  revision: number;
  kind: GoalHistoryKind;
  /** Objective at this transition, or null for `clear`. */
  objective: string | null;
  /** Goal status after the transition, or null for `clear`. */
  status: "active" | "paused" | "achieved" | null;
  at: number;
}

export interface SessionGoalCheckpoint {
  revision: number;
  goal: SessionGoal | null;
  // Append-only lifecycle history (Issue #580). Absent on sidecars written
  // before history tracking; readers synthesize a single display entry for
  // those and never write the synthesis back.
  history?: GoalHistoryEntry[];
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

function isSessionGoal(value: unknown): value is SessionGoal {
  if (typeof value !== "object" || value === null) return false;
  const goal = value as Partial<SessionGoal>;
  return (
    typeof goal.objective === "string" &&
    (goal.status === "active" || goal.status === "paused" || goal.status === "achieved") &&
    typeof goal.createdAt === "number" &&
    typeof goal.updatedAt === "number" &&
    (goal.title === undefined || typeof goal.title === "string")
  );
}

const GOAL_HISTORY_KINDS: readonly GoalHistoryKind[] = [
  "set",
  "pause",
  "resume",
  "achieve",
  "clear",
  "title",
  "legacy",
];

function isGoalHistoryEntry(value: unknown): value is GoalHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<GoalHistoryEntry>;
  return (
    typeof entry.revision === "number" &&
    entry.revision >= 0 &&
    typeof entry.kind === "string" &&
    (GOAL_HISTORY_KINDS as readonly string[]).includes(entry.kind) &&
    (entry.objective === null || typeof entry.objective === "string") &&
    (entry.status === null ||
      entry.status === "active" ||
      entry.status === "paused" ||
      entry.status === "achieved") &&
    typeof entry.at === "number"
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

  goalPath(id: string): string {
    return path.join(this.dir, `${id}.goal.json`);
  }

  readGoal(id: string): SessionGoalCheckpoint {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.goalPath(id), "utf-8")) as Partial<SessionGoalCheckpoint>;
      if (
        typeof parsed.revision !== "number" ||
        parsed.revision < 0 ||
        (parsed.goal !== null && !isSessionGoal(parsed.goal))
      ) {
        return { revision: 0, goal: null };
      }
      // History validation (Issue #580): an absent history field is a legacy
      // sidecar (readers synthesize a display entry); a present-but-corrupt
      // array fails closed exactly like a corrupt sidecar — honest no-goal,
      // bytes preserved — because the append-only evidence chain is broken.
      if (parsed.history !== undefined) {
        if (!Array.isArray(parsed.history) || !parsed.history.every(isGoalHistoryEntry)) {
          return { revision: 0, goal: null };
        }
        return { revision: parsed.revision, goal: parsed.goal ?? null, history: parsed.history };
      }
      return { revision: parsed.revision, goal: parsed.goal ?? null };
    } catch {
      return { revision: 0, goal: null };
    }
  }

  writeGoal(id: string, checkpoint: SessionGoalCheckpoint): void {
    const target = this.goalPath(id);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(checkpoint)}\n`, "utf-8");
    fs.renameSync(temp, target);
  }

  // Sidecar holding a user-owned session name (#249). A distinct extension keeps
  // it out of listIds() (which matches *.jsonl). The name is bounded user
  // metadata, validated by normalizeSessionName before it is written; the
  // transcript history is never touched.
  namePath(id: string): string {
    return path.join(this.dir, `${id}.name.json`);
  }

  // Read a session's user-owned name, or null when none is set (or the sidecar is
  // missing/unreadable). Reading never mutates the file.
  readName(id: string): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.namePath(id), "utf-8")) as { name?: unknown };
      return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
    } catch {
      return null;
    }
  }

  // Persist a user-owned session name atomically (temp + rename), or clear the
  // override when `name` is null. Only the name sidecar is written; transcript
  // bytes are never modified.
  writeName(id: string, name: string | null): void {
    const target = this.namePath(id);
    if (name === null) {
      fs.rmSync(target, { force: true });
      return;
    }
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ name })}\n`, "utf-8");
    fs.renameSync(temp, target);
  }

  // Sidecar holding a session's archive marker (Issue #598). A distinct
  // extension keeps it out of listIds() (which matches *.jsonl). Like the
  // name sidecar, the marker is integrity-agnostic metadata: it works on
  // corrupt sessions and never touches transcript bytes.
  archivedPath(id: string): string {
    return path.join(this.dir, `${id}.archived.json`);
  }

  // Read a session's archive marker, or null when the session is not
  // archived (or the sidecar is missing/unreadable). Reading never mutates.
  readArchived(id: string): { archived: true; at: number } | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.archivedPath(id), "utf-8")) as {
        archived?: unknown;
        at?: unknown;
      };
      if (parsed.archived !== true) return null;
      return { archived: true, at: typeof parsed.at === "number" ? parsed.at : 0 };
    } catch {
      return null;
    }
  }

  // Atomically persist the archive marker with its timestamp (temp + rename).
  writeArchived(id: string, at: number): void {
    const target = this.archivedPath(id);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ archived: true, at })}\n`, "utf-8");
    fs.renameSync(temp, target);
  }

  // Remove the archive marker (unarchive). Absent markers are a no-op.
  clearArchived(id: string): void {
    fs.rmSync(this.archivedPath(id), { force: true });
  }

  // Sidecar holding a session's durable background-task receipts. A distinct
  // extension keeps it out of listIds() (which matches *.jsonl). The persisted
  // form carries only redacted fields and opaque evidence digests — never task
  // content or secrets.
  tasksPath(id: string): string {
    return path.join(this.dir, `${id}.tasks.json`);
  }

  // Read a session's durable task snapshot, or null when none exists. A missing
  // file is honest (no recorded background tasks); a malformed or stale sidecar
  // is refused (fail closed) rather than presented as current.
  readTasks(id: string): TaskSnapshot | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.tasksPath(id), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
    try {
      return parseTaskSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  // Atomically persist a session's durable task snapshot (write to a sibling
  // temp file, then rename) so a crash never leaves a half-written sidecar.
  writeTasks(id: string, snapshot: TaskSnapshot): void {
    const target = this.tasksPath(id);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, serializeTaskSnapshot(snapshot) + "\n", "utf-8");
    fs.renameSync(temp, target);
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

  // Remove a session's canonical checkpoint and every sibling sidecar (temp,
  // compaction summary, goal, user-owned name, task receipts). Each path is
  // derived from the same id, so sibling sessions are never touched. Missing
  // files are ignored; deleting an unknown id is a no-op. Ids that could
  // escape the store directory are rejected because deletion is destructive.
  deleteSession(id: string): void {
    if (typeof id !== "string" || !id || /[/\\]/.test(id) || id.includes("\0")) {
      throw new Error("Invalid session id");
    }
    for (const target of [
      this.filePath(id),
      this.tempPath(id),
      this.compactPath(id),
      this.goalPath(id),
      this.namePath(id),
      this.tasksPath(id),
    ]) {
      fs.rmSync(target, { force: true });
    }
  }
}
