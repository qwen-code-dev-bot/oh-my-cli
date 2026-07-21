import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseProfiles,
  selectProfile,
  collectProfileList,
  formatProfileList,
  resolveModelProfileConfig,
} from "../../src/model-profiles.js";
import { describeResolvedConfig } from "../../src/settings.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-profiles-"));
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

describe("parseProfiles: validation and security", () => {
  it("parses a valid profiles map", () => {
    const profiles = parseProfiles({
      qwen: { name: "qwen-model", baseUrl: "https://x.example/v1", apiKeyEnv: "K", description: "d" },
      openai: { name: "gpt" },
    });
    expect(profiles).toHaveLength(2);
    const qwen = profiles.find((p) => p.profile === "qwen")!;
    expect(qwen.name).toBe("qwen-model");
    expect(qwen.baseUrl).toBe("https://x.example/v1");
    expect(qwen.apiKeyEnv).toBe("K");
    expect(qwen.description).toBe("d");
  });

  it("accepts an empty profiles map", () => {
    expect(parseProfiles({})).toEqual([]);
  });

  it("rejects a non-object section", () => {
    expect(() => parseProfiles([1, 2])).toThrow(/profiles must be an object/);
    expect(() => parseProfiles("nope")).toThrow(/profiles must be an object/);
  });

  it("rejects a raw credential field in a profile", () => {
    for (const field of ["apiKey", "token", "secret", "password", "key"]) {
      expect(() => parseProfiles({ p: { name: "m", [field]: "v" } })).toThrow(/raw credential field/);
    }
  });

  it("rejects an invalid profile name", () => {
    expect(() => parseProfiles({ "bad name": { name: "m" } })).toThrow(/portable, shell-safe/);
    expect(() => parseProfiles({ "-lead": { name: "m" } })).toThrow(/portable, shell-safe/);
  });

  it("rejects a profile that is not an object", () => {
    expect(() => parseProfiles({ p: "m" })).toThrow(/profile "p" must be an object/);
  });

  it("rejects a profile missing the model name", () => {
    expect(() => parseProfiles({ p: { baseUrl: "https://x.example/v1" } })).toThrow(
      /profile\.name \(model name\) is required/,
    );
  });

  it("rejects a malformed baseUrl and apiKeyEnv", () => {
    expect(() => parseProfiles({ p: { name: "m", baseUrl: "not-a-url" } })).toThrow(
      /baseUrl must be a valid URL/,
    );
    expect(() => parseProfiles({ p: { name: "m", apiKeyEnv: "1bad" } })).toThrow(
      /apiKeyEnv must be a valid environment variable name/,
    );
  });

  it("rejects an unknown profile field (strict)", () => {
    expect(() => parseProfiles({ p: { name: "m", temperature: 0.5 } })).toThrow();
  });
});

describe("selectProfile", () => {
  const profiles = parseProfiles({
    a: { name: "m-a" },
    b: { name: "m-b", disabled: true },
  });

  it("selects a defined, enabled profile", () => {
    expect(selectProfile(profiles, "a").name).toBe("m-a");
  });

  it("fails closed on an unknown profile name and lists available profiles", () => {
    expect(() => selectProfile(profiles, "ghost")).toThrow(/profile "ghost" is not defined.*available: a, b/);
  });

  it("refuses a disabled profile", () => {
    expect(() => selectProfile(profiles, "b")).toThrow(/profile "b" is disabled/);
  });

  it("rejects an empty profile name", () => {
    expect(() => selectProfile(profiles, "   ")).toThrow(/must be a non-empty string/);
  });
});

describe("collectProfileList / formatProfileList", () => {
  it("lists profiles redacted, sorted, with default and disabled flags", () => {
    const settings = writeSettings({
      defaultProfile: "qwen",
      profiles: {
        qwen: { name: "qwen-model", baseUrl: "https://dashscope.example/v1", description: "primary" },
        local: { name: "llama", disabled: true },
      },
    });
    const report = collectProfileList({ settingsPath: settings });
    expect(report.defaultProfile).toBe("qwen");
    expect(report.profiles.map((p) => p.profile)).toEqual(["local", "qwen"]);
    const qwen = report.profiles.find((p) => p.profile === "qwen")!;
    expect(qwen.isDefault).toBe(true);
    expect(qwen.model).toBe("qwen-model");
    expect(qwen.host).toBeDefined();
    const local = report.profiles.find((p) => p.profile === "local")!;
    expect(local.disabled).toBe(true);

    const out = formatProfileList(report);
    expect(out).toContain("Model Profiles");
    expect(out).toContain("Default:   qwen");
    expect(out).toContain("qwen — qwen-model");
    expect(out).toContain("[default]");
    expect(out).toContain("[disabled]");
  });

  it("reports an empty list (no throw) when no profiles section exists", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectProfileList({ settingsPath: settings });
    expect(report.profiles).toEqual([]);
    expect(report.defaultProfile).toBeUndefined();
    expect(formatProfileList(report)).toContain("Profiles:  (none)");
  });

  it("never leaks the home path or endpoint host in the list output", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = path.join(home, ".oh-my-cli");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({
          profiles: {
            qwen: {
              name: "m",
              baseUrl: "https://user:s3cret@host.example/secret/path?token=abc",
              apiKeyEnv: "K",
            },
          },
        }),
      );
      const out = formatProfileList(collectProfileList({}));
      expect(out).toContain("host.example");
      expect(out).not.toContain("user:s3cret");
      expect(out).not.toContain("secret/path");
      expect(out).not.toContain("token=abc");
      expect(out).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("resolveModelProfileConfig: selection", () => {
  it("resolves an explicitly selected profile with its endpoint and credential", () => {
    const settings = writeSettings({
      profiles: {
        qwen: { name: "qwen-model", baseUrl: "https://dashscope.example/v1", apiKeyEnv: "DASHSCOPE_API_KEY" },
      },
    });
    const resolved = resolveModelProfileConfig({
      settingsPath: settings,
      env: { DASHSCOPE_API_KEY: "sk-xyz" },
      profile: "qwen",
    });
    expect(resolved.config).toEqual({
      apiKey: "sk-xyz",
      baseUrl: "https://dashscope.example/v1",
      model: "qwen-model",
    });
    expect(resolved.profile).toBe("qwen");
    expect(resolved.credentialVariable).toBe("DASHSCOPE_API_KEY");
  });

  it("uses settings.defaultProfile when no explicit profile is given", () => {
    const settings = writeSettings({
      defaultProfile: "qwen",
      profiles: { qwen: { name: "qwen-model", apiKeyEnv: "K" } },
    });
    const resolved = resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" } });
    expect(resolved.config.model).toBe("qwen-model");
    expect(resolved.profile).toBe("qwen");
  });

  it("an explicit --profile overrides settings.defaultProfile", () => {
    const settings = writeSettings({
      defaultProfile: "a",
      profiles: {
        a: { name: "m-a", apiKeyEnv: "K" },
        b: { name: "m-b", apiKeyEnv: "K" },
      },
    });
    const resolved = resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" }, profile: "b" });
    expect(resolved.config.model).toBe("m-b");
    expect(resolved.profile).toBe("b");
  });

  it("falls back to the legacy model section when no profile applies", () => {
    const settings = writeSettings({ model: { name: "legacy-model", apiKeyEnv: "K" } });
    const resolved = resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" } });
    expect(resolved.config.model).toBe("legacy-model");
    expect(resolved.profile).toBeUndefined();
  });

  it("falls back to env-only config when neither profiles nor a model section exist", () => {
    const resolved = resolveModelProfileConfig({
      settingsPath: missingPath(),
      env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
    });
    expect(resolved.config).toEqual({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "m" });
    expect(resolved.profile).toBeUndefined();
  });

  it("environment variables still override a selected profile", () => {
    const settings = writeSettings({
      profiles: { qwen: { name: "qwen-model", baseUrl: "https://settings.example/v1", apiKeyEnv: "K" } },
    });
    const resolved = resolveModelProfileConfig({
      settingsPath: settings,
      env: { OPENAI_MODEL: "env-model", OPENAI_BASE_URL: "https://env.example/v1", OPENAI_API_KEY: "env-key", K: "k" },
      profile: "qwen",
    });
    expect(resolved.config).toEqual({
      apiKey: "env-key",
      baseUrl: "https://env.example/v1",
      model: "env-model",
    });
    // The profile is still recorded as the selection that fed resolution.
    expect(resolved.profile).toBe("qwen");
  });
});

describe("resolveModelProfileConfig: fail closed", () => {
  it("fails when --profile is given but there is no profiles section", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    expect(() =>
      resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" }, profile: "qwen" }),
    ).toThrow(/--profile "qwen" was given but settings has no settings.profiles section/);
  });

  it("fails when defaultProfile is set but there is no profiles section", () => {
    const settings = writeSettings({ defaultProfile: "qwen", model: { name: "m", apiKeyEnv: "K" } });
    expect(() => resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" } })).toThrow(
      /defaultProfile is set but settings has no settings.profiles section/,
    );
  });

  it("fails on an unknown profile name", () => {
    const settings = writeSettings({ profiles: { a: { name: "m", apiKeyEnv: "K" } } });
    expect(() =>
      resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" }, profile: "ghost" }),
    ).toThrow(/profile "ghost" is not defined/);
  });

  it("fails on a disabled profile", () => {
    const settings = writeSettings({ profiles: { a: { name: "m", apiKeyEnv: "K", disabled: true } } });
    expect(() =>
      resolveModelProfileConfig({ settingsPath: settings, env: { K: "v" }, profile: "a" }),
    ).toThrow(/profile "a" is disabled/);
  });

  it("fails when the selected profile's credential variable is unset", () => {
    const settings = writeSettings({ profiles: { a: { name: "m", apiKeyEnv: "MISSING" } } });
    expect(() =>
      resolveModelProfileConfig({ settingsPath: settings, env: {}, profile: "a" }),
    ).toThrow(/MISSING/);
  });

  it("fails on a raw credential field in the selected profile", () => {
    const settings = writeSettings({ profiles: { a: { name: "m", apiKey: "sk-leaked" } } });
    expect(() =>
      resolveModelProfileConfig({ settingsPath: settings, env: {}, profile: "a" }),
    ).toThrow(/raw credential field/);
  });
});

describe("describeResolvedConfig: profile provenance", () => {
  it("shows the selected profile name (non-secret) but never the credential value", () => {
    const settings = writeSettings({
      profiles: { qwen: { name: "qwen-model", apiKeyEnv: "DASHSCOPE_API_KEY" } },
    });
    const resolved = resolveModelProfileConfig({
      settingsPath: settings,
      env: { DASHSCOPE_API_KEY: "sk-super-secret-value" },
      profile: "qwen",
    });
    const out = describeResolvedConfig(resolved);
    expect(out).toContain("Profile:    qwen");
    expect(out).toContain("qwen-model");
    expect(out).toContain("DASHSCOPE_API_KEY");
    expect(out).not.toContain("sk-super-secret-value");
  });
});
