import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkspaceEnv } from "../../src/workspace-env.js";
import {
  addTrusted,
  emptyTrustStore,
  saveTrustStore,
  workspaceTrustKey,
} from "../../src/folder-trust.js";

let root: string;
let workspace: string;
let storePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-wsenv-"));
  workspace = path.join(root, "project");
  fs.mkdirSync(workspace);
  storePath = path.join(root, "trust.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeEnv(content: string): string {
  const p = path.join(workspace, ".env");
  fs.writeFileSync(p, content);
  return p;
}

function trustWorkspace(): void {
  saveTrustStore(storePath, addTrusted(emptyTrustStore(), workspaceTrustKey(workspace)));
}

describe("loadWorkspaceEnv: trust gating", () => {
  it("parses the .env of a workspace trusted via the store", () => {
    trustWorkspace();
    writeEnv(
      [
        "# a comment line",
        "OPENAI_MODEL=ws-model",
        'OPENAI_BASE_URL="https://ws.example/v1"',
        "OPENAI_API_KEY=sk-ws-secret",
        "OPENAI_MODEL=ws-model-final",
        "",
        "EMPTY_VAR=",
      ].join("\n"),
    );
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(load.loaded).toBe(true);
    expect(load.envPath).toBe(path.join(workspace, ".env"));
    expect(load.values).toEqual({
      OPENAI_MODEL: "ws-model-final",
      OPENAI_BASE_URL: "https://ws.example/v1",
      OPENAI_API_KEY: "sk-ws-secret",
      EMPTY_VAR: "",
    });
  });

  it("does not read the .env of an untrusted workspace", () => {
    writeEnv("OPENAI_API_KEY=sk-untrusted");
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(load.loaded).toBe(false);
    expect(load.values).toEqual({});
  });

  it("does not treat sandbox enforcement alone as trust", () => {
    // The loader never consults the sandbox signal: gating is the trust store
    // or --trust for this run. A store without the workspace key denies.
    saveTrustStore(storePath, emptyTrustStore());
    writeEnv("OPENAI_API_KEY=sk-sandbox-only");
    const load = loadWorkspaceEnv({
      workspacePath: workspace,
      storePath,
    });
    expect(load.loaded).toBe(false);
    expect(load.values).toEqual({});
  });

  it("trustThisRun loads without store membership", () => {
    writeEnv("OPENAI_MODEL=run-model");
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath, trustThisRun: true });
    expect(load.loaded).toBe(true);
    expect(load.values).toEqual({ OPENAI_MODEL: "run-model" });
  });

  it("a malformed trust store fails closed to untrusted", () => {
    fs.writeFileSync(storePath, "{ not valid json");
    writeEnv("OPENAI_MODEL=should-not-load");
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(load.loaded).toBe(false);
    expect(load.values).toEqual({});
  });
});

describe("loadWorkspaceEnv: silent no-ops and safety", () => {
  it("a missing .env in a trusted workspace is a silent no-op", () => {
    trustWorkspace();
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(load.loaded).toBe(false);
    expect(load.values).toEqual({});
    expect(load.envPath).toBe(path.join(workspace, ".env"));
  });

  it("malformed .env lines are skipped without throwing", () => {
    trustWorkspace();
    writeEnv("garbage line without equals\n=novalue\nOPENAI_MODEL=ok\n");
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(load.loaded).toBe(true);
    expect(load.values).toEqual({ OPENAI_MODEL: "ok" });
  });

  it("never mutates process.env", () => {
    trustWorkspace();
    writeEnv("OMC_WSENV_TEST_MARKER=leaked-value\n");
    const before = { ...process.env };
    loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(process.env).toEqual(before);
    expect(process.env.OMC_WSENV_TEST_MARKER).toBeUndefined();
  });

  it("returns a frozen empty-values object for no-ops", () => {
    const load = loadWorkspaceEnv({ workspacePath: workspace, storePath });
    expect(() => {
      (load.values as Record<string, string>)["INJECTED"] = "x";
    }).toThrow();
  });
});
