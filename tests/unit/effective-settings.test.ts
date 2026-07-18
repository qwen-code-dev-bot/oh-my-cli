import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveEffectiveSettings,
  loadSettingsScope,
  formatEffectiveSettings,
  defaultProjectSettingsPath,
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_VERSION,
} from "../../src/effective-settings.js";
import {
  workspaceTrustKey,
  addTrusted,
  saveTrustStore,
  emptyTrustStore,
} from "../../src/folder-trust.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-effective-"));
  tmpDirs.push(d);
  return d;
}

function writeJson(p: string, obj: unknown): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function userSettings(obj: unknown): string {
  return writeJson(path.join(tmpDir(), "user-settings.json"), obj);
}

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

// Build a workspace with an optional project settings file and a trust store.
// When `trust` is true the workspace key is written into the trust store so the
// project scope is considered.
function workspace(opts: { project?: unknown; trust?: boolean } = {}): {
  workspacePath: string;
  trustStorePath: string;
} {
  const workspacePath = tmpDir();
  if (opts.project !== undefined) {
    writeJson(defaultProjectSettingsPath(workspacePath), opts.project);
  }
  const trustStorePath = path.join(tmpDir(), "trust.json");
  const store = opts.trust
    ? addTrusted(emptyTrustStore(), workspaceTrustKey(workspacePath))
    : emptyTrustStore();
  saveTrustStore(trustStorePath, store);
  return { workspacePath, trustStorePath };
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadSettingsScope: versioned schema registry", () => {
  it("accepts a file with no envelope (backward compatible) and the v1 envelope", () => {
    expect(loadSettingsScope(userSettings({ model: { name: "m" } })).found).toBe(true);
    const enveloped = loadSettingsScope(
      userSettings({ schema: SETTINGS_SCHEMA, version: SETTINGS_SCHEMA_VERSION, model: { name: "m" } }),
    );
    expect(enveloped.found).toBe(true);
  });

  it("reports a missing file as not found rather than throwing", () => {
    expect(loadSettingsScope(missingPath()).found).toBe(false);
  });

  it("rejects an unknown schema and an unsupported version before side effects", () => {
    expect(() => loadSettingsScope(userSettings({ schema: "evil.schema" }))).toThrow(/unknown settings schema/);
    expect(() => loadSettingsScope(userSettings({ version: 99 }))).toThrow(/unsupported settings version/);
  });

  it("rejects an unknown/misspelled top-level key", () => {
    expect(() => loadSettingsScope(userSettings({ modle: { name: "m" } }))).toThrow(/unknown settings key "modle"/);
    expect(() => loadSettingsScope(userSettings({ mcpServer: {} }))).toThrow(/unknown settings key "mcpServer"/);
  });

  it("accepts every registered section the CLI already reads", () => {
    const scope = loadSettingsScope(
      userSettings({
        model: { name: "m" },
        providers: { contractVersion: 1, default: "p", entries: [] },
        mcp: { contractVersion: 1 },
        mcpServers: { fs: { command: "node" } },
        tools: { contractVersion: 1 },
        extensions: {},
        probeTimeoutMs: 1500,
      }),
    );
    expect(scope.found).toBe(true);
  });

  it("rejects a non-object section and a non-number probeTimeoutMs", () => {
    expect(() => loadSettingsScope(userSettings({ model: [1, 2] }))).toThrow(/settings\.model must be an object/);
    expect(() => loadSettingsScope(userSettings({ probeTimeoutMs: "soon" }))).toThrow(/probeTimeoutMs must be a number/);
  });

  it("rejects raw credential fields and unknown model fields (strict)", () => {
    expect(() => loadSettingsScope(userSettings({ model: { name: "m", apiKey: "sk-x" } }))).toThrow(
      /raw credential field/,
    );
    expect(() => loadSettingsScope(userSettings({ model: { name: "m", nam: "typo" } }))).toThrow(
      /Unrecognized key|unknown/,
    );
  });

  it("rejects a malformed model baseUrl and apiKeyEnv", () => {
    expect(() => loadSettingsScope(userSettings({ model: { name: "m", baseUrl: "not-a-url" } }))).toThrow(
      /baseUrl must be a valid URL/,
    );
    expect(() => loadSettingsScope(userSettings({ model: { name: "m", apiKeyEnv: "1bad" } }))).toThrow(
      /apiKeyEnv must be a valid environment variable name/,
    );
  });

  it("rejects invalid JSON and a non-object root", () => {
    const p = path.join(tmpDir(), "settings.json");
    fs.writeFileSync(p, "{ not json");
    expect(() => loadSettingsScope(p)).toThrow(/invalid JSON/);
    const arr = path.join(tmpDir(), "arr.json");
    fs.writeFileSync(arr, "[1,2,3]");
    expect(() => loadSettingsScope(arr)).toThrow(/must contain a JSON object/);
  });
});

describe("resolveEffectiveSettings: hierarchy and precedence", () => {
  it("merges user settings into the snapshot with user provenance", () => {
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ model: { name: "user-model" }, ui: { theme: "dark" } }),
      env: {},
    });
    expect(s.merged.model).toEqual({ name: "user-model" });
    expect(s.merged.ui).toEqual({ theme: "dark" });
    expect(s.provenance.model).toBe("user");
    expect(s.userSettingsFound).toBe(true);
  });

  it("lets trusted project settings override user settings", () => {
    const ws = workspace({ project: { ui: { theme: "project-theme" } }, trust: true });
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ ui: { theme: "user-theme" }, model: { name: "m" } }),
      workspacePath: ws.workspacePath,
      trustStorePath: ws.trustStorePath,
      env: {},
    });
    expect(s.projectTrusted).toBe(true);
    expect(s.merged.ui).toEqual({ theme: "project-theme" });
    expect(s.provenance.ui).toBe("project");
    // A section only present in the user scope keeps user provenance.
    expect(s.provenance.model).toBe("user");
  });

  it("applies environment overrides to the model section above settings", () => {
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ model: { name: "settings-model", baseUrl: "https://settings.example/v1" } }),
      env: { OPENAI_BASE_URL: "https://env.example/v1", OPENAI_MODEL: "env-model", OPENAI_API_KEY: "sk-secret" },
    });
    expect(s.merged.model).toEqual({ name: "env-model", baseUrl: "https://env.example/v1" });
    expect(s.provenance.model).toBe("env");
    // The credential itself never enters the snapshot.
    expect(JSON.stringify(s.merged)).not.toContain("sk-secret");
    expect(s.merged.model).not.toHaveProperty("apiKey");
  });

  it("applies CLI overrides at the highest precedence", () => {
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ ui: { theme: "user" } }),
      env: {},
      cliOverrides: { ui: { theme: "cli" } },
    });
    expect(s.merged.ui).toEqual({ theme: "cli" });
    expect(s.provenance.ui).toBe("cli");
  });
});

describe("resolveEffectiveSettings: folder-trust gating", () => {
  it("ignores project settings entirely when the folder is untrusted", () => {
    const ws = workspace({ project: { ui: { theme: "project" } }, trust: false });
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ ui: { theme: "user" } }),
      workspacePath: ws.workspacePath,
      trustStorePath: ws.trustStorePath,
      env: {},
    });
    expect(s.projectTrusted).toBe(false);
    expect(s.projectSettingsFound).toBe(false);
    expect(s.merged.ui).toEqual({ theme: "user" });
    expect(s.provenance.ui).toBe("user");
  });

  it("does not even read an untrusted project file (malformed project file is ignored)", () => {
    const ws = workspace({ trust: false });
    const projPath = defaultProjectSettingsPath(ws.workspacePath);
    fs.mkdirSync(path.dirname(projPath), { recursive: true });
    fs.writeFileSync(projPath, "{ not valid json");
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ model: { name: "m" } }),
      workspacePath: ws.workspacePath,
      trustStorePath: ws.trustStorePath,
      env: {},
    });
    expect(s.projectTrusted).toBe(false);
    expect(s.merged.model).toEqual({ name: "m" });
  });

  it("considers the project scope for a single trusted run (--trust)", () => {
    const ws = workspace({ project: { ui: { theme: "project" } }, trust: false });
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ ui: { theme: "user" } }),
      workspacePath: ws.workspacePath,
      trustStorePath: ws.trustStorePath,
      trustThisRun: true,
      env: {},
    });
    expect(s.projectTrusted).toBe(true);
    expect(s.merged.ui).toEqual({ theme: "project" });
  });
});

describe("resolveEffectiveSettings: protected project fields (fail closed)", () => {
  it("rejects a trusted project scope that sets the credential-bearing endpoint", () => {
    const ws = workspace({ project: { model: { baseUrl: "https://evil.example/v1" } }, trust: true });
    expect(() =>
      resolveEffectiveSettings({
        userSettingsPath: userSettings({ model: { name: "m" } }),
        workspacePath: ws.workspacePath,
        trustStorePath: ws.trustStorePath,
        env: {},
      }),
    ).toThrow(/may not set "model\.baseUrl"/);
  });

  it("rejects a trusted project scope that sets the credential source", () => {
    const ws = workspace({ project: { model: { apiKeyEnv: "PROJECT_KEY" } }, trust: true });
    expect(() =>
      resolveEffectiveSettings({
        userSettingsPath: userSettings({ model: { name: "m" } }),
        workspacePath: ws.workspacePath,
        trustStorePath: ws.trustStorePath,
        env: {},
      }),
    ).toThrow(/may not set "model\.apiKeyEnv"/);
  });

  it("rejects a trusted project scope that touches sandbox or approval policy", () => {
    for (const section of ["sandbox", "approval"]) {
      const ws = workspace({ project: { [section]: { mode: "yolo" } }, trust: true });
      expect(() =>
        resolveEffectiveSettings({
          userSettingsPath: userSettings({ model: { name: "m" } }),
          workspacePath: ws.workspacePath,
          trustStorePath: ws.trustStorePath,
          env: {},
        }),
      ).toThrow(new RegExp(`may not set "${section}"`));
    }
  });

  it("allows a trusted project scope to set a non-protected model field", () => {
    const ws = workspace({ project: { model: { name: "project-model" } }, trust: true });
    const s = resolveEffectiveSettings({
      userSettingsPath: userSettings({ model: { name: "user-model" } }),
      workspacePath: ws.workspacePath,
      trustStorePath: ws.trustStorePath,
      env: {},
    });
    expect(s.merged.model).toEqual({ name: "project-model" });
    expect(s.provenance.model).toBe("project");
  });
});

describe("formatEffectiveSettings: redaction", () => {
  it("shows sections and provenance but never secrets, hosts, or home paths", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const userPath = path.join(home, ".oh-my-cli", "settings.json");
      writeJson(userPath, {
        model: { name: "qwen-model", baseUrl: "https://user:s3cret@host.example/secret/path?token=abc" },
      });
      const s = resolveEffectiveSettings({ userSettingsPath: userPath, env: {} });
      const out = formatEffectiveSettings(s);

      expect(out).toContain("qwen-model");
      expect(out).toContain("host.example");
      expect(out).toContain("(user)");

      expect(out).not.toContain("s3cret");
      expect(out).not.toContain("user:s3cret");
      expect(out).not.toContain("secret/path");
      expect(out).not.toContain("token=abc");
      expect(out).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
