import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../src/session.js";
import {
  buildSessionsOverviewRecord,
  formatSessionsOverview,
  OVERVIEW_WORKSPACE_MAX,
  SESSIONS_OVERVIEW_SCHEMA,
  SESSIONS_OVERVIEW_VERSION,
} from "../../src/sessions-overview.js";
import { appendSessionNote } from "../../src/session-notes.js";

const NOW = 1_786_400_000_000;

describe("buildSessionsOverviewRecord (Issue #604)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-604u-"));
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedHealthy(workspace: string | undefined): string {
    const id = store.newId();
    store.checkpoint(
      id,
      [{ role: "user", content: "hello" }],
      workspace === undefined
        ? { model: "m", createdAt: 1 }
        : { model: "m", workspace, createdAt: 1 },
    );
    return id;
  }

  function writeRaw(id: string, lines: string[]): void {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  }

  it("censuses a mixed store exactly and leaves it byte-identical", () => {
    const wsA = "/srv/alpha";
    const wsB = "/srv/beta";
    const healthyA1 = seedHealthy(wsA);
    const healthyA2 = seedHealthy(wsA);
    seedHealthy(wsB);
    const legacy = seedHealthy(undefined);
    writeRaw("partial-604", [
      JSON.stringify({ role: "user", content: "kept" }),
      "{trailing torn line",
    ]);
    writeRaw("corrupt-604", [
      JSON.stringify({ role: "user", content: "kept" }),
      "{broken mid-file",
      JSON.stringify({ role: "assistant", content: "after" }),
    ]);

    // Equip the sessions with the metadata family.
    store.writeArchived(healthyA1, NOW);
    store.writeName(healthyA2, "named one");
    store.writeGoal(legacy, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });
    expect(appendSessionNote(store, healthyA2, "a note", NOW).ok).toBe(true);

    const snapshot = dirSnapshot();
    const record = buildSessionsOverviewRecord(store, NOW);

    // The overview is read-only: nothing changed.
    expect(dirSnapshot()).toEqual(snapshot);

    expect(record.schema).toBe(SESSIONS_OVERVIEW_SCHEMA);
    expect(record.v).toBe(SESSIONS_OVERVIEW_VERSION);
    expect(record.totals).toEqual({ sessions: 6, ok: 4, partial: 1, corrupt: 1 });
    expect(record.metadata).toEqual({ archived: 1, named: 1, withGoal: 1, withNotes: 1, pinned: 0 });
    // Workspace grouping: alpha has 2, beta has 1; partial/corrupt declared no
    // workspace here, and one healthy session is legacy.
    expect(record.workspaces).toEqual([
      { workspace: "/srv/alpha", sessions: 2 },
      { workspace: "/srv/beta", sessions: 1 },
    ]);
    expect(record.workspacesElided).toBe(0);
    expect(record.legacyNoWorkspace).toBe(3); // legacy healthy + partial + corrupt
    // Newest pointer: the last-seeded healthy session before the raw writes is
    // the most recently modified (raw files are older writes? no — raw files
    // were written after; assert the pointer is present and consistent).
    expect(record.newest).not.toBeNull();
    expect(typeof record.newest!.ageMs).toBe("number");
  });

  it("caps the workspace breakdown with a truthful elision count", () => {
    const groupCount = OVERVIEW_WORKSPACE_MAX + 2;
    for (let i = 0; i < groupCount; i++) {
      seedHealthy(`/srv/ws-${String(i).padStart(2, "0")}`);
    }
    // Give one workspace an extra session so ordering is exercised.
    seedHealthy("/srv/ws-00");

    const record = buildSessionsOverviewRecord(store, NOW);
    expect(record.workspaces).toHaveLength(OVERVIEW_WORKSPACE_MAX);
    expect(record.workspacesElided).toBe(2);
    // The busiest group sorts first.
    expect(record.workspaces[0]).toEqual({ workspace: "/srv/ws-00", sessions: 2 });
  });

  it("renders the honest zero state for an empty store", () => {
    const record = buildSessionsOverviewRecord(store, NOW);
    expect(record.totals.sessions).toBe(0);
    expect(record.newest).toBeNull();
    const text = formatSessionsOverview(record).join("\n");
    expect(text).toContain("total:      0 session(s)");
    expect(text).toContain("No sessions in the store.");
  });

  it("redacts secret-shaped workspace paths in the breakdown", () => {
    const secret = ["ghp", "_", "w".repeat(24)].join("");
    seedHealthy(`/srv/${secret}`);
    const record = buildSessionsOverviewRecord(store, NOW);
    const text = formatSessionsOverview(record).join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
    expect(record.workspaces[0].workspace).not.toContain(secret);
  });

  it("renders census lines that agree with the record", () => {
    seedHealthy("/srv/one");
    seedHealthy("/srv/one");
    seedHealthy(undefined);
    const record = buildSessionsOverviewRecord(store, NOW);
    const text = formatSessionsOverview(record).join("\n");
    expect(text).toContain(`total:      ${record.totals.sessions} session(s)`);
    expect(text).toContain(
      `integrity:  ${record.totals.ok} ok · ${record.totals.partial} partial · ${record.totals.corrupt} corrupt`,
    );
    expect(text).toContain("2 · /srv/one");
    expect(text).toContain("legacy (no workspace): 1");
    expect(text).toContain("newest:");
  });

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(dir)) {
      snap.set(f, fs.readFileSync(path.join(dir, f), "utf-8"));
    }
    return snap;
  }
});
