import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDER_CONTRACT_SCHEMA,
  PROVIDER_CONTRACT_VERSION,
  SUPPORTED_PROVIDER_CONTRACT_VERSIONS,
  parseProviderContract,
  selectProviderEntry,
  resolveProviderConfig,
  buildProviderContractReport,
  collectProviderContract,
  formatProviderContract,
} from "../../src/provider-contract.js";
import { resolveModelConfig } from "../../src/settings.js";
import type { ProviderEntry } from "../../src/provider-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-provider-contract-"));
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

const ENTRY: ProviderEntry = {
  id: "alt",
  baseUrl: "https://alt.example/v1",
  model: "alt-model",
  apiKeyEnv: "ALT_KEY",
};

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseProviderContract: version negotiation", () => {
  it("accepts a supported contract version with one entry", () => {
    const contract = parseProviderContract({ contractVersion: 1, entries: [ENTRY] });
    expect(contract.contractVersion).toBe(1);
    expect(contract.entries).toHaveLength(1);
    expect(contract.entries[0].id).toBe("alt");
  });

  it("fails closed when contractVersion is missing", () => {
    expect(() => parseProviderContract({ entries: [ENTRY] })).toThrow(/contractVersion is required/);
  });

  it("rejects a non-integer contractVersion", () => {
    expect(() => parseProviderContract({ contractVersion: "1", entries: [ENTRY] })).toThrow(
      /contractVersion must be an integer/,
    );
  });

  it("fails closed on an unsupported contract version", () => {
    expect(() => parseProviderContract({ contractVersion: 99, entries: [ENTRY] })).toThrow(
      /provider contract version 99 is not supported/,
    );
    expect(SUPPORTED_PROVIDER_CONTRACT_VERSIONS).toContain(PROVIDER_CONTRACT_VERSION);
  });

  it("rejects a non-object providers section", () => {
    expect(() => parseProviderContract([1, 2, 3])).toThrow(/providers must be an object/);
  });

  it("requires a non-empty entries array", () => {
    expect(() => parseProviderContract({ contractVersion: 1, entries: [] })).toThrow(
      /entries must be a non-empty array/,
    );
  });
});

describe("parseProviderContract: trust boundary and validation", () => {
  it("rejects a raw credential field in an entry, naming the provider", () => {
    for (const field of ["apiKey", "token", "secret", "password", "key"]) {
      expect(() =>
        parseProviderContract({
          contractVersion: 1,
          entries: [{ id: "alt", model: "m", [field]: "leaked" }],
        }),
      ).toThrow(/raw credential field/);
    }
  });

  it("never echoes the raw credential value in the error", () => {
    let message = "";
    try {
      parseProviderContract({
        contractVersion: 1,
        entries: [{ id: "alt", model: "m", apiKey: "sk-super-secret" }],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("sk-super-secret");
  });

  it("rejects duplicate provider ids", () => {
    expect(() =>
      parseProviderContract({ contractVersion: 1, entries: [ENTRY, { ...ENTRY }] }),
    ).toThrow(/duplicate provider id "alt"/);
  });

  it("rejects an invalid baseUrl and an invalid apiKeyEnv", () => {
    expect(() =>
      parseProviderContract({
        contractVersion: 1,
        entries: [{ id: "a", baseUrl: "not-a-url", model: "m" }],
      }),
    ).toThrow(/baseUrl must be a valid URL/);
    expect(() =>
      parseProviderContract({
        contractVersion: 1,
        entries: [{ id: "a", model: "m", apiKeyEnv: "1bad name" }],
      }),
    ).toThrow(/apiKeyEnv must be a valid environment variable name/);
  });

  it("requires a declared default to reference a defined provider", () => {
    expect(() =>
      parseProviderContract({ contractVersion: 1, default: "ghost", entries: [ENTRY] }),
    ).toThrow(/default "ghost" is not a defined provider id/);
  });

  it("requires a non-empty model", () => {
    expect(() =>
      parseProviderContract({ contractVersion: 1, entries: [{ id: "a", model: "" }] }),
    ).toThrow(/model is required/);
  });
});

describe("selectProviderEntry: deterministic selection", () => {
  const a = { id: "a", model: "ma", apiKeyEnv: "KA" };
  const b = { id: "b", model: "mb", apiKeyEnv: "KB" };

  it("selects an explicit id over the default", () => {
    const contract = parseProviderContract({ contractVersion: 1, default: "a", entries: [a, b] });
    expect(selectProviderEntry(contract, { providerId: "b" }).id).toBe("b");
  });

  it("falls back to the declared default", () => {
    const contract = parseProviderContract({ contractVersion: 1, default: "b", entries: [a, b] });
    expect(selectProviderEntry(contract).id).toBe("b");
  });

  it("selects the sole entry when no id or default is given", () => {
    const contract = parseProviderContract({ contractVersion: 1, entries: [a] });
    expect(selectProviderEntry(contract).id).toBe("a");
  });

  it("fails closed on ambiguity (multiple entries, no id, no default)", () => {
    const contract = parseProviderContract({ contractVersion: 1, entries: [a, b] });
    expect(() => selectProviderEntry(contract)).toThrow(/multiple providers defined/);
  });

  it("rejects an unknown explicit id", () => {
    const contract = parseProviderContract({ contractVersion: 1, entries: [a] });
    expect(() => selectProviderEntry(contract, { providerId: "ghost" })).toThrow(
      /provider "ghost" is not defined/,
    );
  });
});

describe("resolveProviderConfig: end-to-end resolution", () => {
  it("resolves a Config from the entry's credential variable", () => {
    const config = resolveProviderConfig(ENTRY, { env: { ALT_KEY: "sk-xyz" } });
    expect(config).toEqual({ apiKey: "sk-xyz", baseUrl: "https://alt.example/v1", model: "alt-model" });
  });

  it("falls back to OPENAI_API_KEY when no apiKeyEnv is declared", () => {
    const config = resolveProviderConfig(
      { id: "o", model: "om" },
      { env: { OPENAI_API_KEY: "sk-openai" } },
    );
    expect(config).toEqual({ apiKey: "sk-openai", baseUrl: "https://api.openai.com/v1", model: "om" });
  });

  it("fails with an actionable error when the credential is not set", () => {
    expect(() => resolveProviderConfig(ENTRY, { env: {} })).toThrow(/ALT_KEY/);
  });
});

describe("buildProviderContractReport: redaction", () => {
  it("redacts the endpoint host and never leaks secrets or home paths", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      const report = buildProviderContractReport({
        contractVersion: 1,
        entry: {
          id: "alt",
          baseUrl: "https://user:s3cret@host.example/secret/path?token=abc",
          model: "alt-model",
          models: ["m1", "m2"],
          apiKeyEnv: "ALT_KEY",
          capabilities: { vision: true, streaming: true },
        },
        baseUrl: "https://user:s3cret@host.example/secret/path?token=abc",
        endpointSource: "settings",
        credentialVariable: "ALT_KEY",
        credentialFromSettings: true,
        credentialAvailable: true,
        settingsPath,
        settingsFound: true,
      });
      expect(report.schema).toBe(PROVIDER_CONTRACT_SCHEMA);
      expect(report.endpoint).toBe("host.example");
      expect(report.modelCatalog).toEqual(["m1", "m2"]);
      expect(report.capabilities).toEqual({ vision: true, streaming: true });
      expect(report.settings).toContain("~");
      const json = JSON.stringify(report);
      expect(json).not.toContain("s3cret");
      expect(json).not.toContain("secret/path");
      expect(json).not.toContain("token=abc");
      expect(json).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("collectProviderContract: real settings file", () => {
  it("resolves a declared provider end to end (redacted)", () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        default: "alt",
        entries: [
          { id: "alt", baseUrl: "https://alt.example/v1", model: "alt-model", apiKeyEnv: "ALT_KEY" },
        ],
      },
    });
    const report = collectProviderContract({ settingsPath: settings, env: { ALT_KEY: "sk-xyz" } });
    expect(report.providerId).toBe("alt");
    expect(report.endpoint).toBe("alt.example");
    expect(report.credentialAvailable).toBe(true);
    expect(report.credentialVariable).toBe("ALT_KEY");
  });

  it("reports credentialAvailable=false without failing when the credential is unset", () => {
    const settings = writeSettings({
      providers: { contractVersion: 1, entries: [{ id: "alt", model: "m", apiKeyEnv: "ALT_KEY" }] },
    });
    const report = collectProviderContract({ settingsPath: settings, env: {} });
    expect(report.credentialAvailable).toBe(false);
  });

  it("throws when the settings file has no providers section", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    expect(() => collectProviderContract({ settingsPath: settings, env: {} })).toThrow(
      /no settings.providers section/,
    );
  });

  it("throws when the settings file is missing", () => {
    expect(() => collectProviderContract({ settingsPath: missingPath(), env: {} })).toThrow(
      /settings file not found/,
    );
  });

  it("coexists with the model section (backward compatibility)", () => {
    const settings = writeSettings({
      model: { baseUrl: "https://model.example/v1", name: "model-name", apiKeyEnv: "MODEL_KEY" },
      providers: {
        contractVersion: 1,
        entries: [{ id: "alt", baseUrl: "https://alt.example/v1", model: "alt-model", apiKeyEnv: "ALT_KEY" }],
      },
    });
    // The existing model surface still resolves unchanged.
    const model = resolveModelConfig({ settingsPath: settings, env: { MODEL_KEY: "mk" } });
    expect(model.config.model).toBe("model-name");
    // The provider surface resolves independently.
    const provider = collectProviderContract({ settingsPath: settings, env: { ALT_KEY: "ak" } });
    expect(provider.providerId).toBe("alt");
  });
});

describe("formatProviderContract", () => {
  it("shows the contract, provider, and credential variable but not secrets", () => {
    const settings = writeSettings({
      providers: {
        contractVersion: 1,
        entries: [{ id: "alt", baseUrl: "https://alt.example/v1", model: "alt-model", apiKeyEnv: "ALT_KEY" }],
      },
    });
    const report = collectProviderContract({ settingsPath: settings, env: {} });
    const out = formatProviderContract(report);
    expect(out).toContain("alt");
    expect(out).toContain("alt-model");
    expect(out).toContain("ALT_KEY (not set)");
    expect(out).toContain(PROVIDER_CONTRACT_SCHEMA);
  });
});
