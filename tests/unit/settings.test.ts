import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveModelConfig,
  resolveSettingsPath,
  defaultUserSettingsPath,
  describeResolvedConfig,
} from "../../src/settings.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-settings-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("settings path selection", () => {
  it("defaults to the user-owned file under the home directory", () => {
    expect(defaultUserSettingsPath()).toBe(path.join(os.homedir(), ".oh-my-cli", "settings.json"));
  });

  it("uses an explicit path when supplied and the default otherwise", () => {
    expect(resolveSettingsPath("/srv/custom.json")).toBe("/srv/custom.json");
    expect(resolveSettingsPath()).toBe(defaultUserSettingsPath());
    expect(resolveSettingsPath("   ")).toBe(defaultUserSettingsPath());
  });
});

describe("resolveModelConfig: settings-driven resolution", () => {
  it("resolves model, endpoint, and named credential from a settings file", () => {
    const settings = writeSettings({
      model: {
        baseUrl: "https://dashscope.example/compatible-mode/v1",
        name: "qwen-model",
        apiKeyEnv: "DASHSCOPE_API_KEY",
      },
    });
    const resolved = resolveModelConfig({ settingsPath: settings, env: { DASHSCOPE_API_KEY: "sk-xyz" } });
    expect(resolved.config).toEqual({
      apiKey: "sk-xyz",
      baseUrl: "https://dashscope.example/compatible-mode/v1",
      model: "qwen-model",
    });
    expect(resolved.baseUrlSource).toBe("settings");
    expect(resolved.modelSource).toBe("settings");
    expect(resolved.credentialVariable).toBe("DASHSCOPE_API_KEY");
    expect(resolved.credentialFromSettings).toBe(true);
    expect(resolved.settingsFound).toBe(true);
  });

  it("falls back to the built-in default base URL when none is supplied", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const resolved = resolveModelConfig({ settingsPath: settings, env: { K: "v" } });
    expect(resolved.config.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.baseUrlSource).toBe("default");
  });
});

describe("resolveModelConfig: environment precedence", () => {
  it("OPENAI_* override the corresponding settings values for every field", () => {
    const settings = writeSettings({
      model: { baseUrl: "https://settings.example/v1", name: "settings-model", apiKeyEnv: "SETTINGS_KEY" },
    });
    const resolved = resolveModelConfig({
      settingsPath: settings,
      env: {
        OPENAI_API_KEY: "env-key",
        OPENAI_BASE_URL: "https://env.example/v1",
        OPENAI_MODEL: "env-model",
        SETTINGS_KEY: "settings-key",
      },
    });
    expect(resolved.config).toEqual({
      apiKey: "env-key",
      baseUrl: "https://env.example/v1",
      model: "env-model",
    });
    expect(resolved.baseUrlSource).toBe("env");
    expect(resolved.modelSource).toBe("env");
    expect(resolved.credentialVariable).toBe("OPENAI_API_KEY");
    expect(resolved.credentialFromSettings).toBe(false);
  });

  it("OPENAI_API_KEY wins over the settings-named credential variable", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "NAMED_KEY" } });
    const resolved = resolveModelConfig({
      settingsPath: settings,
      env: { OPENAI_API_KEY: "primary", NAMED_KEY: "secondary" },
    });
    expect(resolved.config.apiKey).toBe("primary");
    expect(resolved.credentialVariable).toBe("OPENAI_API_KEY");
  });
});

describe("resolveModelConfig: backward compatibility", () => {
  it("resolves env-only configuration when no settings file exists", () => {
    const resolved = resolveModelConfig({
      settingsPath: missingPath(),
      env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
    });
    expect(resolved.config).toEqual({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "m" });
    expect(resolved.settingsFound).toBe(false);
  });

  it("ignores an integration-only settings file (health fields untouched)", () => {
    const settings = writeSettings({ mcpServers: { fs: { command: "node" } }, extensions: {} });
    const resolved = resolveModelConfig({
      settingsPath: settings,
      env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
    });
    expect(resolved.config.model).toBe("m");
    expect(resolved.settingsFound).toBe(true);
    expect(resolved.modelSource).toBe("env");
  });
});

describe("resolveModelConfig: validation and security", () => {
  it("rejects a raw apiKey field rather than ignoring it", () => {
    const settings = writeSettings({
      model: { baseUrl: "https://x.example/v1", name: "m", apiKey: "sk-leaked" },
    });
    expect(() => resolveModelConfig({ settingsPath: settings, env: {} })).toThrow(/raw credential field/);
  });

  it("rejects other secret-shaped fields (token, secret, password, key)", () => {
    for (const field of ["token", "secret", "password", "key"]) {
      const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K", [field]: "v" } });
      expect(() => resolveModelConfig({ settingsPath: settings, env: { K: "v" } })).toThrow(
        /raw credential field/,
      );
    }
  });

  it("fails when the named credential variable is not set", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "MISSING_KEY" } });
    expect(() => resolveModelConfig({ settingsPath: settings, env: {} })).toThrow(/MISSING_KEY/);
  });

  it("fails with an actionable error when the settings model section omits name", () => {
    const settings = writeSettings({ model: { baseUrl: "https://x.example/v1", apiKeyEnv: "K" } });
    expect(() => resolveModelConfig({ settingsPath: settings, env: { K: "v" } })).toThrow(
      /settings\.model\.name is required/,
    );
  });

  it("fails when no model is configured in settings or the environment", () => {
    const settings = writeSettings({ mcpServers: {} });
    expect(() => resolveModelConfig({ settingsPath: settings, env: { OPENAI_API_KEY: "k" } })).toThrow(
      /no model configured/,
    );
  });

  it("fails when neither env nor settings provide a credential source", () => {
    const settings = writeSettings({ model: { name: "m" } });
    expect(() => resolveModelConfig({ settingsPath: settings, env: {} })).toThrow(/no credential available/);
  });

  it("fails on invalid JSON before any provider request", () => {
    const p = path.join(tmpDir(), "settings.json");
    fs.writeFileSync(p, "{ not valid json");
    expect(() => resolveModelConfig({ settingsPath: p, env: {} })).toThrow(/invalid JSON/);
  });

  it("fails on a non-object settings root", () => {
    const p = path.join(tmpDir(), "settings.json");
    fs.writeFileSync(p, "[1,2,3]");
    expect(() => resolveModelConfig({ settingsPath: p, env: {} })).toThrow(/must contain a JSON object/);
  });

  it("fails on a malformed settings base URL", () => {
    const settings = writeSettings({ model: { baseUrl: "not-a-url", name: "m", apiKeyEnv: "K" } });
    expect(() => resolveModelConfig({ settingsPath: settings, env: { K: "v" } })).toThrow(
      /baseUrl must be a valid URL/,
    );
  });

  it("fails on an invalid apiKeyEnv identifier", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "1bad name" } });
    expect(() => resolveModelConfig({ settingsPath: settings, env: {} })).toThrow(
      /apiKeyEnv must be a valid environment variable name/,
    );
  });
});

describe("describeResolvedConfig: redaction", () => {
  it("shows model, host, settings source, and credential var name but never secrets", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsDir = path.join(home, ".oh-my-cli");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, "settings.json"),
        JSON.stringify({
          model: {
            baseUrl: "https://user:s3cret@host.example/secret/path?token=abc",
            name: "qwen-model",
            apiKeyEnv: "DASHSCOPE_API_KEY",
          },
        }),
      );
      const resolved = resolveModelConfig({ env: { DASHSCOPE_API_KEY: "sk-super-secret-value" } });
      const out = describeResolvedConfig(resolved);

      // Non-secret context is shown.
      expect(out).toContain("qwen-model");
      expect(out).toContain("DASHSCOPE_API_KEY");
      expect(out).toContain("host.example");
      expect(out).toContain("~");

      // Secrets and sensitive URL parts are never shown.
      expect(out).not.toContain("sk-super-secret-value");
      expect(out).not.toContain("user:s3cret");
      expect(out).not.toContain("secret/path");
      expect(out).not.toContain("token=abc");
      expect(out).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
