import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  decideFolderTrust,
  detectSandbox,
  loadTrustStore,
  saveTrustStore,
  emptyTrustStore,
  isTrusted,
  addTrusted,
  resolveFolderTrust,
  workspaceTrustKey,
  formatFolderTrust,
  folderTrustDenialMessage,
  FOLDER_TRUST_SCHEMA,
  FOLDER_TRUST_VERSION,
} from "../../src/folder-trust.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-trust-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function storePath(): string {
  return path.join(tmpDir, "trust.json");
}

describe("decideFolderTrust", () => {
  it("permits mutation when a sandbox is enforced (even if untrusted)", () => {
    const d = decideFolderTrust({ trusted: false, sandbox: "enforced", requireSandbox: false });
    expect(d.state).toBe("sandbox-enforced");
    expect(d.mutatingAllowed).toBe(true);
  });

  it("an enforced sandbox takes precedence over trust state", () => {
    const d = decideFolderTrust({ trusted: true, sandbox: "enforced", requireSandbox: true });
    expect(d.state).toBe("sandbox-enforced");
    expect(d.mutatingAllowed).toBe(true);
  });

  it("permits mutation for a trusted folder without a sandbox", () => {
    const d = decideFolderTrust({ trusted: true, sandbox: "none", requireSandbox: false });
    expect(d.state).toBe("trusted");
    expect(d.mutatingAllowed).toBe(true);
  });

  it("fails closed for an untrusted folder", () => {
    const d = decideFolderTrust({ trusted: false, sandbox: "none", requireSandbox: false });
    expect(d.state).toBe("untrusted");
    expect(d.mutatingAllowed).toBe(false);
  });

  it("reports sandbox-unavailable when an untrusted folder requires a sandbox", () => {
    const d = decideFolderTrust({ trusted: false, sandbox: "none", requireSandbox: true });
    expect(d.state).toBe("sandbox-unavailable");
    expect(d.mutatingAllowed).toBe(false);
  });

  it("a trusted folder is not downgraded by requireSandbox", () => {
    const d = decideFolderTrust({ trusted: true, sandbox: "none", requireSandbox: true });
    expect(d.state).toBe("trusted");
    expect(d.mutatingAllowed).toBe(true);
  });
});

describe("detectSandbox", () => {
  it("reads the documented launcher signal", () => {
    expect(detectSandbox({ OMC_SANDBOX: "enforced" })).toBe("enforced");
    expect(detectSandbox({ OMC_SANDBOX: "nope" })).toBe("none");
    expect(detectSandbox({})).toBe("none");
  });
});

describe("trust store", () => {
  it("returns an empty store when the file is missing", () => {
    const store = loadTrustStore(path.join(tmpDir, "absent.json"));
    expect(store.trusted).toEqual([]);
  });

  it("fails closed to empty on invalid JSON", () => {
    fs.writeFileSync(storePath(), "{ not json");
    expect(loadTrustStore(storePath()).trusted).toEqual([]);
  });

  it("fails closed to empty on a wrong schema/version", () => {
    fs.writeFileSync(storePath(), JSON.stringify({ schema: "other", version: 9, trusted: ["x"] }));
    expect(loadTrustStore(storePath()).trusted).toEqual([]);
  });

  it("rejects a non-string trusted entry", () => {
    fs.writeFileSync(
      storePath(),
      JSON.stringify({ schema: FOLDER_TRUST_SCHEMA, version: FOLDER_TRUST_VERSION, trusted: [1] }),
    );
    expect(loadTrustStore(storePath()).trusted).toEqual([]);
  });

  it("loads a valid store", () => {
    fs.writeFileSync(
      storePath(),
      JSON.stringify({ schema: FOLDER_TRUST_SCHEMA, version: FOLDER_TRUST_VERSION, trusted: ["a", "b"] }),
    );
    const store = loadTrustStore(storePath());
    expect(store.trusted).toEqual(["a", "b"]);
    expect(isTrusted(store, "a")).toBe(true);
    expect(isTrusted(store, "c")).toBe(false);
  });

  it("adds a key once, preserving order, and round-trips through disk", () => {
    let store = emptyTrustStore();
    store = addTrusted(store, "first");
    store = addTrusted(store, "second");
    store = addTrusted(store, "first"); // duplicate is a no-op
    expect(store.trusted).toEqual(["first", "second"]);
    saveTrustStore(storePath(), store);
    expect(loadTrustStore(storePath()).trusted).toEqual(["first", "second"]);
  });
});

describe("workspaceTrustKey", () => {
  it("collapses a symlink alias of a directory to one key", () => {
    const real = path.join(tmpDir, "real");
    fs.mkdirSync(real);
    const alias = path.join(tmpDir, "alias");
    fs.symlinkSync(real, alias);
    expect(workspaceTrustKey(alias)).toBe(workspaceTrustKey(real));
  });
});

describe("resolveFolderTrust", () => {
  it("trusts via store membership", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(ws);
    const key = workspaceTrustKey(ws);
    saveTrustStore(storePath(), addTrusted(emptyTrustStore(), key));
    const r = resolveFolderTrust({ workspacePath: ws, storePath: storePath(), env: {} });
    expect(r.decision.state).toBe("trusted");
    expect(r.decision.mutatingAllowed).toBe(true);
  });

  it("trusts for this run only without persisting", () => {
    const ws = path.join(tmpDir, "ws2");
    fs.mkdirSync(ws);
    const r = resolveFolderTrust({
      workspacePath: ws,
      storePath: storePath(),
      env: {},
      trustThisRun: true,
    });
    expect(r.decision.state).toBe("trusted");
    // Not persisted to disk.
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("fails closed for an unknown workspace", () => {
    const ws = path.join(tmpDir, "ws3");
    fs.mkdirSync(ws);
    const r = resolveFolderTrust({ workspacePath: ws, storePath: storePath(), env: {} });
    expect(r.decision.state).toBe("untrusted");
    expect(r.decision.mutatingAllowed).toBe(false);
  });

  it("honors an enforced sandbox from the environment", () => {
    const ws = path.join(tmpDir, "ws4");
    fs.mkdirSync(ws);
    const r = resolveFolderTrust({
      workspacePath: ws,
      storePath: storePath(),
      env: { OMC_SANDBOX: "enforced" },
    });
    expect(r.decision.state).toBe("sandbox-enforced");
    expect(r.decision.mutatingAllowed).toBe(true);
  });

  it("reports sandbox-unavailable when OMC_REQUIRE_SANDBOX is set", () => {
    const ws = path.join(tmpDir, "ws5");
    fs.mkdirSync(ws);
    const r = resolveFolderTrust({
      workspacePath: ws,
      storePath: storePath(),
      env: { OMC_REQUIRE_SANDBOX: "1" },
    });
    expect(r.decision.state).toBe("sandbox-unavailable");
    expect(r.decision.mutatingAllowed).toBe(false);
  });
});

describe("formatFolderTrust", () => {
  it("renders the state and redacts the home path", () => {
    const home = os.homedir();
    const ws = path.join(home, "secret-project");
    const out = formatFolderTrust({
      workspacePath: ws,
      decision: { state: "untrusted", mutatingAllowed: false, reason: "not trusted" },
      sandbox: "none",
      enforcing: true,
    });
    expect(out).toContain("Trust state: untrusted");
    expect(out).toContain("DENIED (fail closed)");
    // The home directory prefix is collapsed to ~ (the project basename remains).
    expect(out).not.toContain(home);
    expect(out).toContain("~");
  });
});

describe("folderTrustDenialMessage", () => {
  it("is actionable and leaks no host paths or secrets", () => {
    const msg = folderTrustDenialMessage();
    expect(msg).toMatch(/fail closed/i);
    expect(msg).toContain("--trust");
    expect(msg).not.toMatch(/\/home|\/root|password|secret/i);
  });
});
